/**
 * 本地加密存储：试用账本 + 授权 token（main 进程）
 *
 * **边界声明（重要）**：客户端没有可信执行环境，理论上本地存储都能被逆向。
 * 本方案的目标是三条，而不是「绝对安全」：
 *   1. **明文不落盘**——磁盘上只有密文（safeStorage 或 AES-256-GCM）；
 *   2. **篡改会被发现**——GCM authTag 校验 + `trial_token` 自检串，改一个字节就被判废；
 *   3. **拷走也解不开**——AES 回退的密钥由「应用盐 + **本机机器码**」派生，拷到别的机器解不开。
 * 真正的**安全边界是服务端 Ed25519 签名**：本地改 vault 无法伪造一个能通过验签的 token。
 *
 * 因此所有失败路径都 **fail-closed**：解密失败 / 结构非法 / 自检不过 → 丢弃并重建，**绝不猜、绝不崩**。
 */

import {createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync} from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {safeStorage} from 'electron';
import {writeFileAtomic} from '../config/settings-store';
import {AI_TOOLS_DIR_NAME, VAULT_APP_SECRET, VAULT_FILE_NAME} from './constants';
import {logLicenseEvent} from './errors';
import {getMachineCode} from './machine-code';
import type {LicenseVault, TrialVault} from './types';

/** vault 内的明文结构（两份账本合一，一次加密） */
export interface VaultData {
    trial: TrialVault | null;
    license: LicenseVault | null;
}

/** 落盘结构 */
interface VaultFile {
    v: 1;
    scheme: 'safeStorage' | 'aes-gcm';
    /** base64 密文（aes-gcm 时为 iv(12) + authTag(16) + ciphertext） */
    data: string;
}

function vaultPath(): string {
    return path.join(os.homedir(), AI_TOOLS_DIR_NAME, VAULT_FILE_NAME);
}

function emptyVault(): VaultData {
    return {trial: null, license: null};
}

/** safeStorage 在 app ready 之前调用会抛异常，这里一律按「不可用」处理 */
function safeStorageAvailable(): boolean {
    try {
        return safeStorage.isEncryptionAvailable();
    } catch {
        return false;
    }
}

/** AES 回退密钥：绑定机器码 → 把文件拷到另一台机器解不开 */
async function aesKey(): Promise<Buffer> {
    const machineCode = await getMachineCode();
    return scryptSync(VAULT_APP_SECRET, machineCode, 32);
}

/**
 * `trial_token` 自检串：对账本的关键字段做 HMAC。
 * 即便将来出现「明文落盘」的降级路径，手动改 `first_run_at` / `trial_count` 也会立刻被发现。
 * 不绑定机器码：绑定不会提高安全性（加密已经做了），只会让「同一台机器重装系统」白白判废。
 */
function computeTrialToken(trial: TrialVault): string {
    const canonical = [
        trial.first_run_at,
        trial.trial_count,
        trial.last_run_at,
        trial.watermark,
        trial.mid_soft_at_activation ?? '',
        trial.hardware_grace_used,
        trial.hardware_grace_until ?? 0,
    ].join('|');
    return createHmac('sha256', VAULT_APP_SECRET).update(canonical).digest('hex');
}

function withTrialToken(trial: TrialVault): TrialVault {
    return {...trial, trial_token: computeTrialToken(trial)};
}

function trialTokenValid(trial: TrialVault): boolean {
    return typeof trial.trial_token === 'string' && trial.trial_token === computeTrialToken(trial);
}

async function encryptString(plain: string): Promise<{scheme: VaultFile['scheme']; data: string} | null> {
    if (safeStorageAvailable()) {
        try {
            return {scheme: 'safeStorage', data: safeStorage.encryptString(plain).toString('base64')};
        } catch {
            // 单路径失败继续尝试 AES 回退，不让「加密不可用」直接变成「无法激活」
        }
    }
    try {
        const key = await aesKey();
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        const enc = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()]);
        return {scheme: 'aes-gcm', data: Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64')};
    } catch (error) {
        logLicenseEvent('LIC_INTERNAL', {event: 'vault_encrypt_failed', reason: (error as Error).name});
        return null;
    }
}

