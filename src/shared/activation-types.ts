/**
 * 激活（授权）相关共享类型
 * 主进程 / 预加载 / 渲染层共用单一事实源，避免三端类型漂移。
 */

export type ActivationStatus = 'inactive' | 'trial' | 'activated';

export interface ActivationState {
    /** 当前状态 */
    status: ActivationStatus;
    /** 试用到期时间戳（ms），仅 trial 有意义 */
    trialExpiresAt: number | null;
    /** 激活到期时间戳（ms），null 表示永久激活 */
    activatedExpiresAt: number | null;
    /** 激活时间（ms） */
    activatedAt: number | null;
    /** 激活时绑定的机器码 */
    machineCode: string | null;
}

export interface ActivationResult {
    success: boolean;
    error?: string;
    state?: ActivationState;
}

export interface ActivationApi {
    /** 读取当前激活状态（主进程会顺带做到期降级并持久化） */
    getState: () => Promise<ActivationState>;
    /** 生成本机机器码（CPU 序列号 + 主板 UUID + 网卡 MAC 派生） */
    getMachineCode: () => Promise<string>;
    /** 离线激活：用机器码校验激活码 */
    offlineActivate: (machineCode: string, code: string) => Promise<ActivationResult>;
    /** 在线激活（当前占位，未接入后端） */
    onlineActivate: (payload: unknown) => Promise<ActivationResult>;
    /** 去激活：回到未激活 */
    deactivate: () => Promise<ActivationState>;
}
