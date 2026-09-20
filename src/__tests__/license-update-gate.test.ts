/**
 * R3（plan-2.7）：更新权益软门控 `evaluateUpdateEntitlement`。
 *
 * `update_until` / `max_major_version` 此前只解析不执行；本套测试钉死语义：
 * 订阅令牌超更新权益截止 / 跨大版本 → 拦；字段缺失 = 不限；payload 为 null（未激活/试用）→ 放行。
 */

import {describe, expect, it} from 'vitest';
import {evaluateUpdateEntitlement} from '../main/license/update-gate';
import type {TokenPayload} from '../main/license/types';

const NOW = Date.parse('2026-09-20T00:00:00Z');
const DAY_SEC = 86400;

function payloadWith(extra: Partial<TokenPayload>): TokenPayload {
    return {
        sku: 'pro-subscription',
        mid: 'AAAA-BBBB-CCCC-DDDD',
        iat: Math.floor(NOW / 1000) - DAY_SEC,
        exp: Math.floor(NOW / 1000) + 365 * DAY_SEC,
        feat: ['OFFLINE'],
        ...extra,
    };
}

describe('evaluateUpdateEntitlement', () => {
    it('payload 为 null（未激活/试用/验签未过）→ 放行：更新权益合同只对订阅令牌成立', () => {
        expect(evaluateUpdateEntitlement(null, '9.0.0', NOW)).toEqual({allowed: true, reason: 'ok'});
    });

    it('未声明 update_until / max_major_version → 不限制', () => {
        expect(evaluateUpdateEntitlement(payloadWith({}), '9.0.0', NOW)).toEqual({allowed: true, reason: 'ok'});
    });

    it('update_until 未到 → 放行；已过 → 拦截', () => {
        const untilSec = Math.floor(NOW / 1000) + 30 * DAY_SEC;
        const p = payloadWith({update_until: untilSec});
        expect(evaluateUpdateEntitlement(p, '1.2.3', NOW)).toEqual({allowed: true, reason: 'ok'});
        expect(evaluateUpdateEntitlement(p, '1.2.3', NOW + 31 * 86400_000)).toEqual({
            allowed: false,
            reason: 'update_until_passed',
        });
    });

    it('max_major_version：大版本超限拦截，小版本放行', () => {
        const p = payloadWith({max_major_version: 2});
        expect(evaluateUpdateEntitlement(p, '2.9.9', NOW)).toEqual({allowed: true, reason: 'ok'});
        expect(evaluateUpdateEntitlement(p, '3.0.0', NOW)).toEqual({allowed: false, reason: 'major_not_included'});
    });

    it('update_until 优先于 max_major_version 判定', () => {
        const p = payloadWith({update_until: Math.floor(NOW / 1000) - DAY_SEC, max_major_version: 1});
        expect(evaluateUpdateEntitlement(p, '5.0.0', NOW)).toEqual({allowed: false, reason: 'update_until_passed'});
    });

    it('畸形版本串（无数字 major）不拦截', () => {
        const p = payloadWith({max_major_version: 2});
        expect(evaluateUpdateEntitlement(p, 'unknown', NOW)).toEqual({allowed: true, reason: 'ok'});
    });

    it('非法字段值（0 / NaN）按「未限制」处理', () => {
        const p = payloadWith({update_until: 0, max_major_version: Number.NaN});
        expect(evaluateUpdateEntitlement(p, '9.0.0', NOW)).toEqual({allowed: true, reason: 'ok'});
    });
});
