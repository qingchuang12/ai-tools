// 对 build:main 的编译产物 dist/main/**/*.js 做「obfuscator + terser」两段式加固。
//
// 动机（需求 F / 防反编译审计）：renderer 已通过 vite-plugin-electron-obfuscator + terser
// 加固；main 进程此前仅裸编（tsc），逆向门槛远低于渲染层。本脚本补齐 main 的同等加固，
// 提升反编译成本，且不改变运行时行为（仅重命名局部标识符、编码字符串常量、压缩空白）。
//
// 设计约束（关键，避免破坏 Electron 主进程）：
//  - renameGlobals=false：绝不重命名全局/模块级导出名，保证 require/module/exports 与
//    IPC 句柄字符串（ipcMain.handle 的 channel 名是字符串字面量，混淆后运行时仍解码为原值）完好。
//  - controlFlowFlattening / deadCodeInjection 关闭：这两项对运行时结构改动最大，主进程风险高，
//    对「防反编译」收益有限，故保守关闭。
//  - selfDefending=false：Electron 主进程由框架加载，自保护包裹可能干扰模块初始化。
//  - disableConsoleOutput=false：保留主进程诊断日志（便于线上排障），加固重点在标识符/字符串混淆。
//  - 仅处理 .js：JSON 等数据资源（copy-platform-data 产出）不动；node_modules 依赖不被打包进 dist/main。

import {createRequire} from 'node:module';
import {existsSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {extname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {minify} from 'terser';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const distMain = join(root, 'dist', 'main');

// 解析 javascript-obfuscator：优先作为直接依赖 require；pnpm 严格 node_modules 下若仅存在
// 传递依赖（经 vite-plugin-electron-obfuscator 引入），按版本通配定位 .pnpm 内的真实路径。
// 版本通配 @* 可兼容后续版本漂移，无需硬编码具体版本号。
function resolveObfuscator() {
    try {
        return require('javascript-obfuscator');
    } catch {
        // 忽略，走下方回退
    }
    const pnpmBase = join(root, 'node_modules', '.pnpm');
    if (existsSync(pnpmBase)) {
        for (const entry of readdirSync(pnpmBase)) {
            if (!/^javascript-obfuscator@/.test(entry)) continue;
            const candidate = join(pnpmBase, entry, 'node_modules', 'javascript-obfuscator');
            if (existsSync(candidate)) return require(candidate);
        }
    }
    throw new Error(
        'javascript-obfuscator 未找到：请执行 `pnpm add -D javascript-obfuscator` 将其提升为直接依赖。'
    );
}

const obfuscator = resolveObfuscator();

const OBF_OPTIONS = {
    compact: true,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 0.75,
    stringArrayWrappersCount: 1,
    stringArrayWrappersChainedCalls: true,
    splitStrings: false,
    renameGlobals: false,
    selfDefending: false,
    disableConsoleOutput: false,
    identifierNamesGenerator: 'hexadecimal',
    identifiersPrefix: 'o',
    // reservedNames 必须为「正则字符串数组」（v4.x 校验要求），逐项保留关键自由标识符，
    // 防止极端情况（如局部重声明 require/module）被改名导致主进程加载失败。
    reservedNames: [
        '^(require|module|exports|__dirname|__filename|process|global|Buffer|console)$',
    ],
    transformObjectKeys: false,
    log: false,
};

function* walk(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            yield* walk(full);
        } else if (entry.isFile() && extname(entry.name) === '.js') {
            yield full;
        }
    }
}

let count = 0;
let failed = 0;
for (const file of walk(distMain)) {
    try {
        const code = readFileSync(file, 'utf8');
        const obfuscated = obfuscator.obfuscate(code, OBF_OPTIONS).getObfuscatedCode();
        const result = await minify(obfuscated, {
            compress: {defaults: true, drop_console: false, drop_debugger: false},
            mangle: {toplevel: true},
            format: {comments: false},
        });
        if (result.error) throw result.error;
        writeFileSync(file, result.code, 'utf8');
        count++;
    } catch (e) {
        failed++;
        console.error(`[obfuscate-main] 处理失败: ${file}\n  ${e && e.message ? e.message : e}`);
    }
}

console.log(`[obfuscate-main] 完成：混淆+压缩 ${count} 个文件，失败 ${failed}`);
if (failed > 0) process.exit(1);
