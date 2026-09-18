/**
 * 授权相关共享常量（main / preload / renderer 三端唯一来源）
 *
 * 这里定义的值是「契约」而非「配置」：运行时可被包外 `license.config.json` 覆盖的
 * 部分（如收银台 URL、redeem 地址、gate 名单）以配置为准，但**键名与语义**必须来自本文件，
 * 三端不得各自定义字符串字面量，否则改一处漏两处。
 */

/** 产品 SKU：token 的 `sku` 声明必须与之一致，否则判 LIC_SKU_MISMATCH */
export const PRODUCT_SKU = 'AI-TOOLS-PRO';

/** 全量付费权益：拥有它即拥有所有付费功能（含 cloud_sync / remote_connect） */
export const FEATURE_PRO = 'pro';

/** 权益：云同步（本期被 gate 的功能之一） */
export const FEATURE_CLOUD_SYNC = 'cloud_sync';

/**
 * 权益：远程连接（SSH/SFTP）。
 *
 * **本期不挂钩任何 gate**：2026-09-17 客户拍板把远程 SSH/SFTP 与云同步**合并为同一个权益**——
 * 主进程没有独立的远程连接 IPC 入口，SSH/SFTP 只是云同步的一个 provider
 * （`CloudProvider = 'git' | 'sftp'`），共用 `cloud-sync:*` 通道，因此按 `cloud_sync` 计费即可。
 * 常量保留，供未来若出现「独立于云同步的远程功能」时使用（届时加进 `config.features.gated`）。
 */
export const FEATURE_REMOTE_CONNECT = 'remote_connect';

/** 默认公钥 id（kid ↔ 公钥文件名映射，轮换时新增新 kid 并保留旧文件） */
export const DEFAULT_KID = 'default';

/** 机器码展示格式：16 位大写十六进制分 4 组，形如 XXXX-XXXX-XXXX-XXXX（无 AI- 前缀） */
export const MACHINE_ID_PATTERN = /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/;

/** 硬件因子缺失时的固定占位符：保证派生输入的维度固定，缺失不会改变其它因子的位置 */
export const MACHINE_ID_FACTOR_NA = 'NA';
