/**
 * 激活状态持久化（主进程）
 *
 * **职责分工（重要）**：
 * - `~/.ai-tools/activation.json`     = **状态**（明文，UI 直接读，不含任何秘密）
 * - `~/.ai-tools/license-vault.json`  = **秘密**（加密：signed token + 试用账本，见 `license/vault.ts`）
 * 两者不一致时**以 vault 为准**并回写 activation.json。
 *
 * 本文件只保留两件事：**状态落盘** 与 **双安装标记判定**；
 * 状态判定（验签 / 试用双限 / 硬件宽限）全部委托 `src/main/license/index.ts` 门面。
 *
 * 首次安装判定：基于「两处分开的安装标记文件」（位于不同系统目录）
 *   - 两处标记均缺失 → 视为「首次安装」：发试用（天数由配置决定，默认 60 天），并落盘两处标记；
 *   - 任一标记存在（即使 activation.json 被删）→ 视为「非首次」：不发试用，
 *     从而防止「只删 activation.json 一个文件」就重置试用。
 */

import os from 'os';
import fs from 'fs';
import path from 'path';
import {loadUserSettingsFile, writeFileAtomic} from './config/settings-store';
import type {ActivationState, ActivationStatus} from '../shared/activation-types';
import * as license from './license';

const FILE = path.join(os.homedir(), '.ai-tools', 'activation.json');

const VALID_STATUS: ActivationStatus[] = ['inactive', 'trial', 'activated'];

/**
 * 两处安装标记文件路径（根目录不同，提高「删单文件重置试用」的成本）。
 * - win32：用户目录（%USERPROFILE%）+ AppData\Roaming 下各一处
 * - darwin：~/Library/Application Support + ~/Library/Caches（常用软件目录）
 * - linux/其他：~/.config + ~/.local/share
 */
function markerPaths(): [string, string] {
    const home = os.homedir();
    const platform = process.platform;
    if (platform === 'win32') {
        const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
        return [
            path.join(home, '.ai-tools-install'),
            path.join(appData, 'ai-tools', '.install-marker'),
        ];
    }
    if (platform === 'darwin') {
        return [
            path.join(home, 'Library', 'Application Support', 'ai-tools', '.install-marker'),
            path.join(home, 'Library', 'Caches', 'ai-tools', '.install-marker'),
        ];
    }
    return [
        path.join(home, '.config', 'ai-tools', '.install-marker'),
        path.join(home, '.local', 'share', 'ai-tools', '.install-marker'),
    ];
}

function markerExists(p: string): boolean {
    try {
        return fs.existsSync(p);
    } catch {
        return false;
    }
}

/** 两处标记均缺失 → 首次安装 */
function isFirstInstall(): boolean {
    const [a, b] = markerPaths();
    return !markerExists(a) && !markerExists(b);
}

/** 创建两处安装标记（幂等；忽略单处失败） */
function ensureMarkers(): void {
    const stamp = new Date().toISOString();
    for (const p of markerPaths()) {
        try {
            fs.mkdirSync(path.dirname(p), {recursive: true});
            fs.writeFileSync(p, stamp);
        } catch {
            // 单处写入失败不阻塞主流程
        }
    }
}

/** 读明文状态；缺失或结构非法返回 null（非法状态不应参与 legacy 判定） */
async function load(): Promise<ActivationState | null> {
    const raw = (await loadUserSettingsFile(FILE)) as unknown as Partial<ActivationState> | undefined;
    if (!raw || typeof raw !== 'object') return null;
    if (!VALID_STATUS.includes(raw.status as ActivationStatus)) return null;
    return {
        status: raw.status as ActivationStatus,
        trialStartsAt: typeof raw.trialStartsAt === 'number' ? raw.trialStartsAt : null,
        trialExpiresAt: typeof raw.trialExpiresAt === 'number' ? raw.trialExpiresAt : null,
        trialRunsLeft: typeof raw.trialRunsLeft === 'number' ? raw.trialRunsLeft : null,
        activatedExpiresAt: typeof raw.activatedExpiresAt === 'number' ? raw.activatedExpiresAt : null,
        activatedAt: typeof raw.activatedAt === 'number' ? raw.activatedAt : null,
        machineCode: typeof raw.machineCode === 'string' ? raw.machineCode : null,
        licenseKey: typeof raw.licenseKey === 'string' ? raw.licenseKey : null,
        sku: typeof raw.sku === 'string' ? raw.sku : null,
        features: Array.isArray(raw.features) ? raw.features.filter((f): f is string => typeof f === 'string') : [],
        source: raw.source === 'trial' || raw.source === 'license' ? raw.source : 'none',
        degraded: raw.degraded ?? null,
    };
}

async function save(state: ActivationState): Promise<void> {
    await writeFileAtomic(FILE, JSON.stringify(state, null, 2));
}

/**
 * 读取当前激活状态（顺带持久化门面算出的最新状态）。
 * 首次安装在此判定并发试用，随后状态判定与落盘全部交给门面。
 */
export async function getActivationState(): Promise<ActivationState> {
    const persisted = await load();
    if (!persisted && isFirstInstall()) {
        ensureMarkers();
        await license.grantTrialOnFirstInstall();
    }
    const state = await license.getState(persisted);
    await save(state);
    return state;
}

/** 去激活：只清授权 token，不重置试用 */
export async function deactivate(): Promise<ActivationState> {
    const state = await license.deactivate();
    await save(state);
    return state;
}
