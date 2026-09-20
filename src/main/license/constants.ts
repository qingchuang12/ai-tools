/**
 * 授权模块常量（main 进程专用）
 *
 * 路径 / 文件名 / 默认值 / 超时全部集中在此，避免散落在各模块后出现
 * 「改了一处忘了另一处」导致的资产加载失败。
 */

import {
    ACCEPTED_SKUS,
    DEFAULT_KID,
    FEATURE_CLOUD_SYNC,
    FEATURE_PRO,
    PRODUCT_SKU,
    SKU_FEATURES,
} from '../../shared/license-constants';
import type {LicenseConfig} from './types';

/** 机器码派生固定盐：只上传哈希不上传原始硬件信息，盐保证不同产品的机器码不通用 */
export const MACHINE_CODE_SALT = 'ai-tools::machine-code::v1';

/** 用户数据目录（~/.ai-tools） */
export const AI_TOOLS_DIR_NAME = '.ai-tools';

/** 源码期资产目录名；打包后 asar 内为 dist/main/license/assets */
export const ASSETS_DIR_NAME = 'assets';

/** 包外可替换目录名（打包后 <install>/resources/license） */
export const EXTERNAL_LICENSE_DIR_NAME = 'license';

/** 配置文件名 */
export const CONFIG_FILE_NAME = 'license.config.json';

/** 收银台页路径：billing-license-service 同源托管（static/checkout），与 machineId 查询参数一起构成页面契约 */
export const CHECKOUT_PAGE_PATH = '/checkout/index.html';

/** 兑换端点路径：服务端 RedeemCodeController 的对外契约 */
export const REDEEM_API_PATH = '/api/redeem/redeem';

/**
 * C8：机器码首次出现时间端点（服务端 MachineController，公开只读）。
 * 客户端首跑联网问一次，把试用起点回溯到服务端最早见到这台机器的时间。
 */
export const MACHINE_FIRST_SEEN_API_PATH = (machineCode: string): string =>
    `/api/licenses/machine/${encodeURIComponent(machineCode)}/first-seen`;

/** C8 探测超时：启动路径上的旁路请求，比兑换（15s）短得多，拿不到就当「没见过」 */
export const MACHINE_PROBE_TIMEOUT_MS = 5000;

/** 单公钥文件名（客户心智中的「那一个特殊文件」，上线前替换它即可） */
export const PUBLIC_KEY_FILE_NAME = 'public.key';

/** 多 kid 公钥目录名（保留轮换扩展位） */
export const KEYS_DIR_NAME = 'keys';

/** 机器码落盘缓存文件名 */
export const MACHINE_CODE_CACHE_FILE = 'machine-code.cache';

/** 加密账本文件名 */
export const VAULT_FILE_NAME = 'license-vault.json';

/**
 * vault 外高水位锚文件名（plan-2.7 的 R2）：与 vault 同目录、不同文件，
 * 付费态单调下界的第二份记忆——只还原 vault 不还原锚文件，回拨复活失败。
 */
export const ANCHOR_FILE_NAME = 'license-anchor.json';

/**
 * AES-256-GCM 回退方案的应用盐（用于 `scryptSync` 派生密钥）。
 * **它不是安全边界**：本地无论如何加密都能被逆向，真正的安全边界是服务端 Ed25519 签名。
 * 它的作用只是让「直接读文件 + 复制文件」这两件事的成本不为零。
 */
export const VAULT_APP_SECRET = 'ai-tools::license-vault::v1';

/** 硬件因子分隔符：用多字符分隔符避免因子自身含单字符分隔符时串位 */
export const FACTOR_SEPARATOR = '~|~';

/** Windows 主路径：一次 PowerShell 拿全 4 因子，实测约 3.1s */
export const PS_COLLECT_TIMEOUT_MS = 8000;

/** macOS / Linux 采集超时 */
export const POSIX_COLLECT_TIMEOUT_MS = 5000;

/** 单条回退命令（wmic / reg / sysctl 等）超时 */
export const FALLBACK_CMD_TIMEOUT_MS = 3000;

/** 窗口 ready 后多久触发后台惰性复核 */
export const BACKGROUND_RECHECK_DELAY_MS = 2000;

/** 2 小时时钟容差：DST 最多 ±1h、NTP 校正秒级，2h 足够宽容 */
export const DEFAULT_CLOCK_SKEW_MS = 2 * 60 * 60 * 1000;

/** 默认配置：包外配置缺失或字段非法时的兜底值（**占位**，上线前通过包外配置覆盖） */
export const DEFAULT_LICENSE_CONFIG: LicenseConfig = {
    version: 1,
    enabled: true,
    killSwitch: false,
    sku: PRODUCT_SKU,
    // 接受的 SKU 与「SKU → gate 权益键」映射：可由包外配置覆盖（服务端新增档位无需重新发版）
    acceptedSkus: [...ACCEPTED_SKUS],
    skuFeatures: SKU_FEATURES,
    defaultKid: DEFAULT_KID,
    // billing-license-service 服务地址：收银台页（在线激活跳转）与兑换 API（兑换码激活）都由它
    // 派生（CHECKOUT_PAGE_PATH / REDEEM_API_PATH），一处配置即与后台服务对应。
    // 默认指向本地服务（默认端口 8000）；生产域名由包外 license.config.json 覆盖，无需发版
    serviceBaseUrl: 'http://localhost:8000',
    redeemTimeoutMs: 15000,
    trial: {
        days: 60,
        // 2026-09-17 客户拍板：启动次数不限，只记录不拦截，避免误伤重度用户
        maxRuns: null,
    },
    clock: {
        skewToleranceMs: DEFAULT_CLOCK_SKEW_MS,
        useServerTimeFloor: true,
    },
    grace: {
        hardwareChangeDays: 7,
        maxAutoGrace: 1,
    },
    features: {
        proFeature: FEATURE_PRO,
        // 本期只 gate 云同步（远程 SSH/SFTP 是云同步的一个 provider，与其合并计费，见 FEATURE_REMOTE_CONNECT 注释）。
        // R1 fail-closed（plan-2.7）：不在此名单（且非 proFeature、非 provider 派生）的权益键一律拒绝，
        // 新增付费功能漏配会「误锁」而不是「误放」——上线后调整售卖策略改包外配置即可。
        gated: [FEATURE_CLOUD_SYNC],
    },
};
