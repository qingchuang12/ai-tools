/**
 * 兑换与导入（main 进程）
 *
 * 本模块只负责「把 signed token 拿到手」：收银台 URL 拼装、redeem 请求、`.lic` 文本解析、文件选择。
 * **验签 + 落盘 + 状态刷新一律由门面 `index.ts` 的 `applySignedToken()` 完成**——
 * 落盘前必须本地验签，否则等于无条件信任后端返回。
 *
 * 对外错误一律是 **i18n key**（`license.errors.generic` / `license.errors.network`），
 * 不回传任何失败原因；渲染层用 `t(error)` 翻译后展示（T04）。
 */

import {dialog} from 'electron';
import type {RedeemResult} from '../../shared/activation-types';
import {getConfig} from './config';
import {logLicenseEvent, PUBLIC_ERROR_KEY, PUBLIC_NETWORK_ERROR_KEY} from './errors';
import {getMachineCode} from './machine-code';

/** redeem 响应（字段全部可选：后端可能省略，客户端一律按可选消费） */
interface RedeemResponse {
    success?: boolean;
    licenseKey?: string;
    signedToken?: string;
    expiresAt?: number | null;
    /** 毫秒；存在时用作 server_time_floor 抬高水印下界 */
    serverTime?: number;
}

export interface RedeemFetchResult {
    ok: boolean;
    category?: 'network' | 'license';
    error?: string;
    token?: string;
    serverTimeMs?: number | null;
}

/** 按配置模板拼出带 machineId 的收银台 URL */
export async function buildCheckoutUrl(): Promise<string> {
    const cfg = getConfig();
    const machineId = await getMachineCode();
    return cfg.checkoutUrlTemplate
        .replace('{machineId}', encodeURIComponent(machineId))
        .replace('{sku}', encodeURIComponent(cfg.sku));
}

/**
 * `.lic` 内容宽松解析：先 trim；以 `{` 开头按 JSON 取 `signedToken`
 * （兼容 `{licenseKey, signedToken, expiresAt}` 包装）；否则整段当裸 token。
 */
export function parseLicenseText(text: string): string | null {
    const raw = (text || '').trim();
    if (!raw) return null;
    if (raw.startsWith('{')) {
        try {
            const json = JSON.parse(raw) as Record<string, unknown>;
            const token = json.signedToken ?? json.token;
            return typeof token === 'string' && token.trim() ? token.trim() : null;
        } catch {
            return null;
        }
    }
    return raw;
}

/**
 * 兑换码 → 后端 redeem。
 * 网络失败/超时 → `category:'network'`（唯一对外可区分的一类，否则用户会把断网误判为激活码错误）；
 * 其它一律 `category:'license'` + 统一文案，不暴露原因。
 */
export async function fetchRedeem(code: string): Promise<RedeemFetchResult> {
    const cfg = getConfig();
    const trimmed = (code || '').trim();
    if (!trimmed) {
        return {ok: false, category: 'license', error: PUBLIC_ERROR_KEY};
    }

    let machineId = '';
    try {
        machineId = await getMachineCode();
    } catch (error) {
        logLicenseEvent('LIC_INTERNAL', {event: 'redeem_machine_code_failed', reason: (error as Error).name});
    }

    let response: Response;
    try {
        response = await fetch(cfg.redeemApiUrl, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({code: trimmed, customerId: '', machineId, sku: cfg.sku}),
            signal: AbortSignal.timeout(Math.max(1000, cfg.redeemTimeoutMs)),
        });
    } catch (error) {
        logLicenseEvent('LIC_REDEEM_NETWORK', {event: 'redeem_request_failed', reason: (error as Error).name});
        return {ok: false, category: 'network', error: PUBLIC_NETWORK_ERROR_KEY};
    }

    let body: RedeemResponse | null = null;
    try {
        body = (await response.json()) as RedeemResponse;
    } catch {
        logLicenseEvent('LIC_REDEEM_BAD_RESPONSE', {event: 'redeem_json_invalid'});
        return {ok: false, category: 'license', error: PUBLIC_ERROR_KEY};
    }

    if (!response.ok || !body || body.success !== true || typeof body.signedToken !== 'string' || !body.signedToken.trim()) {
        logLicenseEvent('LIC_REDEEM_REJECTED', {event: 'redeem_rejected', status: response.status});
        return {ok: false, category: 'license', error: PUBLIC_ERROR_KEY};
    }

    return {
        ok: true,
        token: body.signedToken.trim(),
        serverTimeMs: typeof body.serverTime === 'number' && Number.isFinite(body.serverTime) ? body.serverTime : null,
    };
}

/** 主进程弹文件选择器导入 `license.lic`；用户取消时返回空结果（不算失败） */
export async function readLicenseFileViaDialog(): Promise<string | null> {
    const result = await dialog.showOpenDialog({
        title: '导入授权文件',
        properties: ['openFile'],
        filters: [{name: 'License', extensions: ['lic', 'txt', 'json']}],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const {readFile} = await import('node:fs/promises');
    try {
        return await readFile(result.filePaths[0], 'utf-8');
    } catch (error) {
        logLicenseEvent('LIC_INTERNAL', {event: 'license_file_read_failed', reason: (error as Error).name});
        return null;
    }
}

/** 兑换失败结果的统一构造（避免各处手写字面量导致文案不一致） */
export function redeemFailure(category: 'network' | 'license'): RedeemResult {
    return {success: false, category, error: category === 'network' ? PUBLIC_NETWORK_ERROR_KEY : PUBLIC_ERROR_KEY};
}
