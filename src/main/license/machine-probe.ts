/**
 * 机器码「首次出现时间」探测（main 进程，C8 2026-09-20）
 *
 * 背景：试用账本（vault）与首跑账本（first-run）都在本地，删掉这两个文件重装就能再领一次
 * 60 天试用。服务端现在为每台机器记一行 `first_seen_at`（见 billing 侧 MachineRegistryService），
 * 客户端首跑联网问一次，把试用起点**回溯**到服务端最早见到这台机器的时间——
 * 删档重来拿到的仍是「已经过期」的试用，而不是全新 60 天。
 *
 * 设计口径：
 * - **尽力而为**：任何失败（断网 / 超时 / 响应畸形 / 端点不存在）一律返回 null，按「服务端没见过」处理，
 *   绝不因为探测失败把用户挡在门外（离线可用性优先）；
 * - **不记日志泄密**：只记失败类型，不打印机器码与 URL；
 * - 响应按服务端统一壳解析（`$.data.firstSeenAt`），兼容扁平结构。
 */

import {MACHINE_FIRST_SEEN_API_PATH, MACHINE_PROBE_TIMEOUT_MS} from './constants';
import {getConfig} from './config';
import {logLicenseEvent} from './errors';
import {getMachineCode} from './machine-code';

interface FirstSeenData {
    machineCode?: string;
    /** ISO-8601 字符串（服务端 LocalDateTime）；null = 服务端从没见过这台机器 */
    firstSeenAt?: string | null;
    seen?: boolean;
}

interface FirstSeenEnvelope extends FirstSeenData {
    data?: FirstSeenData;
}

/**
 * 问服务端：这台机器最早什么时候来过？
 *
 * @returns 首次见到时间（ms）；null = 从未见过，或探测失败（离线/超时/畸形响应）
 */
export async function probeMachineFirstSeen(): Promise<number | null> {
    const cfg = getConfig();
    let machineCode = '';
    try {
        machineCode = await getMachineCode();
    } catch (error) {
        logLicenseEvent('LIC_INTERNAL', {event: 'machine_probe_code_failed', reason: (error as Error).name});
        return null;
    }
    if (!machineCode) return null;

    let body: FirstSeenEnvelope | null = null;
    try {
        const response = await fetch(
            `${cfg.serviceBaseUrl}${MACHINE_FIRST_SEEN_API_PATH(machineCode)}`,
            {
                method: 'GET',
                headers: {accept: 'application/json'},
                // 比兑换更短：这是启动路径上的旁路请求，不能拖慢首屏
                signal: AbortSignal.timeout(MACHINE_PROBE_TIMEOUT_MS),
            }
        );
        if (!response.ok) {
            logLicenseEvent('LIC_INTERNAL', {event: 'machine_probe_http_error'});
            return null;
        }
        body = (await response.json()) as FirstSeenEnvelope;
    } catch (error) {
        // 断网 / 超时 / JSON 解析失败一律当「没见过」：离线时用户仍应拿到试用
        logLicenseEvent('LIC_INTERNAL', {event: 'machine_probe_failed', reason: (error as Error).name});
        return null;
    }

    const data: FirstSeenData | null = body ? body.data ?? body : null;
    const raw = data?.firstSeenAt;
    if (typeof raw !== 'string' || !raw) return null;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
}
