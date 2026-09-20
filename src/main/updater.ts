/**
 * 在线更新（electron-updater）封装。
 *
 * 只负责：初始化 autoUpdater、判定「本平台/本形态是否可自更」、把事件/状态广播到渲染层，
 * 以及接收渲染层的 check/download/quitAndInstall 动作。IPC 通道与窗口消息在 index.ts / preload 注册。
 *
 * 设计要点（plan-19.0）：
 * - 仅 Windows NSIS 安装版 与 Linux AppImage 走完整自更；其余（Windows portable、
 *   Linux deb、macOS 未签名）广播 `unsupported`，由渲染层引导「到官网手动下载」。
 * - `autoDownload=false`：检测到新版本后不自动下载，交用户点「下载并安装」。
 * - feed URL 来自打包时内嵌的 `app-update.yml`（由 electron-builder 在配置 build.publish 后生成）。
 * - 所有失败都归一为 `error` 状态广播，不抛异常、不阻断应用；渲染层仅提示可到官网手动下载。
 * - R3（plan-2.7）：订阅令牌的 `update_until` / `max_major_version` 软门控——检测与下载前
 *   都做权益校验，不在权益内的新版本广播 `locked`，不进入下载流程。
 */
import {app, BrowserWindow} from 'electron';
import {autoUpdater} from 'electron-updater';
import {currentPayload} from './license';
import {evaluateUpdateEntitlement} from './license/update-gate';

/** 更新状态（渲染层据此渲染按钮/进度）。 */
export type UpdateState =
    | 'idle'          // 未开始 / 未触发
    | 'checking'      // 正在检测
    | 'available'     // 有新版，等待用户决定是否下载
    | 'not-available' // 已是最新
    | 'downloading'   // 正在下载（percent 0-100）
    | 'downloaded'    // 下载完成，可重启安装
    | 'error'         // 检测/下载失败
    | 'locked'        // R3：订阅更新权益不含此版本（update_until 过期 / major 超限），软门控拦截
    | 'unsupported';  // 本平台/形态不支持自更（转官网手动下载）

/** 推给渲染层的更新事件载荷。 */
export interface UpdateEventPayload {
    state: UpdateState;
    /** 新版本号（available/downloaded 时有值）。 */
    version?: string;
    /** 下载进度 0-100（downloading 时有值）。 */
    percent?: number;
    /** 面向用户的提示（error / unsupported / locked 时的说明）。 */
    message?: string;
    /** 当前应用版本。 */
    currentVersion?: string;
    /** true = 非安装版形态（portable）等，降级提示转官网。 */
    unsupported?: boolean;
}

let lastPayload: UpdateEventPayload = {state: 'idle'};
/** 最近一次「有新版」的版本号：download 前二次校验软门控用 */
let lastAvailableVersion: string | null = null;

function currentVersion(): string {
    return app.getVersion() || '0.0.0';
}

/** 各状态对应给用户的默认文案（渲染层可自行覆盖）。 */
function messageOf(state: UpdateState, detail?: string): string {
    switch (state) {
        case 'checking':
            return '正在检查更新…';
        case 'not-available':
            return '当前已是最新版本。';
        case 'unsupported':
            return detail || '当前版本形态暂不支持自动更新，请前往官网手动下载最新版。';
        case 'error':
            return detail || '检查更新失败，请稍后重试或到官网手动下载。';
        case 'locked':
            return detail || '当前订阅的更新权益不含此版本，请续费升级或到官网手动下载。';
        default:
            return '';
    }
}

/**
 * R3 软门控：按当前会话载荷判定「更新到 version」是否在订阅更新权益内。
 * 放行返回 null；拦截返回 locked 事件载荷（含给用户的说明）。
 */
function gateVersion(version: string): UpdateEventPayload | null {
    const gate = evaluateUpdateEntitlement(currentPayload(), version, Date.now());
    if (gate.allowed) return null;
    const detail =
        gate.reason === 'major_not_included'
            ? '当前订阅档位不包含此大版本的更新，请升级套餐或到官网手动下载。'
            : '当前订阅的更新权益已到期，请续费或到官网手动下载。';
    return {state: 'locked', version, message: detail};
}

