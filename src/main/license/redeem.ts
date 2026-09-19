/**
 * 兑换与导入（main 进程）
 *
 * 本模块只负责「把 signed token 拿到手」：收银台 URL 拼装、redeem 请求、`.lic` 文本解析、文件选择。
 * **验签 + 落盘 + 状态刷新一律由门面 `index.ts` 的 `applySignedToken()` 完成**——
 * 落盘前必须本地验签，否则等于无条件信任后端返回。
 *
 * 请求体与服务端 `RedeemCodeRequest` 对齐：`{code, customerEmail, machineId}`
 * （服务端 E1 起 `customerEmail` 为**必填**语义，缺失/非法分别返回 `EMAIL_REQUIRED` / `INVALID_EMAIL`）。
 * 响应解析见 `RedeemEnvelope`：服务端所有端点经 `ApiResponseAdvice` 统一包壳，token 在 **`$.data`** 段。
 *
 * 对外错误一律是 **i18n key**（`license.errors.generic` / `license.errors.network`），
 * 不回传任何失败原因；渲染层用 `t(error)` 翻译后展示（T04）。
 */

import {dialog} from 'electron';
import type {RedeemResult} from '../../shared/activation-types';
import {CHECKOUT_PAGE_PATH, REDEEM_API_PATH} from './constants';
import {getConfig} from './config';
import {logLicenseEvent, PUBLIC_ERROR_KEY, PUBLIC_NETWORK_ERROR_KEY} from './errors';
import {getMachineCode} from './machine-code';

/** 兑换响应数据体（字段全部可选：后端可能省略，客户端一律按可选消费） */
interface RedeemData {
    success?: boolean;
    licenseKey?: string;
    signedToken?: string;
    /** ISO-8601 字符串（服务端 `LocalDateTime`）；客户端当前不消费，仅类型对齐 */
    expiresAt?: string | null;
    /** 毫秒；存在时用作 server_time_floor 抬高水印下界 */
    serverTime?: number;
}

/**
 * 响应壳：服务端**所有**端点由 `ApiResponseAdvice` 统一包成 `{success, code, data, traceId, timestamp}`，
 * 故业务字段在 `data` 段；同时兼容**扁平结构**（`data` 缺失时按顶层取），避免旧服务端/自签 token 场景失效。
 */
interface RedeemEnvelope extends RedeemData {
    data?: RedeemData;
}

export interface RedeemFetchResult {
    ok: boolean;
    category?: 'network' | 'license';
    error?: string;
    token?: string;
    serverTimeMs?: number | null;
}

/** 按服务地址拼出带 machineId 的收银台 URL（页面与 API 同源，均由 billing-license-service 托管） */
export async function buildCheckoutUrl(): Promise<string> {
    const base = getConfig().serviceBaseUrl;
    const machineId = await getMachineCode();
    return `${base}${CHECKOUT_PAGE_PATH}?machineId=${encodeURIComponent(machineId)}`;
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
 * 兑换码 + 邮箱 → 后端 redeem。
 * 网络失败/超时 → `category:'network'`（唯一对外可区分的一类，否则用户会把断网误判为激活码错误）；
 * 其它一律 `category:'license'` + 统一文案，不暴露原因。
 */
export async function fetchRedeem(code: string, email: string): Promise<RedeemFetchResult> {
    const cfg = getConfig();
    const trimmed = (code || '').trim();
    const customerEmail = (email || '').trim();
    if (!trimmed || !customerEmail) {
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
        response = await fetch(`${cfg.serviceBaseUrl}${REDEEM_API_PATH}`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({code: trimmed, customerEmail, machineId}),
            signal: AbortSignal.timeout(Math.max(1000, cfg.redeemTimeoutMs)),
        });
    } catch (error) {
        logLicenseEvent('LIC_REDEEM_NETWORK', {event: 'redeem_request_failed', reason: (error as Error).name});
        return {ok: false, category: 'network', error: PUBLIC_NETWORK_ERROR_KEY};
    }

    let body: RedeemEnvelope | null = null;
    try {
        body = (await response.json()) as RedeemEnvelope;
    } catch {
        logLicenseEvent('LIC_REDEEM_BAD_RESPONSE', {event: 'redeem_json_invalid'});
        return {ok: false, category: 'license', error: PUBLIC_ERROR_KEY};
    }

    // 统一壳优先（业务字段在 data 段），无 data 段时按扁平结构取
    const data: RedeemData | null = body ? body.data ?? body : null;
    const succeeded = body?.success === true || body?.data?.success === true;
    if (
        !response.ok ||
        !body ||
        !succeeded ||
        !data ||
        typeof data.signedToken !== 'string' ||
        !data.signedToken.trim()
    ) {
        logLicenseEvent('LIC_REDEEM_REJECTED', {event: 'redeem_rejected', status: response.status});
        return {ok: false, category: 'license', error: PUBLIC_ERROR_KEY};
    }

    return {
        ok: true,
        token: data.signedToken.trim(),
        serverTimeMs: typeof data.serverTime === 'number' && Number.isFinite(data.serverTime) ? data.serverTime : null,
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
