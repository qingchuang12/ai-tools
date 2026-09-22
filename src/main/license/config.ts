/**
 * 授权配置加载（双源：包外 → asar 内置 → 代码默认）
 *
 * 双源的意义：收银台 URL / redeem 地址 / gate 名单 / 应急开关在打包后仍可运维调整，
 * 只改 `<install>/resources/license/license.config.json` 即可，**不需要重新发版**。
 *
 * ⚠️ 开发期（`app.isPackaged === false`）`process.resourcesPath` 指向 **Electron 自身的资源目录**
 * （只读、且不含本项目文件），因此**必须**走 `__dirname/assets` 分支，否则开发期永远读不到配置。
 */

import {app} from 'electron';
import fs from 'fs';
import path from 'path';
import {ASSETS_DIR_NAME, CONFIG_FILE_NAME, DEFAULT_LICENSE_CONFIG, EXTERNAL_LICENSE_DIR_NAME,} from './constants';
import type {LicenseConfig} from './types';
import {logLicenseEvent} from './errors';

/** main 产物是 CommonJS，`__dirname` 可用；单测运行在 ESM 下时回退到 cwd（此时配置由测试注入） */
function currentDir(): string {
    return typeof __dirname === 'string' ? __dirname : process.cwd();
}

/** 包外可替换目录（打包后 resources/license；开发期回退 asar 同路径） */
export function resolveExternalLicenseDir(): string {
    try {
        if (app && app.isPackaged && process.resourcesPath) {
            return path.join(process.resourcesPath, EXTERNAL_LICENSE_DIR_NAME);
        }
    } catch {
        // app 在 before-ready 阶段访问部分属性会抛错，走开发期分支即可
    }
    return path.join(currentDir(), ASSETS_DIR_NAME);
}

/** asar 内置资产目录（回落源） */
export function resolveAsarAssetsDir(): string {
    return path.join(currentDir(), ASSETS_DIR_NAME);
}

function readJsonFile(file: string): unknown {
    try {
        if (!fs.existsSync(file)) return null;
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (error) {
        logLicenseEvent('LIC_INTERNAL', {
            event: 'config_parse_failed',
            file: path.basename(file),
            reason: (error as Error).name,
        });
        return null;
    }
}

function asRecord(v: unknown): Record<string, unknown> | null {
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown, fallback: string): string {
    return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
    return typeof v === 'boolean' ? v : fallback;
}

function num(v: unknown, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function strArray(v: unknown, fallback: string[]): string[] {
    if (!Array.isArray(v)) return [...fallback];
    const out = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
    return out.length > 0 ? out : [...fallback];
}

/** 深拷贝 SKU→权益 映射（避免调用方改到共享常量里的数组） */
function cloneSkuFeatures(src: Record<string, string[]>): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [sku, features] of Object.entries(src)) out[sku] = [...features];
    return out;
}

/** 深拷贝默认配置，避免调用方改到 DEFAULT_LICENSE_CONFIG 本身 */
function cloneDefault(): LicenseConfig {
    const d = DEFAULT_LICENSE_CONFIG;
    return {
        version: 1,
        sku: d.sku,
        acceptedSkus: [...d.acceptedSkus],
        skuFeatures: cloneSkuFeatures(d.skuFeatures),
        defaultKid: d.defaultKid,
        serviceBaseUrl: d.serviceBaseUrl,
        redeemTimeoutMs: d.redeemTimeoutMs,
        trial: {...d.trial},
        clock: {...d.clock},
        grace: {...d.grace},
        features: {proFeature: d.features.proFeature, gated: [...d.features.gated]},
    };
}

/**
 * 字段级兜底：包外配置可以只写关心的字段，且**非法值一律回落默认**，
 * 避免手改配置把「试用天数」写成字符串导致整个授权流程崩掉。
 */
export function mergeConfig(raw: unknown): LicenseConfig {
    const base = cloneDefault();
    const src = asRecord(raw);
    if (!src) return base;

    base.sku = str(src.sku, base.sku);
    base.acceptedSkus = strArray(src.acceptedSkus, base.acceptedSkus);
    // skuFeatures 是「整表覆盖」语义：包外只写关心的 SKU 即可，写错的条目直接丢弃；
    // 全表解析失败则沿用默认（避免手改配置把功能解锁整片清空）。
    const skuFeatures = asRecord(src.skuFeatures);
    if (skuFeatures) {
        const parsed: Record<string, string[]> = {};
        for (const [sku, value] of Object.entries(skuFeatures)) {
            const features = strArray(value, []);
            if (sku.trim() && features.length > 0) parsed[sku.trim()] = features;
        }
        if (Object.keys(parsed).length > 0) base.skuFeatures = parsed;
    }
    base.defaultKid = str(src.defaultKid, base.defaultKid);
    // 服务地址归一：去掉结尾 `/`，避免与契约路径拼接出 `//api/...` 双斜杠
    base.serviceBaseUrl = str(src.serviceBaseUrl, base.serviceBaseUrl).replace(/\/+$/, '');
    base.redeemTimeoutMs = Math.max(1000, num(src.redeemTimeoutMs, base.redeemTimeoutMs));

    const trial = asRecord(src.trial);
    if (trial) {
        base.trial.days = Math.max(0, Math.floor(num(trial.days, base.trial.days)));
        // maxRuns: null = 不限；非正整数也按「不限」处理（配置写错不该变成「一次都不让用」）
        const mr = trial.maxRuns;
        base.trial.maxRuns = typeof mr === 'number' && Number.isFinite(mr) && mr > 0 ? Math.floor(mr) : null;
    }

    const clock = asRecord(src.clock);
    if (clock) {
        base.clock.skewToleranceMs = Math.max(0, Math.floor(num(clock.skewToleranceMs, base.clock.skewToleranceMs)));
        base.clock.useServerTimeFloor = bool(clock.useServerTimeFloor, base.clock.useServerTimeFloor);
    }

    const grace = asRecord(src.grace);
    if (grace) {
        base.grace.hardwareChangeDays = Math.max(0, Math.floor(num(grace.hardwareChangeDays, base.grace.hardwareChangeDays)));
        base.grace.maxAutoGrace = Math.max(0, Math.floor(num(grace.maxAutoGrace, base.grace.maxAutoGrace)));
    }

    const features = asRecord(src.features);
    if (features) {
        base.features.proFeature = str(features.proFeature, base.features.proFeature);
        base.features.gated = strArray(features.gated, base.features.gated);
    }
    return base;
}

let cached: LicenseConfig | null = null;

/** 读取配置（包外优先 → asar 内置 → 代码默认），结果进程内缓存 */
export function loadConfig(): LicenseConfig {
    const external = path.join(resolveExternalLicenseDir(), CONFIG_FILE_NAME);
    let raw = readJsonFile(external);
    if (raw === null) {
        raw = readJsonFile(path.join(resolveAsarAssetsDir(), CONFIG_FILE_NAME));
    }
    return mergeConfig(raw);
}

/** 获取配置（缓存）。测试与运维热重载可先调 `resetConfigCache()` */
export function getConfig(): LicenseConfig {
    if (!cached) cached = loadConfig();
    return cached;
}

/** 清缓存（包外配置被替换后可重新加载） */
export function resetConfigCache(): void {
    cached = null;
}
