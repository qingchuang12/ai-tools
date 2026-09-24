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

/**
 * 统一激活端点路径：服务端 LicenseController 的 `POST /api/licenses/activate`（plan-7.0 方案 A）。
 * 取代旧的 `/api/redeem/redeem`；`credential` 传兑换码（RC- 前缀）或许可证密钥，由服务端自动识别。
 */
export const ACTIVATE_API_PATH = '/api/licenses/activate';

/**
 * R6：释放本机绑定（换绑场景）端点（服务端 AccountAssetController，需登录 + 本人归属）。
 * ⚠️ 旧端点 `/api/licenses/unbind` 已于 plan-7.0 / B10 **物理删除**（始终 403 不可达），
 * 故此处改指账号侧出口 `POST /api/account/licenses/{licenseKey}/unbind`（`unbindByOwner(licenseKey, currentUserId())`）。
 * 客户端须持有登录态 Bearer 令牌且 licenseKey 归属本人，否则 401/403。
 */
export const ACCOUNT_UNBIND_API_PATH = (licenseKey: string): string =>
    `/api/account/licenses/${encodeURIComponent(licenseKey)}/unbind`;

/** R6：解绑为 best-effort 旁路请求，用比兑换（15s）短的超时，避免换绑时主进程被拖死 */
export const UNBIND_API_TIMEOUT_MS = 8000;

// ==================== 账号体系端点（服务端 AccountController / AccountMfaController） ====================
// 契约见 billing-license-service `README.md`「账号」段与「二次因子登录校验」段。

/** 登录端点（公开）：`{email,password}` → AuthResponse */
export const LOGIN_API_PATH = '/api/account/login';

/** 第二因子校验端点（permitAll 半认证）：`{ticket,code}` → AuthResponse（真令牌） */
export const MFA_VERIFY_API_PATH = '/api/account/mfa/verify';

/** 当前用户端点（Bearer） */
export const ME_API_PATH = '/api/account/me';

/** 登出端点（Bearer）：tokenVersion+1 令该用户所有令牌失效 */
export const LOGOUT_API_PATH = '/api/account/logout';

/** 账号 accessToken 密文落点（secret-store 通用密文 id，复用 AES-256-GCM / safeStorage） */
export const ACCOUNT_ACCESS_TOKEN_SECRET_ID = 'account-access-token';

/** 各账号端点超时（均属交互/启动路径上的旁路请求，短于兑换 15s） */
export const LOGIN_TIMEOUT_MS = 15000;
export const MFA_VERIFY_TIMEOUT_MS = 15000;
export const ME_TIMEOUT_MS = 10000;
export const LOGOUT_TIMEOUT_MS = 8000;

/**
 * D2（plan-7.0 / A9）：客户端「自动上报绑定」端点（服务端 LicenseController，公开）。
 * 凭 signedToken 验签证明归属，无需登录；客户端兑换/激活后于启动时补报一次机器码完成绑定。
 */
export const REPORT_BINDING_API_PATH = '/api/licenses/report-binding';

/** D2：上报绑定为启动期旁路请求，用比兑换（15s）短的超时，避免拖慢启动 */
export const REPORT_BINDING_TIMEOUT_MS = 10000;

/**
 * A9（plan-7.0）：本账号名下授权列表端点（服务端 AccountAssetController，Bearer）。
 * 返回 `List<LicenseResponse>`（业务数组在 `$.data`，兼容扁平结构），字段见 `LicenseResponse.java`：
 * `licenseKey` / `status`(ACTIVE|EXPIRED|REVOKED|REISSUED) / `machineCode`(未绑定为 null) / `customerEmail` 等。
 */
export const MY_LICENSES_API_PATH = '/api/account/licenses';

/** A9：拉取本账号授权列表为登录后/启动旁路请求，超时短于兑换（15s） */
export const MY_LICENSES_TIMEOUT_MS = 10000;

/**
 * C8：机器码首次出现时间端点（服务端 MachineController，公开只读）。
 * 客户端首跑联网问一次，把试用起点回溯到服务端最早见到这台机器的时间。
 */
export const MACHINE_FIRST_SEEN_API_PATH = (machineCode: string): string =>
    `/api/licenses/machine/${encodeURIComponent(machineCode)}/first-seen`;

/** C8 探测超时：启动路径上的旁路请求，比兑换（15s）短得多，拿不到就当「没见过」 */
export const MACHINE_PROBE_TIMEOUT_MS = 5000;

// ==================== 定期联网复核（plan-7.0） ====================

/**
 * 复核端点（服务端 LicenseController，公开 permitAll、限流 60 次/分钟/IP）。
 * ⚠️ 是 **GET + licenseKey 路径参数**（不是 POST），且命中限流时返回 **429 且 body 为空**——
 * 故客户端必须先判 `response.status` 再 `response.json()`，否则 json() 抛异常会被误记成 BAD_RESPONSE。
 */
export const LICENSE_VERIFY_API_PATH = (licenseKey: string): string =>
    `/api/licenses/verify/${encodeURIComponent(licenseKey)}`;

/** 复核总开关默认值（包外可关，用于资损事故秒级回滚） */
export const DEFAULT_RECHECK_ENABLED = true;

/** 复核间隔默认 24h */
export const DEFAULT_RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 离线宽限默认 7 天：只覆盖「服务端答不上来」，服务端明确答吊销是立即停，不受宽限影响 */
export const DEFAULT_RECHECK_OFFLINE_GRACE_DAYS = 7;

/** 单次复核超时 8s：启动路径上的旁路请求，短于兑换（15s） */
export const DEFAULT_RECHECK_TIMEOUT_MS = 8000;

/** 命中 429 后退避 1h（429 照常累加宽限，免扣会让限流变成永久续命后门） */
export const DEFAULT_RECHECK_RATE_LIMITED_RETRY_MS = 60 * 60 * 1000;

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
    sku: PRODUCT_SKU,
    // 接受的 SKU 与「SKU → gate 权益键」映射：可由包外配置覆盖（服务端新增档位无需重新发版）
    acceptedSkus: [...ACCEPTED_SKUS],
    skuFeatures: SKU_FEATURES,
    defaultKid: DEFAULT_KID,
    // billing-license-service 服务地址：收银台页（在线激活跳转）与兑换 API（凭证激活）都由它
    // 派生（CHECKOUT_PAGE_PATH / ACTIVATE_API_PATH），一处配置即与后台服务对应。
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
    recheck: {
        enabled: DEFAULT_RECHECK_ENABLED,
        intervalMs: DEFAULT_RECHECK_INTERVAL_MS,
        offlineGraceDays: DEFAULT_RECHECK_OFFLINE_GRACE_DAYS,
        timeoutMs: DEFAULT_RECHECK_TIMEOUT_MS,
        rateLimitedRetryMs: DEFAULT_RECHECK_RATE_LIMITED_RETRY_MS,
    },
    features: {
        proFeature: FEATURE_PRO,
        // 本期只 gate 云同步（远程 SSH/SFTP 是云同步的一个 provider，与其合并计费，见 FEATURE_REMOTE_CONNECT 注释）。
        // R1 fail-closed（plan-2.7）：不在此名单（且非 proFeature、非 provider 派生）的权益键一律拒绝，
        // 新增付费功能漏配会「误锁」而不是「误放」——上线后调整售卖策略改包外配置即可。
        gated: [FEATURE_CLOUD_SYNC],
    },
};
