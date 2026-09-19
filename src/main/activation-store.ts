/**
 * 激活状态持久化（主进程）
 *
 * **职责分工（重要）**：
 * - `~/.ai-tools/activation.json`     = **状态**（明文，UI 直接读，不含任何秘密）
 * - `~/.ai-tools/license-vault.json`  = **秘密**（加密：signed token + 试用账本，见 `license/vault.ts`）
 * 两者不一致时**以 vault 为准**并回写 activation.json。
 *
 * 本文件只保留两件事：**状态读** 与 **状态落盘**；
 * 状态判定（验签 / 试用双限 / 硬件宽限 / 发试用）全部委托 `src/main/license/index.ts` 门面。
 *
 * 试用发放的防重置信号（首跑账本：两处分开、位于不同系统目录）也一并下沉到
 * `src/main/license/first-run.ts`：发试用是授权域的职责，且必须与门面的状态判定同源，
 * 否则就会出现「标记在、账本没了」这类判定割裂（历史上表现为永久 inactive 且不自愈）。
 */

import os from 'os';
import path from 'path';
import {loadUserSettingsFile, writeFileAtomic} from './config/settings-store';
import type {ActivationState, ActivationStatus} from '../shared/activation-types';
import * as license from './license';

const FILE = path.join(os.homedir(), '.ai-tools', 'activation.json');

const VALID_STATUS: ActivationStatus[] = ['inactive', 'trial', 'activated'];

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
 *
 * 发试用也在门面内完成：语义是「从未激活过 → 进入试用」，不看 activation.json 是否存在，
 * 因此「升级遗留的 activation.json / 安装标记与 vault 不一致」不会再导致永久 inactive。
 */
export async function getActivationState(): Promise<ActivationState> {
    const persisted = await load();
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