async function decryptString(file: VaultFile): Promise<string | null> {
    try {
        const buf = Buffer.from(file.data, 'base64');
        if (file.scheme === 'safeStorage') {
            if (!safeStorageAvailable()) return null;
            return safeStorage.decryptString(buf);
        }
        if (file.scheme === 'aes-gcm') {
            if (buf.length <= 12 + 16) return null;
            const key = await aesKey();
            const iv = buf.subarray(0, 12);
            const tag = buf.subarray(12, 28);
            const enc = buf.subarray(28);
            const decipher = createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(tag);
            return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf-8');
        }
        return null;
    } catch (error) {
        // authTag 校验失败（被篡改）也会走到这里
        logLicenseEvent('LIC_VAULT_TAMPERED', {event: 'vault_decrypt_failed', reason: (error as Error).name});
        return null;
    }
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function numOr(v: unknown, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function strOrNull(v: unknown): string | null {
    return typeof v === 'string' && v ? v : null;
}

/**
 * C8 的三态字段，**必须原样保三态**：`undefined`＝从未联网问过（下次启动再问）、
 * `null`＝问过但服务端没见过这台机器、`number`＝服务端记录的首见时刻。
 * 折叠成 `null` 会让「问过了」与「没问过」混淆，折叠成 `undefined` 则每次启动都重发探测。
 * 键缺失或值不可识别（字符串/NaN/Infinity）一律按 `undefined` 处理＝重新问一次，
 * 以服务端为准；`JSON.stringify` 会丢掉 undefined 键，故写回后仍能读回同一态。
 */
function sanitizeMachineFirstSeen(v: unknown): number | null | undefined {
    if (v === undefined) return undefined;
    if (v === null) return null;
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function sanitizeTrial(raw: unknown): TrialVault | null {
    if (!isRecord(raw)) return null;
    if (typeof raw.first_run_at !== 'number' || !Number.isFinite(raw.first_run_at)) return null;
    return {
        first_run_at: raw.first_run_at,
        trial_count: Math.max(0, Math.floor(numOr(raw.trial_count, 0))),
        last_run_at: numOr(raw.last_run_at, raw.first_run_at),
        trial_token: typeof raw.trial_token === 'string' ? raw.trial_token : '',
        watermark: numOr(raw.watermark, raw.first_run_at),
        mid_soft_at_activation: strOrNull(raw.mid_soft_at_activation),
        hardware_grace_used: Math.max(0, Math.floor(numOr(raw.hardware_grace_used, 0))),
        hardware_grace_until: typeof raw.hardware_grace_until === 'number' ? raw.hardware_grace_until : null,
        server_time_floor: typeof raw.server_time_floor === 'number' ? raw.server_time_floor : null,
        machine_first_seen_at: sanitizeMachineFirstSeen(raw.machine_first_seen_at),
    };
}

function sanitizeLicense(raw: unknown): LicenseVault | null {
    if (!isRecord(raw)) return null;
    return {
        signed_token: strOrNull(raw.signed_token),
        activated_at: typeof raw.activated_at === 'number' ? raw.activated_at : null,
        mid_at_activation: strOrNull(raw.mid_at_activation),
        mid_soft_at_activation: strOrNull(raw.mid_soft_at_activation),
        // 付费态单调时钟的两个键：旧版 vault 没有它，缺失按 null（`licenseFloor()` 会忽略）
        watermark: typeof raw.watermark === 'number' && Number.isFinite(raw.watermark) ? raw.watermark : null,
        server_time_floor:
            typeof raw.server_time_floor === 'number' && Number.isFinite(raw.server_time_floor) ? raw.server_time_floor : null,
        binding_reported: raw.binding_reported === true ? true : null,
        // ---- 定期联网复核（plan-7.0）：老 vault 没有这些字段，按「从未复核过」处理，无需迁移 ----
        /** 上次发起复核的时刻（不论成败），ms；单调只增 */
        last_checked_at:
            typeof raw.last_checked_at === 'number' && Number.isFinite(raw.last_checked_at) ? raw.last_checked_at : null,
        /** 上次服务端明确回答 ACTIVE 的时刻，ms */
        last_verified_ok_at:
            typeof raw.last_verified_ok_at === 'number' && Number.isFinite(raw.last_verified_ok_at)
                ? raw.last_verified_ok_at
                : null,
        /** 已消耗的离线宽限（ms）；老 vault 缺失按 0，天然安全（不会一升级就因断网被停） */
        offline_grace_used_ms: Math.max(0, Math.floor(numOr(raw.offline_grace_used_ms, 0))),
        /** 服务端明确回答吊销/过期 → 本地停用；只有复核成功才清 false */
        revoked_by_server: raw.revoked_by_server === true ? true : null,
        /**
         * 下次复核排期时刻（plan-1.0 / C1）。**必须在此白名单里列出**，否则 `runRecheck` 写入的排期
         * 会在下一次读取时被 sanitize 掉 → 「15 天节奏 / 失败后 2 小时重试跨重启存活」静默失效。
         */
        next_check_at:
            typeof raw.next_check_at === 'number' && Number.isFinite(raw.next_check_at) ? raw.next_check_at : null,
    };
}

/** 结构校验不过 → 丢弃重建（fail-closed） */
function sanitize(raw: unknown): VaultData {
    if (!isRecord(raw)) return emptyVault();
    return {trial: sanitizeTrial(raw.trial), license: sanitizeLicense(raw.license)};
}

/**
 * 读 vault。文件缺失 / 解密失败 / 结构非法 / 自检不过 → 均返回空账本（自愈：下次写入会重建）。
 */
export async function readVault(): Promise<VaultData> {
    let content: string;
    try {
        content = await fs.readFile(vaultPath(), 'utf-8');
    } catch {
        return emptyVault();
    }
    let file: VaultFile;
    try {
        file = JSON.parse(content) as VaultFile;
    } catch {
        logLicenseEvent('LIC_VAULT_TAMPERED', {event: 'vault_json_invalid'});
        return emptyVault();
    }
    if (!file || file.v !== 1 || typeof file.data !== 'string') {
        logLicenseEvent('LIC_VAULT_TAMPERED', {event: 'vault_schema_invalid'});
        return emptyVault();
    }
    const plain = await decryptString(file);
    if (plain === null) return emptyVault();
    let parsed: unknown;
    try {
        parsed = JSON.parse(plain);
    } catch {
        logLicenseEvent('LIC_VAULT_TAMPERED', {event: 'vault_plaintext_invalid'});
        return emptyVault();
    }
    const data = sanitize(parsed);
    if (data.trial && !trialTokenValid(data.trial)) {
        logLicenseEvent('LIC_VAULT_TAMPERED', {event: 'vault_trial_token_mismatch'});
        return emptyVault();
    }
    return data;
}

/**
 * F1：vault 的**所有**写入都排到同一条进程内 promise 链上。
 *
 * 原先 `writeVault` 是「读整个 vault → 改一个字段 → 整对象写回」，单次写原子（tmp+rename）
 * 但跨调用无锁：recheck 定时器、渲染层 `activation:get-state`、支付到账轮询各自 read-modify-write，
 * 后落盘者会用**旧对象整体覆盖**前者 → 水印回退（破红线 1「只增」）或刚领取的 token 被旧 license 覆盖。
 * 注意：光把「写」串起来并不够——各调用点的 `readVault()` 发生在排队之前，读到的仍是旧值，
 * lost update 照旧。故真正的修法是把**读-改-写整体**搬进串行段，即 `updateVault()`。
 *
 * 前一个任务失败也要继续跑后续任务（`then(task, task)`），否则一次写失败会永久卡死整条链。
 */
let writeChain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = writeChain.then(task, task);
    writeChain = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}

/**
 * F1：在串行段内完成一次「读最新 → 改 → 落盘」。
 *
 * `mutator` 拿到的是**磁盘上的当前值**（不是调用方早先读到的快照），返回要落盘的新 vault；
 * 返回 `null` 表示放弃这次写入（例如目标记录已被并发修改，写回去反而会覆盖别人的结论）。
 *
 * @returns 实际落盘的值；放弃写入时为 `null`
 */
export async function updateVault(mutator: (current: VaultData) => VaultData | null): Promise<VaultData | null> {
    return enqueue(async () => {
        const current = await readVault();
        const next = mutator(current);
        if (next === null) return null;
        await writeVaultRaw(next);
        return next;
    });
}

/**
 * 写 vault（整对象覆盖语义）。加密失败时只记日志不抛错：授权判定不该因为「写不进去」而崩掉启动流程。
 *
 * ⚠️ 生产路径请优先用 `updateVault()`：本函数**不重读磁盘**，调用方传进来的对象若基于早先的快照，
 * 仍会覆盖掉期间别人的写入。保留它是因为「新建账本」「测试播种」这类场景确实需要整体覆盖。
 */
export async function writeVault(data: VaultData): Promise<void> {
    await enqueue(() => writeVaultRaw(data));
}

async function writeVaultRaw(data: VaultData): Promise<void> {
    const payload = JSON.stringify({
        trial: data.trial ? withTrialToken(data.trial) : null,
        license: data.license,
    });
    const enc = await encryptString(payload);
    if (!enc) return;
    try {
        await writeFileAtomic(vaultPath(), JSON.stringify({v: 1, scheme: enc.scheme, data: enc.data}));
    } catch (error) {
        logLicenseEvent('LIC_INTERNAL', {event: 'vault_write_failed', reason: (error as Error).name});
    }
}

/** @internal 仅测试用：清空写入链（各用例间隔离，避免上一个文件的排队任务串味）。 */
export function resetVaultWriteChain(): void {
    writeChain = Promise.resolve();
}
