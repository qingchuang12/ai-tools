/**
 * 激活（授权）相关共享类型
 * 主进程 / 预加载 / 渲染层共用单一事实源，避免三端类型漂移。
 *
 * 约定：
 * - 所有时间字段一律**毫秒**（token 内部的 iat/exp/nbf 是秒，转换只在
 *   `src/main/license/verifier.ts` 一处进行）；
 * - `features` 是「当前生效权益」的扁平列表，判定规则统一为
 *   `feat.includes('pro') || feat.includes(需要的权益)`；
 * - 对外错误文案一律是**已翻译好的统一文案**，UI 禁止再拼接任何失败原因。
 */

export type ActivationStatus = 'inactive' | 'trial' | 'activated';

/**
 * 降级/异常原因（内部语义）
 * UI 只用 `degraded !== null` 决定是否展示「重新激活」引导，**不展示原因本身**，
 * 避免把失败定位信息暴露给破解者。
 */
export type ActivationDegradedReason =
    | 'expired'             // 授权到期
    | 'trial_expired'       // 试用天数耗尽
    | 'trial_runs_exceeded' // 试用启动次数耗尽
    | 'machine_mismatch'    // 机器码不匹配（换机）
    | 'hardware_changed'    // 磁盘变更，处于宽限
    | 'clock_rollback'      // 检测到时间回拨
    | 'token_invalid'       // 验签/格式不通过
    | 'vault_tampered';     // 本地存储损坏或被篡改

export interface ActivationState {
    /** 当前状态 */
    status: ActivationStatus;
    /** 试用开始时间（ms） */
    trialStartsAt: number | null;
    /** 试用到期时间戳（ms），仅 trial 有意义 */
    trialExpiresAt: number | null;
    /** 试用剩余启动次数；null = 不限（本期只记录不拦截） */
    trialRunsLeft: number | null;
    /** 激活到期时间戳（ms），null 表示永久激活 */
    activatedExpiresAt: number | null;
    /** 激活时间（ms） */
    activatedAt: number | null;
    /** 激活时绑定的机器码 */
    machineCode: string | null;
    /** 脱敏后的 licenseKey，仅用于 UI 展示（AB12-****-****-CD34） */
    licenseKey: string | null;
    /** 生效授权的产品编码 */
    sku: string | null;
    /** 当前生效权益列表；未激活时为空数组 */
    features: string[];
    /** 当前权益来源：none=无 / trial=试用 / license=已兑换授权 */
    source: 'none' | 'trial' | 'license';
    /** 降级原因；null = 正常 */
    degraded: ActivationDegradedReason | null;
}

/** 对外结果：error 已是「统一文案」，前端直接展示，不解释 */
export interface ActivationResult {
    success: boolean;
    error?: string;
    state?: ActivationState;
}

/**
 * 兑换/导入结果。
 * category 只区分「网络」与「授权」两类，不暴露任何可用于定位失败原因的信息
 * （区分网络是为了避免用户网坏了却以为是激活码错，徒增客诉）。
 */
export interface RedeemResult {
    success: boolean;
    error?: string;
    category?: 'network' | 'license';
    state?: ActivationState;
}

export interface ActivationApi {
    /** 读取当前激活状态（主进程会顺带做到期降级并持久化） */
    getState: () => Promise<ActivationState>;
    /** 生成本机机器码（硬件因子哈希派生，形如 XXXX-XXXX-XXXX-XXXX） */
    getMachineCode: () => Promise<string>;
    /** 按配置模板拼出带 machineId 的收银台 URL */
    getPurchaseUrl: () => Promise<string>;
    /**
     * 兑换码 + 购买邮箱 → 后端 redeem → 本地验签 → 落盘。
     * 邮箱是服务端的客户标识（必填）：未注册邮箱会在服务端自动建访客账户。
     */
    redeem: (code: string, email: string) => Promise<RedeemResult>;
    /** 主进程弹文件选择器导入 license.lic */
    importLicenseFile: () => Promise<RedeemResult>;
    /** 直接喂文本（裸 token 或 JSON），供拖拽/粘贴场景 */
    importLicenseText: (text: string) => Promise<RedeemResult>;
    /** 去激活：回到未激活（不重置试用） */
    deactivate: () => Promise<ActivationState>;
    /** 功能 gate 查询（渲染层仅用于 UI 态，安全边界在主进程） */
    hasFeature: (feature: string) => Promise<boolean>;
}
