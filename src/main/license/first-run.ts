/**
 * 首跑账本（main 进程，授权子域内部模块）
 *
 * **为什么需要它**：试用起点原本只存在 vault 里，而 vault 恰恰是最容易「没了」的那一份
 * （用户清数据、safeStorage 解密失败、拷用户目录到新机器……）。一旦 vault 空了，
 * 门面就只能返回 `inactive`，用户永久拿不到试用也说不清原因。
 * 本模块在 **vault 之外**另存一份「本机第一次运行的时间」，让门面在 vault 缺失时
 * 能**按原始起点重建**试用账本：既发得出试用，又不会因为删档多拿 60 天。
 *
 * **为什么是两个文件、两个系统目录**：单一路径的清理动作（删 `~/.ai-tools`、清 AppData）
 * 无法同时抹掉两者，这是客户端在「无服务端绑定」前提下能拿到的最好持久化信号。
 * 文件名**沿用旧版安装标记**（`~/.ai-tools-install` 等），保证老用户升级后仍被认出。
 *
 * **格式兼容**：旧版写的是纯 ISO 时间戳，新版写 `{v:1, first_run_at}`；读取两者都认。
 * 若只认新版格式，老用户会被误判成「首次运行」从而白拿一轮试用。
 *
 * 注意：本地没有可信执行环境，**删掉两个账本文件 = 等价于重装**，这是客户端方案的既有下限；
 * 真正的滥用防线是服务端签发与吊销，见 `doc/plan-2.4.md` TODOS。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

/** 落盘结构 */
interface FirstRunLedger {
    v: 1;
    /** 首次运行时间（ms） */
    first_run_at: number;
}

/**
 * 两处账本文件路径（根目录不同，提高「删单文件重置试用」的成本）。
 * - win32：用户目录（%USERPROFILE%）+ AppData\Roaming 下各一处
 * - darwin：~/Library/Application Support + ~/Library/Caches
 * - linux/其他：~/.config + ~/.local/share
 */
function ledgerPaths(): [string, string] {
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

/** 解析单个账本文件内容：新版 JSON / 旧版纯 ISO 时间戳；无法解析返回 null */
function parseFirstRun(content: string): number | null {
    const text = content.trim();
    if (!text) return null;
    if (text.startsWith('{')) {
        try {
            const raw = JSON.parse(text) as {first_run_at?: unknown};
            const at = raw.first_run_at;
            return typeof at === 'number' && Number.isFinite(at) ? at : null;
        } catch {
            return null;
        }
    }
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? ms : null;
}

/**
 * 读首跑时间：取**两处中最早**的合法值（最早 = 剩余试用最少，fail-closed）。
 * 两处都不存在或都不合法 → null（视为从未运行过）。
 */
export function readFirstRunAt(): number | null {
    const times: number[] = [];
    for (const p of ledgerPaths()) {
        try {
            const at = parseFirstRun(fs.readFileSync(p, 'utf-8'));
            if (at !== null) times.push(at);
        } catch {
            // 读不到（无权限 / 文件缺失）当这处没有账本，不影响另一处
        }
    }
    return times.length > 0 ? Math.min(...times) : null;
}

/**
 * 写首跑账本（幂等）：已有合法值则**沿用原值**并顺带规范化成新版 JSON；
 * 没有则写入 `nowMs`。存在于未来的账本值会被 `nowMs` 收敛（防止手改/时钟异常留下高值）。
 * 单处写入失败不阻塞主流程。
 */
export function writeFirstRun(nowMs: number): void {
    const existing = readFirstRunAt();
    const at = existing === null ? nowMs : Math.min(existing, nowMs);
    const ledger: FirstRunLedger = {v: 1, first_run_at: at};
    const body = JSON.stringify(ledger);
    for (const p of ledgerPaths()) {
        try {
            fs.mkdirSync(path.dirname(p), {recursive: true});
            fs.writeFileSync(p, body);
        } catch {
            // 单处失败不阻塞：另一处仍能保住起点
        }
    }
}
