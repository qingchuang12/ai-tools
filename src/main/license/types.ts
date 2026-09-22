/**
 * 授权模块内部类型（main 进程专用，不外泄到 preload / renderer）
 *
 * 时间单位约定：
 * - `TokenPayload` 的 `iat` / `exp` / `nbf` 用**秒**（Unix epoch，与 JWT 惯例一致）；
 * - `TrialVault` / `LicenseVault` / `ActivationState` 一律用**毫秒**；
 * - 秒↔毫秒的转换**只允许**发生在 `verifier.ts` 一处。
 */

import type {LicenseErrorCode} from './errors';

/** 授权配置（源码期落 `assets/license.config.json`，打包后包外 `resources/license/` 可覆盖） */
export interface LicenseConfig {
    version: 1;
    sku: string;
    /**
     * 本产品**接受的** SKU 列表：token 的 `sku` 必须命中，否则判 `LIC_SKU_MISMATCH`。
     * 服务端按档位（买断/订阅 × Pro/Pro Plus）使用不同 SKU，故是列表而非单值。
     */
    acceptedSkus: string[];
    /**
     * SKU → 客户端 gate 权益键。
     * token 的 `feat` 是服务端的「营销权益文案」（OFFLINE/MULTI_DEVICE/…），与客户端功能开关不同层，
     * 故功能解锁按 SKU 映射；未列出的 SKU 不额外解锁功能（会记 `LIC_FEATURE_MISSING` 日志）。
     */
    skuFeatures: Record<string, string[]>;
    /** 兜底 kid（token 未声明 kid 时使用） */
    defaultKid: string;
    /**
     * billing-license-service 服务地址（origin，结尾不带 `/`）。
     * 收银台页与兑换 API 均由它派生（见 `CHECKOUT_PAGE_PATH` / `REDEEM_API_PATH`），
     * 一处配置即与后台服务一一对应，不会出现跳转与兑换指向两个实例的漂移。
     */
    serviceBaseUrl: string;
    redeemTimeoutMs: number;
    trial: {
        /** 试用天数上限（硬约束） */
        days: number;
        /** 试用启动次数上限；null = 不限（只记录 trial_count，不拦截） */
        maxRuns: number | null;
    };
    clock: {
        /** 时钟容差（ms）：到期/回拨判定放宽此值，默认 2h */
        skewToleranceMs: number;
        /** 是否消费 redeem 响应里的 serverTime 作为时间下界 */
        useServerTimeFloor: boolean;
    };
    grace: {
        /** 硬件变更宽限天数 */
        hardwareChangeDays: number;
        /** 终身可自动宽限次数 */
        maxAutoGrace: number;
    };
    features: {
        /** 全量权益 key（拥有即拥有全部付费功能） */
        proFeature: string;
        /** 需要 gate 的权益名单 */
        gated: string[];
    };
}

/** 签名令牌头部 */
export interface TokenHeader {
    alg: 'EdDSA';
    typ: 'JWT';
    kid: string;
}

/** 签名令牌载荷 */
export interface TokenPayload {
    /** 令牌唯一 id（日志/吊销用）。**服务端当前不签发**，故为可选（客户端也不消费） */
    jti?: string;
    sku: string;
    /** 强绑定机器码（含磁盘因子）；服务端在无机器码时不写该键（客户端会判 LIC_MACHINE_MISMATCH） */
    mid: string;
    /** 签发时间（秒，Unix epoch） */
    iat: number;
    /** 到期时间（秒）；null / 缺失 = 永久 */
    exp: number | null;
    /** 生效时间（秒）；可选（服务端当前不签发） */
    nbf?: number;
    /** 授予的权益列表（服务端为产品 `features` 原文，功能解锁见 `LicenseConfig.skuFeatures`） */
    feat: string[];
    /** licenseKey，用于 UI 脱敏展示 */
    lic?: string;
    /** 套餐名（服务端 `PlanTier`，如 PRO / PRO_PLUS） */
    plan?: string;
    /** 客户 id（服务端内部 UUID）；客户端不使用，仅为契约完整 */
    cid?: string;
    /** 订单 id（服务端内部 UUID）；客户端不使用，仅为契约完整 */
    oid?: string;
    /**
     * 更新权益截止（秒，Unix epoch）；缺失 = 不限制。
     * **当前仅解析、不据此拦截**——硬阻断 vs 更新门控属产品策略（见 plan-2.4 的 C5（已拍板：软门控））。
     */
    update_until?: number | null;
    /** 允许使用的大版本上限；缺失 = 不限制。同 `update_until`，当前不拦截 */
    max_major_version?: number | null;
}

/** 本地加密存储中的试用账本（vault 内明文结构） */
export interface TrialVault {
    /** 首次运行时间（ms） */
    first_run_at: number;
    /** 累计启动次数（单调，只增） */
    trial_count: number;
    /** 上次运行时间（ms） */
    last_run_at: number;
    /** 自检串，用于发现明文篡改 */
    trial_token: string;
    /** 单调时间水印（ms），只增不减 */
    watermark: number;
    /** 发试用/激活时的弱绑定机器码快照（剔除磁盘） */
    mid_soft_at_activation: string | null;
    /** 已用硬件变更宽限次数 */
    hardware_grace_used: number;
    /** 宽限截止（ms） */
    hardware_grace_until: number | null;
    /** 后端给的权威时间下界（ms） */
    server_time_floor: number | null;
    /**
     * C8：服务端记录的「这台机器最早何时来过」（ms）。
     *
     * 用途：本地 vault + 首跑账本都能被删掉重装骗过（删档重来 = 全新 60 天），
     * 服务端这份记忆删不掉，据此把 `first_run_at` 回溯到它，删档重来只能拿到**已过期**的试用。
     *
     * 三态语义：`undefined` = 从未联网问过（下次启动再问）；`number` = 服务端见过，值为首次时间；
     * `null` = 问过、服务端没见过（全新机器，正常发试用）。
     * 可选字段：旧 vault 没有它，按「从未问过」处理（向后兼容，无需迁移）。
     */
    machine_first_seen_at?: number | null;
}

/** 本地加密存储中的授权账本 */
export interface LicenseVault {
    signed_token: string | null;
    activated_at: number | null;
    mid_at_activation: string | null;
    mid_soft_at_activation: string | null;
    /**
     * 付费态单调时间水印（ms，只增不减）。
     *
     * 与 trial 的 `watermark` 同口径，但**记在本账本里**：付费激活时 `getState()` 走早期返回，
     * 不推进 trial 水印，若不额外记录，把系统时间改回过去就能让已过期的订阅复活（plan-2.4 的 C7，已修复）。
     * 可选字段：旧版本 vault 没有它，`licenseFloor()` 按 null 处理（向后兼容，无需迁移）。
     */
    watermark?: number | null;
    /** 后端给的权威时间下界（ms，只增不减）；来源为 redeem 响应的 `serverTime` */
    server_time_floor?: number | null;
}

/** 验签结果：`code` 是内部码，只进日志 */
export interface VerifyOutcome {
    ok: boolean;
    code: LicenseErrorCode;
    payload: TokenPayload | null;
    kid: string | null;
}
