/**
 * 编译期 build flag 契约（main / preload / renderer 三端唯一来源）
 *
 * 这里定义的值是「构建产物形态」而非「配置」：由打包命令经环境变量注入
 * （`scripts/gen-build-flags.mjs` 写 `dist/build-flags.json` 供主进程读取，
 * `vite.config.mts` 的 `define` 内联进 renderer），运行时不可变。
 *
 * 产品形态（共 2 个安装包，「激活版」是免费版1 的运行时状态而非第三个包）：
 * - free1：功能完整（含云同步入口）+ 广告（按 adRegion 选渠道；激活后广告消失）
 * - free2：无广告 + 云同步入口默认关闭（激活后是否解锁由 cloudSyncActivationUnlocks 决定）
 *
 * 回滚语义：未注入任何 flag 时等价于「免费版1-cn 全功能」（DEFAULT_BUILD_FLAGS），
 * 与历史行为一致。
 */

/** 产品版本形态 */
export type BuildEdition = 'free1' | 'free2';

/** 广告地区（编译期区分渠道，不做运行时网络探测） */
export type AdRegion = 'overseas' | 'cn';

/** 激活状态（与 shared/activation-types.ts 的 ActivationStatus 同义，此处自包含避免反向依赖） */
export type BuildActivationStatus = 'inactive' | 'trial' | 'activated';

/**
 * 打包命令传入的原始形态（env / JSON 均为字符串或空），归一化统一走 resolveBuildFlags，
 * 保证 env 侧（脚本）与 JSON 侧（运行时）的解析逻辑单点。
 */
export interface BuildFlagsInput {
    edition?: string | boolean | number | null;
    adRegion?: string | boolean | number | null;
    /** 开关类可用 '0'/'1'/'true'/'false'/布尔/数字；缺省由 edition 推导 */
    adsEnabled?: string | boolean | number | null;
    cloudSyncEnabled?: string | boolean | number | null;
    cloudSyncActivationUnlocks?: string | boolean | number | null;
}

export interface BuildFlags {
    edition: BuildEdition;
    adRegion: AdRegion;
    adsEnabled: boolean;
    cloudSyncEnabled: boolean;
    /** true=免费版2 激活（拥有 cloud_sync 权益）后解锁云同步；false=编译期硬砍，对激活用户也关闭 */
    cloudSyncActivationUnlocks: boolean;
}

export const DEFAULT_BUILD_FLAGS: BuildFlags = {
    edition: 'free1',
    adRegion: 'cn',
    adsEnabled: true,
    cloudSyncEnabled: true,
    cloudSyncActivationUnlocks: true,
};

const EDITIONS: readonly BuildEdition[] = ['free1', 'free2'];
const REGIONS: readonly AdRegion[] = ['overseas', 'cn'];

/** env/JSON 布尔字面量归一：'1'/'true'/1/true 为真，其余（含空/缺失）为假 */
function toBool(value: string | boolean | number | null | undefined): boolean {
    if (value === true || value === 1) return true;
    if (typeof value === 'string') {
        const v = value.trim().toLowerCase();
        return v === '1' || v === 'true';
    }
    return false;
}

/** 缺失（null/undefined/空串）判定——显式空值等同未传，走 edition 推导 */
function isMissing(value: string | boolean | number | null | undefined): boolean {
    return value === null || value === undefined || value === '';
}

/**
 * 把原始输入归一化为完整 BuildFlags：
 * - 非法枚举值回退默认（fail-safe：错误配置宁多变体回退，不出半残产物）；
 * - 开关缺省由 edition 推导（free1=全功能+广告；free2=无广告+云同步入口关）；
 * - free2 强制无广告（即使显式传 adsEnabled=1 也压掉：免费版2 任何状态下不出广告）。
 */
export function resolveBuildFlags(input: BuildFlagsInput | null | undefined): BuildFlags {
    const raw = input ?? {};
    const edition: BuildEdition = EDITIONS.includes(raw.edition as BuildEdition)
        ? (raw.edition as BuildEdition)
        : DEFAULT_BUILD_FLAGS.edition;
    const adRegion: AdRegion = REGIONS.includes(raw.adRegion as AdRegion)
        ? (raw.adRegion as AdRegion)
        : DEFAULT_BUILD_FLAGS.adRegion;

    const adsEnabled = edition === 'free2'
        ? false
        : (isMissing(raw.adsEnabled) ? true : toBool(raw.adsEnabled));
    const cloudSyncEnabled = edition === 'free2'
        ? (isMissing(raw.cloudSyncEnabled) ? false : toBool(raw.cloudSyncEnabled))
        : (isMissing(raw.cloudSyncEnabled) ? true : toBool(raw.cloudSyncEnabled));
    const cloudSyncActivationUnlocks = isMissing(raw.cloudSyncActivationUnlocks)
        ? DEFAULT_BUILD_FLAGS.cloudSyncActivationUnlocks
        : toBool(raw.cloudSyncActivationUnlocks);

    return {edition, adRegion, adsEnabled, cloudSyncEnabled, cloudSyncActivationUnlocks};
}

/** 广告显隐总判据：仅免费版1 且未激活展示（激活即消失，与渠道无关） */
export function shouldShowAds(flags: BuildFlags, status: BuildActivationStatus): boolean {
    return flags.adsEnabled && flags.edition === 'free1' && status === 'inactive';
}

/** 免费版2「编译期硬砍」模式：云同步对任何用户（含激活）都不可用 */
export function cloudSyncHardDisabled(flags: BuildFlags): boolean {
    return !flags.cloudSyncEnabled && !flags.cloudSyncActivationUnlocks;
}
