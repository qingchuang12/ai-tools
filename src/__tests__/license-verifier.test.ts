/**
 * 离线验签器单测
 *
 * 密钥：**运行时临时生成**的 Ed25519 密钥对（见 helpers/license-test-keys.ts，仓库内不落任何私钥）。
 * 覆盖：正常通过 / 改签名 / 改 payload / 未知 kid / sku 不符 / mid 不符 / 已过期 / 容差内不算过期 /
 * feat 缺失 / 非 3 段 / raw32 公钥加载。
 */

import {createPublicKey, sign} from 'node:crypto';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it, vi} from 'vitest';
import {TEST_KEY_PAIR} from './helpers/license-test-keys';

const hoisted = vi.hoisted(() => {
    const config = {
        version: 1 as const,
        enabled: true,
        killSwitch: false,
        sku: 'AI-TOOLS-PRO',
        defaultKid: 'default',
        checkoutUrlTemplate: 'https://example.test/getlicense?machine_id={machineId}&sku={sku}',
        redeemApiUrl: 'https://api.example.test/api/redeem/redeem',
        redeemTimeoutMs: 15000,
        trial: {days: 60, maxRuns: null as number | null},
        clock: {skewToleranceMs: 2 * 60 * 60 * 1000, useServerTimeFloor: true},
        grace: {hardwareChangeDays: 7, maxAutoGrace: 1},
        features: {proFeature: 'pro', gated: ['cloud_sync', 'remote_connect']},
    };
    return {config, strongMid: 'AAAA-BBBB-CCCC-DDDD', softMid: 'AAAA-BBBB-CCCC-EEEE'};
});

vi.mock('../main/license/config', () => ({
    getConfig: (): unknown => hoisted.config,
    loadConfig: (): unknown => hoisted.config,
    resetConfigCache: (): void => undefined,
    resolveExternalLicenseDir: (): string => '',
    resolveAsarAssetsDir: (): string => '',
}));

vi.mock('../main/license/keys', async () => {
    const {TEST_KEY_PAIR: pair} = await import('./helpers/license-test-keys');
    return {
        getPublicKey: (kid: string): unknown => (kid === 'default' ? pair.publicKey : null),
        clearKeyCache: (): void => undefined,
    };
});

vi.mock('../main/license/machine-code', () => ({
    getMachineCodePair: async (): Promise<{ strong: string; soft: string }> => ({
        strong: hoisted.strongMid,
        soft: hoisted.softMid,
    }),
    getMachineCode: async (): Promise<string> => hoisted.strongMid,
}));

const {verifyToken, expToMs} = await import('../main/license/verifier');

const NOW_SEC = Math.floor(Date.now() / 1000);

function b64(obj: unknown): string {
    return Buffer.from(JSON.stringify(obj), 'utf-8').toString('base64url');
}

interface TokenInput {
    payload: Record<string, unknown>;
    kid?: string;
    alg?: string;
}

function makeToken({payload, kid = 'default', alg = 'EdDSA'}: TokenInput): string {
    const h = b64({alg, typ: 'JWT', kid});
    const p = b64(payload);
    const sig = sign(null, Buffer.from(`${h}.${p}`, 'utf-8'), TEST_KEY_PAIR.privateKey);
    return `${h}.${p}.${sig.toString('base64url')}`;
}

function basePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        jti: 'jti-test-0001',
        sku: 'AI-TOOLS-PRO',
        mid: hoisted.strongMid,
        iat: NOW_SEC,
        exp: NOW_SEC + 30 * 86400,
        feat: ['pro'],
        ...overrides,
    };
}

/** 签名段首字节取反：长度不变、格式合法，但验签必失败 */
function tamperSignature(token: string): string {
    const parts = token.split('.');
    const sig = Buffer.from(parts[2], 'base64url');
    sig[0] = sig[0] ^ 0xff;
    return `${parts[0]}.${parts[1]}.${sig.toString('base64url')}`;
}

