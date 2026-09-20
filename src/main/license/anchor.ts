/**
 * vault 外高水位锚（main 进程，plan-2.7 的 R2）
 *
 * 背景：付费态的单调时钟（watermark / server_time_floor）都写在 vault 里。「备份到期前的
 * vault + 系统时间回拨」能把三处下界一起还原成过期前的低值，让已过期的订阅复活。
 *
 * 本模块把一份**只增不减**的高水位写在 vault 之外的独立文件里（同目录不同文件名）：
 * 只还原 vault 不还原锚文件，`effectiveNow` 的 max 链会取到锚里的高水位，复活失败。
 *
 * **边界声明（诚实口径）**：这是本地锚定，抬高攻击成本，不是绝对防御——
 * 攻击者把整个 `.ai-tools` 目录一起备份还原仍可绕过；彻底防御需要服务端在线锚，
 * 而客户端激活后与服务器零接触（仅 redeem / 试用首见探测），暂无在线通道。
 *
 * 失败路径全部退化：文件缺失 / 结构非法 → 当作没有锚（不阻断）；写失败 → 只记日志。
 * 文件里只有一个毫秒时间戳，非机密，不加密。
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {writeFileAtomic} from '../config/settings-store';
import {AI_TOOLS_DIR_NAME, ANCHOR_FILE_NAME} from './constants';
import {logLicenseEvent} from './errors';
import {LICENSE_WATERMARK_STEP_MS} from './trial';

/** 锚文件落盘结构 */
interface AnchorFile {
    v: 1;
    /** 高水位（ms），只增不减 */
    floor: number;
}

function anchorPath(): string {
    return path.join(os.homedir(), AI_TOOLS_DIR_NAME, ANCHOR_FILE_NAME);
}

/** 读锚下界；文件缺失 / 结构非法 / 值非法 → null（视为没有锚，绝不阻断） */
export async function readAnchorFloor(): Promise<number | null> {
    let content: string;
    try {
        content = await fs.readFile(anchorPath(), 'utf-8');
    } catch {
        return null;
    }
    try {
        const file = JSON.parse(content) as AnchorFile;
        if (file?.v !== 1 || typeof file.floor !== 'number' || !Number.isFinite(file.floor) || file.floor <= 0) {
            logLicenseEvent('LIC_VAULT_TAMPERED', {event: 'anchor_invalid'});
            return null;
        }
        return file.floor;
    } catch {
        logLicenseEvent('LIC_VAULT_TAMPERED', {event: 'anchor_json_invalid'});
        return null;
    }
}

/**
 * 推进锚高水位（只增不减）。与付费水印同用 60s 步进节流：无需推进时返回 false 且不落盘。
 */
export async function raiseAnchorFloor(targetMs: number): Promise<boolean> {
    const current = (await readAnchorFloor()) ?? 0;
    if (targetMs <= current + LICENSE_WATERMARK_STEP_MS) return false;
    try {
        const file: AnchorFile = {v: 1, floor: targetMs};
        await writeFileAtomic(anchorPath(), JSON.stringify(file));
        return true;
    } catch (error) {
        logLicenseEvent('LIC_INTERNAL', {event: 'anchor_write_failed', reason: (error as Error).name});
        return false;
    }
}
