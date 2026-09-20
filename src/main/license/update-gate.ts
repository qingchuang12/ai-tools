/**
 * 更新权益软门控（main 进程，plan-2.7 的 R3）
 *
 * 背景：token 的 `update_until` / `max_major_version` 此前只解析不执行（plan-2.6 的 R3），
 * 订阅超过更新权益截止仍能升级到新版本，产生虚假保证。本模块实现**软门控**：
 * 只拦「新版本更新」，不拦当前版本运行；买断/未激活/试用（payload 为 null）不受限——
 * 更新权益是订阅令牌的合同条款。
 */

import type {TokenPayload} from './types';

export type UpdateGateReason = 'ok' | 'update_until_passed' | 'major_not_included';

export interface UpdateGateResult {
    allowed: boolean;
    reason: UpdateGateReason;
}

/**
 * 判定「从当前版本更新到 newVersion」是否在订阅更新权益内。
 *
 * - `update_until`（秒，Unix epoch）：已过 → 任何新版本都不可更新；
 * - `max_major_version`：新版本 major 超限 → 不可更新（小版本仍可）；
 * - 字段缺失/非法 = 不限制；`payload` 为 null（未激活/试用/验签未过）= 放行。
 */
export function evaluateUpdateEntitlement(payload: TokenPayload | null, newVersion: string, nowMs: number): UpdateGateResult {
    if (!payload) return {allowed: true, reason: 'ok'};

    const untilSec = payload.update_until;
    if (typeof untilSec === 'number' && Number.isFinite(untilSec) && untilSec > 0 && nowMs / 1000 > untilSec) {
        return {allowed: false, reason: 'update_until_passed'};
    }

    const maxMajor = payload.max_major_version;
    if (typeof maxMajor === 'number' && Number.isFinite(maxMajor) && maxMajor > 0) {
        const major = Number.parseInt(newVersion.split('.')[0] ?? '', 10);
        if (Number.isFinite(major) && major > maxMajor) {
            return {allowed: false, reason: 'major_not_included'};
        }
    }
    return {allowed: true, reason: 'ok'};
}
