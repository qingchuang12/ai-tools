/**
 * 主进程 build flag 入口：读取构建期生成的 `dist/build-flags.json`（scripts/gen-build-flags.mjs
 * 注入），文件缺失（如未跑 gen 的 dev 场景）时回退默认值（免费版1-cn 全功能，等同历史行为）。
 *
 * 归一化逻辑单点在 shared/build-flags.ts，这里只负责定位文件与缓存。
 */

import fs from 'fs';
import path from 'path';
import type {BuildFlags} from '../shared/build-flags';
import {cloudSyncHardDisabled as hardDisabled, DEFAULT_BUILD_FLAGS, resolveBuildFlags} from '../shared/build-flags';

/** 云同步被编译期硬砍时，IPC 对外返回的 i18n key（渲染层 `t()` 翻译） */
export const CLOUD_SYNC_DISABLED_MESSAGE = 'cloudSync.errors.editionDisabled';

let cached: BuildFlags | null = null;

export function getBuildFlags(): BuildFlags {
    if (!cached) cached = loadBuildFlags();
    return cached;
}

function loadBuildFlags(): BuildFlags {
    try {
        // tsc 产物位于 dist/main，JSON 在 dist/；打包后随 `files: dist/**/*` 进 asar
        const file = path.join(__dirname, '..', 'build-flags.json');
        return resolveBuildFlags(JSON.parse(fs.readFileSync(file, 'utf-8')));
    } catch {
        return DEFAULT_BUILD_FLAGS;
    }
}

/** 免费版2 硬砍模式（cloudSyncActivationUnlocks=false）下，云同步链路整体短路 */
export function cloudSyncHardDisabled(): boolean {
    return hardDisabled(getBuildFlags());
}
