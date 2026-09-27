/**
 * Electron 启动包装器（`start` / `electron:dev` 共用）。
 *
 * 解决两类「跑起来但没有任何主窗口」的环境问题（2026-09-11 定位并验证）：
 *
 * 1) `ELECTRON_RUN_AS_NODE=1` 环境变量污染
 *    宿主 IDE / Electron 桌面应用会把它注入环境并被子进程继承。该变量一旦存在，
 *    electron.exe 会退化为「纯 Node 运行时」：不启动浏览器进程；`require('electron')`
 *    不再被拦截，回退为 npm 包的 shim（返回可执行文件路径字符串）；`app` / `BrowserWindow`
 *    全为 undefined。现象：模块加载期即以
 *    `TypeError: Cannot read properties of undefined (reading 'getPath')` 崩溃
 *    （`getCacheManager()` 在 `src/main/index.ts` 模块顶层就调用 `app.getPath('home')`，
 *    早于 `app.whenReady()`，进程还没建窗就死了）。
 *    → 处理：拉起 Electron 前显式删除该变量。
 *
 * 2) Chromium 沙箱在受限父进程环境下不可用
 *    自 IDE 内嵌终端 / 受限 job 对象派生的 Electron，其沙箱化 GPU 子进程会被反复终止，
 *    Chromium 随即 `FATAL ... GPU process isn't usable. Goodbye.` 整体退出
 *    （exit code 2147483651 = 0x80000003），窗口来不及显示。
 *    实测（2026-09-11，本机）：
 *      · 无任何开关                                  → 崩溃（GPU_FATAL）
 *      · 仅 `--disable-gpu`                          → 仍崩溃（说明问题在沙箱，不在 GPU）
 *      · `--no-sandbox`                              → 存活 ✅（最小充分开关）
 *      · `--in-process-gpu`                          → 存活 ✅（备选）
 *      · 极简 21 键环境、无开关                      → 仍崩溃（证明非环境变量导致，而是进程上下文）
 *    → 处理：开发启动默认追加 `--no-sandbox`。仅作用于 `pnpm start` / `pnpm run electron:dev`，
 *      不影响 electron-builder 打包产物（打包后从资源管理器正常启动，沙箱可用，保持默认开启）。
 *      如需保留沙箱：设置环境变量 `ELECTRON_DEV_KEEP_SANDBOX=1`。
 *
 * 注意：本问题与「electron 安装是否完整」无关——Electron 43 官方发行包本就只含
 * `resources/default_app.asar`（不再随包提供 `electron.asar`），安装没有任何问题。
 *
 * 每次运行会把子进程输出与关键启动信息写入 `<项目根>/electron-dev.log`，便于无窗口时取证。
 * 用法：node scripts/electron-dev-launch.cjs [传给 electron 的参数...]
 */
const {spawn} = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const LOG_FILE = path.join(PROJECT_ROOT, 'electron-dev.log');

// ---- 1) 清理污染变量 ----
// 这些变量若从宿主 IDE / 桌面应用继承到子进程，会导致 electron 退化为纯 Node，
// 或把调试器 / 语言 shim 透传给所有子进程（含 MCP 服务器），造成启动挂起或行为异常。
const env = {...process.env};
const removedEnv = [];

// 1a) electron 必须作为渲染运行时启动，不能是纯 Node
if ('ELECTRON_RUN_AS_NODE' in env) {
    delete env.ELECTRON_RUN_AS_NODE;
    removedEnv.push('ELECTRON_RUN_AS_NODE');
}

// 1b) 清除 NODE_OPTIONS 中从宿主 IDE / 桌面应用继承、会透传给子进程的污染项：
//     - --inspect / --inspect-brk / --inspect-port：调试器透传，会挂起 MCP 等子进程
//     - WorkBuddy 注入的 --require=.../cli/vendor/shim/*.cjs：node 语言 shim，
//       会 broker 子进程的 fs 写操作（实测导致 ow-epm 写 owpm.log 报 EPERM），
//       且 ow-electron 内置 Node 本不需要它
//     保留用户自定义的其它项（如 --max-old-space-size），做到通用修复而非个案补丁。
if ('NODE_OPTIONS' in env && env.NODE_OPTIONS) {
    const dropRe = /^(?:--inspect(?:-brk)?(?:\b|$)|--inspect-port\b|--require=.*[\\/]cli[\\/]vendor[\\/]shim[\\/][^ ]*\.cjs)/;
    const kept = env.NODE_OPTIONS.split(/\s+/).filter((opt) => !dropRe.test(opt));
    const keptStr = kept.join(' ').trim();
    if (keptStr) {
        env.NODE_OPTIONS = keptStr;
    } else {
        delete env.NODE_OPTIONS;
    }
    removedEnv.push('NODE_OPTIONS(inspect+workbuddy-shim)');
}

// 在普通 Node 下，require('electron') 返回 electron 可执行文件路径（官方包语义）。
const electronPath = require('electron');
const userArgs = process.argv.slice(2);

// ---- 2) 补齐开发启动所需开关 ----
const args = [...userArgs];
const explicitSandboxFlag = userArgs.some((a) => a === '--no-sandbox' || a === '--sandbox');
if (!explicitSandboxFlag && process.env.ELECTRON_DEV_KEEP_SANDBOX !== '1') {
    args.push('--no-sandbox');
}

// ---- 启动日志（每次覆盖） ----
let logStream;
try {
    logStream = fs.createWriteStream(LOG_FILE, {flags: 'w'});
} catch {
    logStream = null;
}
const log = (s) => {
    if (logStream) {
        try { logStream.write(s); } catch { /* ignore */ }
    }
};
log(`[electron-launch] ${new Date().toISOString()}\n`);
log(`[electron-launch] electron = ${electronPath}\n`);
log(`[electron-launch] args     = ${JSON.stringify(args)}\n`);
log(`[electron-launch] 已清理环境变量 = ${removedEnv.length ? removedEnv.join(', ') : '(无)'}\n`);
log(`[electron-launch] VITE_DEV_SERVER_URL = ${env.VITE_DEV_SERVER_URL || '(未设置)'}\n`);
log('[electron-launch] ---- 子进程输出 ----\n');

const child = spawn(electronPath, args, {env});

child.stdout.on('data', (d) => {
    process.stdout.write(d);
    log(d);
});
child.stderr.on('data', (d) => {
    process.stderr.write(d);
    log(d);
});
child.on('error', (err) => {
    const msg = `[electron-launch] 启动 Electron 失败：${err.message}\n`;
    console.error(msg.trimEnd());
    log(msg);
    logStream?.end(() => process.exit(1));
});
child.on('exit', (code, signal) => {
    if (code === 2147483651) {
        // Chromium 以 GPU/沙箱致命错误退出
        const hint = '[electron-launch] 检测到 Chromium GPU/沙箱致命退出（exit 2147483651）。若已设置 ELECTRON_DEV_KEEP_SANDBOX=1，请取消该设置重试；否则请检查是否有未退出的 electron 进程占用单实例锁。\n';
        console.error(hint.trimEnd());
        log(hint);
    }
    log(`[electron-launch] 子进程退出 code=${code == null ? 'null' : code} signal=${signal == null ? 'null' : signal}\n`);
    const exitCode = code == null ? (signal ? 1 : 0) : code;
    if (logStream) {
        logStream.end(() => process.exit(exitCode));
    } else {
        process.exit(exitCode);
    }
});