describe('verifyToken', () => {
    it('正常令牌：验签通过且 claim 齐全', async () => {
        const outcome = await verifyToken(makeToken({payload: basePayload()}));
        expect(outcome.ok).toBe(true);
        expect(outcome.code).toBe('LIC_OK');
        expect(outcome.payload?.mid).toBe(hoisted.strongMid);
        expect(outcome.kid).toBe('default');
    });

    it('改签名：验签失败（LIC_BAD_SIGNATURE）', async () => {
        const outcome = await verifyToken(tamperSignature(makeToken({payload: basePayload()})));
        expect(outcome.ok).toBe(false);
        expect(outcome.code).toBe('LIC_BAD_SIGNATURE');
    });

    it('改 payload：签名不匹配（LIC_BAD_SIGNATURE）', async () => {
        const token = makeToken({payload: basePayload()});
        const parts = token.split('.');
        const forged = `${parts[0]}.${b64(basePayload({feat: ['cloud_sync', 'remote_connect', 'pro']}))}.${parts[2]}`;
        const outcome = await verifyToken(forged);
        expect(outcome.ok).toBe(false);
        expect(outcome.code).toBe('LIC_BAD_SIGNATURE');
    });

    it('未知 kid：取不到公钥（LIC_UNKNOWN_KID）', async () => {
        const outcome = await verifyToken(makeToken({payload: basePayload(), kid: 'no-such-kid'}));
        expect(outcome.ok).toBe(false);
        expect(outcome.code).toBe('LIC_UNKNOWN_KID');
    });

    it('sku 不符（LIC_SKU_MISMATCH）', async () => {
        const outcome = await verifyToken(makeToken({payload: basePayload({sku: 'OTHER-SKU'})}));
        expect(outcome.ok).toBe(false);
        expect(outcome.code).toBe('LIC_SKU_MISMATCH');
    });

    it('mid 与本机不符（LIC_MACHINE_MISMATCH）', async () => {
        const outcome = await verifyToken(makeToken({payload: basePayload({mid: '1111-2222-3333-4444'})}));
        expect(outcome.ok).toBe(false);
        expect(outcome.code).toBe('LIC_MACHINE_MISMATCH');
    });

    it('已过期（LIC_EXPIRED）', async () => {
        const outcome = await verifyToken(makeToken({payload: basePayload({exp: NOW_SEC - 30 * 86400})}));
        expect(outcome.ok).toBe(false);
        expect(outcome.code).toBe('LIC_EXPIRED');
    });

    it('刚过期但在 2h 容差内：不算过期', async () => {
        const outcome = await verifyToken(makeToken({payload: basePayload({exp: NOW_SEC - 3600})}));
        expect(outcome.ok).toBe(true);
        expect(outcome.code).toBe('LIC_OK');
    });

    it('exp 为 null 视为永久授权', async () => {
        const outcome = await verifyToken(makeToken({payload: basePayload({exp: null})}));
        expect(outcome.ok).toBe(true);
    });

    it('feat 缺失：需要 cloud_sync 但只给了别的权益（LIC_FEATURE_MISSING）', async () => {
        const outcome = await verifyToken(makeToken({payload: basePayload({feat: ['basic']})}), {
            requiredFeature: 'cloud_sync',
        });
        expect(outcome.ok).toBe(false);
        expect(outcome.code).toBe('LIC_FEATURE_MISSING');
    });

    it('pro 权益包含所需功能：gate 放行', async () => {
        const outcome = await verifyToken(makeToken({payload: basePayload({feat: ['pro']})}), {
            requiredFeature: 'remote_connect',
        });
        expect(outcome.ok).toBe(true);
    });

    it('非 3 段（LIC_MALFORMED）', async () => {
        expect((await verifyToken('')).code).toBe('LIC_MALFORMED');
        expect((await verifyToken('aaaa')).code).toBe('LIC_MALFORMED');
        expect((await verifyToken('a.b')).code).toBe('LIC_MALFORMED');
        expect((await verifyToken('a.b.c.d')).code).toBe('LIC_MALFORMED');
        // 3 段但内容不是 base64url / JSON
        expect((await verifyToken('!!!.!!!.!!!')).code).toBe('LIC_MALFORMED');
    });

    it('alg 被改成非 EdDSA（LIC_MALFORMED）', async () => {
        const outcome = await verifyToken(makeToken({payload: basePayload(), alg: 'none'}));
        expect(outcome.ok).toBe(false);
        expect(outcome.code).toBe('LIC_MALFORMED');
    });

    it('killSwitch=true 时跳过验签（应急放行）', async () => {
        hoisted.config.killSwitch = true;
        try {
            // 令牌本身是「签名被篡改」的，正常情况下必失败；killSwitch 下应放行
            const outcome = await verifyToken(tamperSignature(makeToken({payload: basePayload()})));
            expect(outcome.ok).toBe(true);
            expect(outcome.code).toBe('LIC_OK');
        } finally {
            hoisted.config.killSwitch = false;
        }
    });
});

