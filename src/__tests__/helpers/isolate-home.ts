/**
 * 测试专用的「用户目录」沙箱（plan-1.0 / F15）。
 *
 * 主进程解析「用户目录」有**多处入口**，只 spy `os.homedir()` 拦不全：
 * - `first-run.ts` 的第二处账本（win32 的 `.install-marker`）走 `process.env.APPDATA`，
 *   与 homedir 无关——不隔离它就会读写开发者真实的 `%APPDATA%\ai-tools`，
 *   用例结果随真实机器上「这台机器装过没有」漂移，且污染真实激活数据。
 * - vault / 锚 / 账本第一处落点走 `os.homedir()`。
 *
 * 本 helper 把 homedir + APPDATA/LOCALAPPDATA + HOME/XDG_CONFIG_HOME 一并指向一次性临时目录，
 * 并在 `arm()` 里支持「afterEach 的 restoreAllMocks() 还原 homedir 后、beforeEach 再接管」的复用节奏。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import {vi} from 'vitest';

export interface HomeSandbox {
    /** 临时家目录绝对路径（供用例拼 vault / 锚文件路径） */
    home: string;
    /** win32 的 APPDATA 落点（= home/AppData/Roaming） */
    appData: string;
    /**
     * (重新) 接管 os.homedir 与相关环境变量。
     * 顶层调用一次；若用例在 afterEach 里 `vi.restoreAllMocks()` 还原了 homedir，
     * 需在 beforeEach 再调一次。环境变量只在首次 arm 时快照原值，重复 arm 幂等。
     */
    arm: () => void;
    /** 还原 homedir spy 与全部环境变量，并删除临时目录（放 afterAll / afterEach） */
    cleanup: () => void;
    /** 清空临时目录内容做跨用例复位，不删目录本身（供需要 wipe 的测试复用） */
    wipe: () => void;
}

const ENV_KEYS = ['APPDATA', 'LOCALAPPDATA', 'HOME', 'XDG_CONFIG_HOME'] as const;

export function createHomeSandbox(mocks: {home: string}, prefix = 'ai-tools-home-'): HomeSandbox {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    mocks.home = home;
    const appData = path.join(home, 'AppData', 'Roaming');
    const localAppData = path.join(home, 'AppData', 'Local');
    const saved = new Map<(typeof ENV_KEYS)[number], string | undefined>();
    let armed = false;

    const arm = (): void => {
        fs.mkdirSync(appData, {recursive: true});
        fs.mkdirSync(localAppData, {recursive: true});
        vi.spyOn(os, 'homedir').mockImplementation(() => mocks.home);
        if (!armed) {
            for (const key of ENV_KEYS) saved.set(key, process.env[key]);
            armed = true;
        }
        process.env.APPDATA = appData;
        process.env.LOCALAPPDATA = localAppData;
        process.env.HOME = home;
        process.env.XDG_CONFIG_HOME = path.join(home, '.config');
    };

    const cleanup = (): void => {
        (os.homedir as unknown as {mockRestore?: () => void}).mockRestore?.();
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        fs.rmSync(home, {recursive: true, force: true});
    };

    const wipe = (): void => {
        for (const entry of fs.readdirSync(home)) {
            fs.rmSync(path.join(home, entry), {recursive: true, force: true});
        }
    };

    arm();
    return {home, appData, arm, cleanup, wipe};
}
