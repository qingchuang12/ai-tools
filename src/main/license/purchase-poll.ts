/**
 * 支付后自动到账轮询（main 进程，plan-1.0 / C4）
 *
 * 解决的缺口：收银台在**系统浏览器**里完成支付，桌面软件既无深链回调也无推送通道，
 * 用户付完款回到软件只能看到「未激活」，得手动复制 license 才能激活。
 * 本模块用「按机器码查询待领取授权」把这个体验补上：打开收银台后的一段时间内定期问一次，
 * 问到即领取（补绑本机 → 本地验签 → 落盘），UI 随即变为已激活。
 *
 * 依赖方向保持单向：`index → purchase-poll`。领取动作（涉及验签与落盘）不在本模块做，
 * 由门面通过 `setPurchaseClaimHandler()` 注入——与 `recheck` 的停用钩子同一套路，避免循环依赖。
 *
 * 三条红线：
 * 1. **对外绝不抛**：问不到就下一轮再问，窗口结束静默收场，绝不弹错误、不改授权状态；
 * 2. **不做无据信任**：拿到的 `signedToken` 一律经门面注入的 claim（内部本地 Ed25519 验签 +
 *    `mid == 本机强机器码`）才落盘，服务端返回什么都不直接采信；
 * 3. **单实例 + 有窗口**：重复打开收银台只重置窗口，不会叠加多个循环把服务端限流打满。
 */

import {PURCHASE_POLL_INTERVAL_MS, PURCHASE_POLL_WINDOW_MS} from './constants';
import {getConfig} from './config';
import {logLicenseEvent} from './errors';
import {getMachineCode} from './machine-code';
import {fetchPendingLicenses} from './redeem';

/**
 * 领取处理器：把一条待领取授权变成本地已激活状态。
 * 返回 true = 已生效（轮询随即收场）；false = 本条不适用（试下一条 / 下轮再试）。
 */
export type PurchaseClaimHandler = (signedToken: string) => Promise<boolean>;

let claimHandler: PurchaseClaimHandler | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollUntil = 0;

/** 注册领取处理器（门面在模块初始化时调用）；传 null 注销 */
export function setPurchaseClaimHandler(fn: PurchaseClaimHandler | null): void {
    claimHandler = fn;
}

/** 正在轮询中（单测与 UI 观测用） @internal 生产无调用点，仅测试/观测用 */
export function isPollingForPurchase(): boolean {
    return pollTimer !== null;
}

/** 停止轮询（窗口耗尽 / 领到 / 退出用） */
export function stopPurchasePolling(): void {
    if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
    }
    pollUntil = 0;
}

/**
 * 打开收银台后启动轮询：窗口 30 分钟、每 60 秒问一次（档位与服务端 pending 限流对齐）。
 * 重复调用 = 重置窗口（用户又点了一次「在线激活」），不叠加循环。
 */
export function startPurchasePolling(): void {
    stopPurchasePolling();
    if (!claimHandler) return;
    pollUntil = Date.now() + PURCHASE_POLL_WINDOW_MS;
    scheduleTick(PURCHASE_POLL_INTERVAL_MS);
}

/** 递归 setTimeout；unref 保证后台轮询不阻止进程退出 */
function scheduleTick(delayMs: number): void {
    if (pollUntil === 0) return;
    const timer = setTimeout(() => {
        void pollOnce().then((claimed) => {
            if (claimed) {
                stopPurchasePolling();
                return;
            }
            if (Date.now() >= pollUntil) {
                stopPurchasePolling();
                return;
            }
            scheduleTick(PURCHASE_POLL_INTERVAL_MS);
        });
    }, Math.max(1000, delayMs));
    if (typeof timer.unref === 'function') timer.unref();
    pollTimer = timer;
}

/**
 * 问一次并尝试领取。
 * @returns 本次是否有授权成功落地（true 才停止轮询）
 */
async function pollOnce(): Promise<boolean> {
    try {
        if (!claimHandler) return false;
        const machineId = await getMachineCode();
        const pending = await fetchPendingLicenses(machineId);
        if (pending.length === 0) return false;
        // 只领属于本产品档位（acceptedSkus）的授权：公共服务下同一台机器可能买过别的产品，
        // 档位不匹配的 token 本地验签必拒（LIC_SKU_MISMATCH），白耗一次领取窗口。
        const {acceptedSkus, sku} = getConfig();
        const mine = pending.filter((item) => !item.productSku || acceptedSkus.includes(item.productSku) || item.productSku === sku);
        for (const item of mine) {
            if (await claimHandler(item.signedToken)) {
                logLicenseEvent('LIC_OK', {event: 'purchase_poll_claimed'});
                return true;
            }
        }
        return false;
    } catch (error) {
        // 轮询是旁路：任何异常都只是「这次没问到」，下轮再来
        logLicenseEvent('LIC_INTERNAL', {event: 'purchase_poll_unexpected', reason: (error as Error).name});
        return false;
    }
}