describe('expToMs（秒 → 毫秒唯一转换出口）', () => {
    it('秒转毫秒，null / 非法值返回 null', () => {
        expect(expToMs(1700000000)).toBe(1700000000000);
        expect(expToMs(null)).toBeNull();
        expect(expToMs(undefined)).toBeNull();
    });
});

describe('公钥格式兼容（raw32 / PEM / SPKI DER）', () => {
    it('裸 32 字节公钥可载入并参与验签', async () => {
        const actualKeys = await vi.importActual<typeof import('../main/license/keys')>('../main/license/keys');
        const raw32 = TEST_KEY_PAIR.publicKey.export({format: 'der', type: 'spki'}).subarray(-32);
        expect(raw32.length).toBe(32);

        const key = actualKeys.loadPublicKeyFromBytes(raw32);
        expect(key).not.toBeNull();
        expect(key?.asymmetricKeyType).toBe('ed25519');

        const data = Buffer.from('verify-me', 'utf-8');
        const sig = sign(null, data, TEST_KEY_PAIR.privateKey);
        const {verify} = await import('node:crypto');
        expect(verify(null, data, key as never, sig)).toBe(true);
    });

    it('仓库内 src/public.key（实测为 raw32）可载入', async () => {
        const actualKeys = await vi.importActual<typeof import('../main/license/keys')>('../main/license/keys');
        const file = fileURLToPath(new URL('../public.key', import.meta.url));
        const key = actualKeys.loadPublicKeyFromBytes(fs.readFileSync(file));
        expect(key).not.toBeNull();
        expect(key?.asymmetricKeyType).toBe('ed25519');
    });

    it('PEM 与 SPKI DER 可载入；垃圾内容返回 null', async () => {
        const actualKeys = await vi.importActual<typeof import('../main/license/keys')>('../main/license/keys');
        const pem = TEST_KEY_PAIR.publicKey.export({format: 'pem', type: 'spki'}).toString();
        expect(actualKeys.loadPublicKeyFromBytes(Buffer.from(pem, 'utf-8'))?.asymmetricKeyType).toBe('ed25519');

        const der = TEST_KEY_PAIR.publicKey.export({format: 'der', type: 'spki'}) as Buffer;
        expect(actualKeys.loadPublicKeyFromBytes(der)?.asymmetricKeyType).toBe('ed25519');

        // 带尾随换行的 raw32（真实文件常见）也应识别
        const raw32 = der.subarray(-32);
        expect(actualKeys.loadPublicKeyFromBytes(Buffer.concat([raw32, Buffer.from('\r\n')]))?.asymmetricKeyType).toBe(
            'ed25519'
        );

        expect(actualKeys.loadPublicKeyFromBytes(Buffer.from('not-a-key', 'utf-8'))).toBeNull();
        expect(actualKeys.loadPublicKeyFromBytes(Buffer.alloc(0))).toBeNull();
    });

    it('createPublicKey 不接受裸 32 字节（说明这层兼容是必需的）', () => {
        const raw32 = TEST_KEY_PAIR.publicKey.export({format: 'der', type: 'spki'}).subarray(-32);
        expect(() => createPublicKey({key: raw32, format: 'der', type: 'spki'})).toThrow();
    });
});
