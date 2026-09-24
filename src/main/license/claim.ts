/**
 * A9（plan-7.0）：登录后自动到账。
 *
 * 拉取本账号名下授权列表，按优先级挑一条「未在本机激活」的授权自动走统一激活端点落盘，
 * 让「登录即到账」无需用户手动兑换/导入：
 *   1) 优先 `status==ACTIVE && machineCode==null`（未绑定的有效授权，最该自动领）；
 *   2) 其次 `machineCode==本机`（已绑本机，重装/换机恢复用）；
 *   3) 都没有 → 不动、不弹窗（避免打扰无授权/仅试用用户）。
 *
 * 非阻塞、best-effort：未登录 / 网络失败 / 无候选 / 激活失败皆静默返回，绝不弹窗或抛错。
 * 复用 `redeem()`：credential=licenseKey 走统一激活端点（`/api/licenses/activate`）+
 * `applyWithSwitch` 验签落盘；邮箱取授权归属邮箱，缺省时回退到登录态账号邮箱。
 */

import {logLicenseEvent} from './errors';
import {getMachineCode} from './machine-code';
import {getPersistedAccessToken, getProfile} from '../account';
import {fetchMyLicenses} from './redeem';
// `redeem` 定义在门面 `index.ts`（落盘内核 `applyWithSwitch` 的同一处），此处回引。
// 形成 claim ↔ index 的单向环，但 `redeem` 是函数声明（模块内已提升），运行时调用点已就绪，安全。
import {redeem} from './index';

export async function claimLicenses(): Promise<{claimed: boolean}> {
    const accessToken = getPersistedAccessToken();
    if (!accessToken?.trim()) return {claimed: false};

    const list = await fetchMyLicenses(accessToken);
    if (!list || list.length === 0) return {claimed: false};

    let machineCode = '';
    try {
        machineCode = await getMachineCode();
    } catch (error) {
        logLicenseEvent('LIC_INTERNAL', {event: 'claim_machine_code_failed', reason: (error as Error).name});
        return {claimed: false};
    }

    // 优先级 1：未绑定的有效授权；优先级 2：已绑本机；都没有返回
    const candidate =
        list.find((l) => l.status === 'ACTIVE' && (l.machineCode === null || l.machineCode === '')) ??
        list.find((l) => !!l.machineCode && l.machineCode === machineCode);
    if (!candidate) return {claimed: false};

    // 邮箱兜底：授权归属邮箱优先，缺省回退登录态账号邮箱（同属本人）
    const email = candidate.customerEmail ?? (await getProfile())?.email ?? '';
    const result = await redeem(candidate.licenseKey, email, false);
    if (!result.success) {
        logLicenseEvent('LIC_CLAIM_FAILED', {event: 'auto_claim_activate_failed', hasEmail: !!email});
        return {claimed: false};
    }
    return {claimed: true};
}
