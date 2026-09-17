/**
 * 激活状态持久化与管理（主进程）
 *
 * 状态存于 ~/.ai-tools/activation.json，复用 settings-store 的原子写/加载辅助。
 *
 * 首次安装判定：基于「两处分开的安装标记文件」（位于不同系统目录），
 *   - 两处标记均缺失 → 视为「首次安装」：自动激活 60 天试用，并落盘两处标记；
 *   - 任一标记存在（即使 activation.json 被删）→ 视为「非首次」：不自动发放试用，
 *     回到未激活，从而防止「只删 activation.json 一个文件」就重置试用。
 * 读取时自动做到期降级（试用 / 激活过期 → 未激活）并落盘，保证持久状态一致。
 *
 * 离线激活码采用本地签名校验：机器码经内置密钥派生「应得激活码」并比对；
 * 算法集中在此文件，后续可平滑替换为服务端签发。
 */

import os from 'os';
import fs from 'fs';
import path from 'path';
import {createHmac} from 'crypto';
import {loadUserSettingsFile, writeFileAtomic} from './config/settings-store';
import type {ActivationResult, ActivationState} from '../shared/activation-types';

const TRIAL_DAYS = 60;
const FILE = path.join(os.homedir(), '.ai-tools', 'activation.json');

/** 本地派生激活码的密钥（占位；上线后改为服务端签发并移除此密钥） */
const ACTIVATION_SECRET = 'AI-TOOLS-LOCAL-SECRET-v1';

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
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, stamp);
        } catch {
            // 单处写入失败不阻塞主流程
        }
    }
}

function inactiveState(): ActivationState {
    return {
        status: 'inactive',
        trialExpiresAt: null,
        activatedExpiresAt: null,
        activatedAt: null,
        machineCode: null,
    };
}

function defaultState(): ActivationState {
    const now = Date.now();
    return {
        status: 'trial',
        trialExpiresAt: now + TRIAL_DAYS * 86400000,
        activatedExpiresAt: null,
        activatedAt: null,
        machineCode: null,
    };
}

/** 到期降级：试用 / 激活过期则回退未激活 */
function normalize(s: ActivationState): ActivationState {
    const now = Date.now();
    if (s.status === 'trial' || s.status === 'activated') {
        const exp = s.status === 'trial' ? s.trialExpiresAt : s.activatedExpiresAt;
        if (exp && now > exp) return inactiveState();
    }
    return s;
}

async function load(): Promise<ActivationState> {
    const raw = (await loadUserSettingsFile(FILE)) as unknown as Partial<ActivationState> | undefined;
    if (raw && Object.keys(raw).length > 0) {
        return normalize({ ...defaultState(), ...raw });
    }
    // activation.json 不存在：依据两处安装标记判定是否首次安装
    if (isFirstInstall()) {
        const s = defaultState(); // 首次安装：自动激活 60 天试用
        await save(s);
        ensureMarkers();
        return s;
    }
    // 非首次（标记存在但 activation.json 丢失）：不自动发放试用，回到未激活
    const s = inactiveState();
    await save(s);
    return s;
}

async function save(s: ActivationState): Promise<void> {
    await writeFileAtomic(FILE, JSON.stringify(s, null, 2));
}

/** 读取当前状态（顺带做到期降级并持久化） */
export async function getActivationState(): Promise<ActivationState> {
    const s = await load();
    const n = normalize(s);
    if (n !== s) await save(n);
    return n;
}

/** 由机器码派生「应得激活码」（本地校验用，占位） */
export function deriveActivationCode(machineCode: string): string {
    const h = createHmac('sha256', ACTIVATION_SECRET).update(machineCode).digest('hex').toUpperCase();
    const code = h.slice(0, 16);
    return code.replace(/(.{4})/g, '$1-').replace(/-$/, '');
}

/** 离线激活：校验激活码是否与机器码匹配 */
export async function offlineActivate(
    machineCode: string,
    code: string
): Promise<ActivationResult & { state?: ActivationState }> {
    const given = (code || '').replace(/-/g, '').toUpperCase();
    if (!given) return { success: false, error: '激活码不能为空' };
    const expected = deriveActivationCode(machineCode).replace(/-/g, '');
    if (given !== expected) return { success: false, error: '激活码与机器码不匹配' };
    const state: ActivationState = {
        status: 'activated',
        trialExpiresAt: null,
        activatedExpiresAt: null, // 永久激活
        activatedAt: Date.now(),
        machineCode,
    };
    await save(state);
    return { success: true, state };
}

/** 去激活：回到未激活 */
export async function deactivate(): Promise<ActivationState> {
    const s = inactiveState();
    await save(s);
    return s;
}