function broadcast(payload: UpdateEventPayload): void {
    lastPayload = {...payload, currentVersion: currentVersion()};
    for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('update:status', lastPayload);
    }
}

/** 当前形态是否支持 electron-updater 自更。 */
function canAutoUpdate(): {ok: boolean; message?: string} {
    if (!app.isPackaged) {
        return {ok: false, message: '开发模式不支持在线更新。'};
    }
    // Windows：仅 NSIS 安装版可自更；portable 单文件版不支持（electron-updater 内建判断）。
    if (process.platform === 'win32') {
        if (process.env.PORTABLE_EXECUTABLE_FILE) {
            return {ok: false, message: '便携版（portable）暂不支持自动更新，请使用安装版或到官网下载。'};
        }
        return {ok: true};
    }
    if (process.platform === 'linux') {
        if (!process.env.APPIMAGE) {
            return {ok: false, message: '仅 AppImage 形态支持自动更新，请到官网下载。'};
        }
        return {ok: true};
    }
    // macOS：未签名/未公证时 autoupdater 不可靠，本版本统一降级为官网下载。
    return {ok: false, message: 'macOS 版本请前往官网手动下载最新版。'};
}

let initialized = false;

/** 订阅 autoUpdater 事件并初始化默认行为；幂等，可多次调用。 */
export function initUpdater(): void {
    if (initialized) return;
    initialized = true;

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => {
        lastAvailableVersion = null;
        broadcast({state: 'checking'});
    });
    autoUpdater.on('update-available', info => {
        lastAvailableVersion = info.version;
        // R3：检测到新版本先过订阅更新权益软门控，拦截则不进入 available
        const locked = gateVersion(info.version);
        if (locked) {
            broadcast(locked);
            return;
        }
        broadcast({state: 'available', version: info.version});
    });
    autoUpdater.on('update-not-available', () => broadcast({state: 'not-available'}));
    autoUpdater.on('download-progress', p => broadcast({state: 'downloading', percent: p.percent}));
    autoUpdater.on('update-downloaded', info =>
        broadcast({state: 'downloaded', version: info.version})
    );
    autoUpdater.on('error', (err: Error) =>
        broadcast({state: 'error', message: err?.message || '更新过程出错'})
    );
}

/** 渲染层主动查询当前状态。 */
export function getUpdateStatus(): UpdateEventPayload {
    return lastPayload;
}

/** 触发一次检测；不支持自更的平台直接广播 unsupported 而不落 autoUpdater。 */
export function checkForUpdatesAndNotify(): void {
    const ok = canAutoUpdate();
    if (!ok.ok) {
        broadcast({state: 'unsupported', unsupported: true, message: ok.message});
        initUpdater(); // 仍完成初始化，保证后续手动检查可复用事件通道（虽不会命中）
        return;
    }
    initUpdater();
    try {
        void autoUpdater.checkForUpdates().catch((err: Error) => {
            broadcast({state: 'error', message: err?.message || '检查更新失败'});
        });
    } catch (err) {
        broadcast({state: 'error', message: (err as Error)?.message || '检查更新失败'});
    }
}

/** 渲染层发起下载（仅 available 之后）。 */
export function downloadUpdateAndInstall(): void {
    if (!canAutoUpdate().ok) return;
    initUpdater();
    // R3：下载前二次校验（防检测后权益状态变化，如刚过期）
    const version = lastAvailableVersion;
    if (version) {
        const locked = gateVersion(version);
        if (locked) {
            broadcast(locked);
            return;
        }
    }
    try {
        void autoUpdater.downloadUpdate().catch((err: Error) => {
            broadcast({state: 'error', message: err?.message || '下载失败'});
        });
    } catch (err) {
        broadcast({state: 'error', message: (err as Error)?.message || '下载失败'});
    }
}

/** 渲染层确认后退出并安装。 */
export function quitAndInstall(): void {
    if (!canAutoUpdate().ok) return;
    initUpdater();
    autoUpdater.quitAndInstall(false, true);
}

export {autoUpdater, canAutoUpdate, currentVersion, messageOf};