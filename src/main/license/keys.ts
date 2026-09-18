/**
 * 公钥加载（双源 + kid 轮换 + 编译期硬编码兜底 + 多格式兼容）
 *
 * 查找顺序（先包外后内置，保证「上线替换公钥只改一个文件、不重新打包」）：
 *   1. <resources>/license/keys/<kid>.key      —— 多 kid 轮换位
 *   2. <resources>/license/public.key          —— 客户心智里的「那一个特殊文件」
 *   3. <asar>/dist/main/license/assets/keys/<kid>.key
 *   4. <asar>/dist/main/license/assets/public.key
 *   5. EMBEDDED_KEYS[kid]                      —— 编译期硬编码兜底
 *
 * ⚠️ 格式兼容（2026-09-17 实测，**必做**）：仓库里的 `src/public.key` 是 **32 字节裸 Ed25519 公钥**
 * （raw），而 `crypto.createPublicKey()` **不接受裸 32 字节**（直接喂会抛
 * `asn1 encoding routines::bad object header`），只吃 SPKI PEM / SPKI DER。
 * 因此必须实现三格式识别：PEM / raw32（补 SPKI 前缀）/ SPKI DER。
 * **不做这层兼容 = 上线后全量激活失败。**
 */

import {createPublicKey, type KeyObject} from 'crypto';
import fs from 'fs';
import path from 'path';
import {DEFAULT_KID} from '../../shared/license-constants';
import {resolveAsarAssetsDir, resolveExternalLicenseDir} from './config';
import {KEYS_DIR_NAME, PUBLIC_KEY_FILE_NAME} from './constants';
import {logLicenseEvent} from './errors';

/** Ed25519 的 SPKI DER 前缀（12 字节），裸 32 字节公钥补上它即可按 DER 载入 */
const SPKI_ED25519_PREFIX_HEX = '302a300506032b6570032100';

/**
 * 编译期硬编码兜底公钥（**这是公开的验签公钥，不是秘密**）。
 * 内容与 `src/public.key` 一致（raw32 hex），用于「包外与 asar 内的公钥文件都丢了」时仍能验签。
 * 上线替换真实公钥时**必须同步改这里**，否则兜底路径用的是旧公钥（旧公钥仍能验过旧 token，属预期）。
 */
const EMBEDDED_KEYS: Record<string, string> = {
    [DEFAULT_KID]: '73a23b353ddbf63e6fbb637507930c82eb8863410369adba1d638f9cf6f07437',
};

const keyCache = new Map<string, KeyObject>();

/** 去掉首尾空白字节：公钥文件常带尾随换行，不处理会让 32 字节 raw 变成 33 字节而识别失败 */
function trimBuffer(input: Buffer): Buffer {
    const isSpace = (b: number): boolean => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0xef || b === 0xbb || b === 0xbf;
    let start = 0;
    let end = input.length;
    while (start < end && isSpace(input[start])) start++;
    while (end > start && isSpace(input[end - 1])) end--;
    return input.subarray(start, end);
}

function createFromRaw32(raw: Buffer): KeyObject | null {
    try {
        const der = Buffer.concat([Buffer.from(SPKI_ED25519_PREFIX_HEX, 'hex'), raw]);
        return createPublicKey({ key: der, format: 'der', type: 'spki' });
    } catch (error) {
        logLicenseEvent('LIC_INTERNAL', { event: 'public_key_raw32_load_failed', reason: (error as Error).name });
        return null;
    }
}

/**
 * 从字节流识别并载入公钥（三格式）。失败一律返回 null 并记 `LIC_INTERNAL`，
 * 由调用方回落到下一个来源——**不抛异常**，因为公钥加载失败只应导致验签失败，不应中断启动。
 */
export function loadPublicKeyFromBytes(input: Buffer): KeyObject | null {
    const buf = trimBuffer(input);
    if (buf.length === 0) return null;

    const text = buf.toString('utf8').trim();
    if (text.startsWith('-----BEGIN')) {
        try {
            return createPublicKey(text);
        } catch (error) {
            logLicenseEvent('LIC_INTERNAL', { event: 'public_key_pem_load_failed', reason: (error as Error).name });
            return null;
        }
    }

    // 64 个十六进制字符 = 以文本形式保存的 32 字节裸公钥
    if (/^[0-9a-fA-F]{64}$/.test(text)) return createFromRaw32(Buffer.from(text, 'hex'));

    // 二进制裸公钥
    if (buf.length === 32) return createFromRaw32(buf);

    try {
        return createPublicKey({ key: buf, format: 'der', type: 'spki' });
    } catch (error) {
        logLicenseEvent('LIC_INTERNAL', {
            event: 'public_key_format_unknown',
            length: buf.length,
            reason: (error as Error).name,
        });
        return null;
    }
}

function readFirstExisting(files: string[]): Buffer | null {
    for (const f of files) {
        try {
            if (fs.existsSync(f)) return fs.readFileSync(f);
        } catch {
            // 单文件读取失败（权限/占用）继续尝试下一个来源
        }
    }
    return null;
}

function candidateKeyFiles(kid: string): string[] {
    const external = resolveExternalLicenseDir();
    const asar = resolveAsarAssetsDir();
    return [
        path.join(external, KEYS_DIR_NAME, `${kid}.key`),
        path.join(external, PUBLIC_KEY_FILE_NAME),
        path.join(asar, KEYS_DIR_NAME, `${kid}.key`),
        path.join(asar, PUBLIC_KEY_FILE_NAME),
    ];
}

/**
 * 取指定 kid 的公钥并缓存（`createPublicKey` 只在首次使用时调用一次）。
 * 找不到或格式不可识别时返回 null → 调用方判 `LIC_UNKNOWN_KID`。
 */
export function getPublicKey(kid: string): KeyObject | null {
    const key = kid && kid.trim() ? kid.trim() : DEFAULT_KID;
    const hit = keyCache.get(key);
    if (hit) return hit;

    const bytes = readFirstExisting(candidateKeyFiles(key));
    let publicKey: KeyObject | null = bytes ? loadPublicKeyFromBytes(bytes) : null;

    if (!publicKey) {
        const embedded = EMBEDDED_KEYS[key];
        if (embedded) publicKey = loadPublicKeyFromBytes(Buffer.from(embedded, 'hex'));
    }

    if (!publicKey) {
        logLicenseEvent('LIC_INTERNAL', { event: 'public_key_unavailable', kid: key });
        return null;
    }

    keyCache.set(key, publicKey);
    return publicKey;
}

/** 清缓存（运维替换包外公钥后需要重新加载时使用） */
export function clearKeyCache(): void {
    keyCache.clear();
}
