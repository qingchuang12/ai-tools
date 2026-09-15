// 将 pnpm symlinked 模式下「指定根依赖的生产传递闭包」里、缺失于顶层 node_modules 的包，
// 真实复制到顶层，供 electron-builder 打包时能跟随 require 解析。
//
// 背景：本项目 .npmrc 设了 node-linker=hoisted，但当前环境 pnpm 未真正据此重建 node_modules
// （实测仍是 symlinked 模式：直接依赖是 SymbolicLink，传递依赖藏于
// node_modules/.pnpm/<pkg>@x/node_modules/<pkg>）。electron-builder 会打包顶层生产依赖、并跟进大部分
// 嵌套符号链接，但实测对 ssh2 / ssh2-sftp-client 这条 SFTP 链的若干传递依赖
// （concat-stream、readable-stream、safe-buffer 及其传递依赖）未能跟进而漏打包，
// 运行时报 "cannot find module concat-stream"。
// 注：ssh2-streams 在 ssh2@1.17.0 已移出依赖（.pnpm 中无此包，无人 require）；ms 仅渲染侧使用（已被 Vite 内联），
// 二者均无需处理。
//
// 早期版本用 fs.symlinkSync(..., 'junction') 把这些包挂到顶层，但 Windows 的 junction 在
// electron-builder 打包进 asar 后无法被 Electron 的 asar 文件系统跟随，问题依旧。故改为真实复制。
//
// 实现要点（纯 Node，不依赖外部命令，避免 Windows 对 robocopy/powershell 调用的环境限制）：
//  - 仅处理 ROOTS（默认 ssh2 + ssh2-sftp-client + electron-updater，即主进程 SFTP 栈与在线升级依赖）的生产传递闭包；
//    闭包由各包 package.json 的 dependencies/optionalDependencies/peerDependencies 递归收集。
//    —— 只针对会漏打包的主进程依赖，不波及渲染进程依赖（已被 Vite 内联）与 dev 依赖，避免复制 GB 级内容。
//  - copyDirReal 递归复制：文件 copyFileSync；目录 mkdirSync；遇到符号链接/junction 用 realpathSync
//    解析为真实物理路径后再复制，从而把 .pnpm 内含 junction 的嵌套依赖全部真实化（asar 内能正常 require）。
//  - visited 集合（每次顶层复制独立创建）记录本次递归内已复制的真实源路径，防御 pnpm 循环符号链接(A↔B)
//    导致的无限递归；同一物理包在不同顶层包下被重复复制属可接受的小开销（闭包已收敛到少数包）。
//  - 递归深度上限 60：防御极端深嵌套/环，绝不死循环。
//  - 复制前用 Node 的 fs.rmSync 强制清除顶层残留（悬空 junction 等）；Node 的 rmSync 不走 trash，
//    可删除被 safe-delete 机制拦截的残留 junction。
//  - 直接依赖（dependencies + devDependencies 顶层已存在符号链接）保持不动，electron-builder 会正确处理。
//
// 用法：在 build / package 脚本前自动执行（package.json 已接入）。幂等可重复。
// 如需扩展到其它主进程依赖，设 LINK_DEPS_ROOTS=包1,包2 环境变量。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const nm = path.join(ROOT, 'node_modules');
const pnpmRoot = path.join(nm, '.pnpm');

process.on('uncaughtException', (e) => {
  console.error('[link-pnpm-deps] UNCAUGHT', e && e.stack ? e.stack : e);
  process.exit(1);
});

if (!fs.existsSync(pnpmRoot)) {
  console.log('[link-pnpm-deps] 无 node_modules/.pnpm，跳过');
  process.exit(0);
}

const pkg = require(path.join(ROOT, 'package.json'));
const directDeps = new Set([
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.devDependencies || {}),
]);
const ROOTS = (process.env.LINK_DEPS_ROOTS || 'ssh2,ssh2-sftp-client,electron-updater')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const pnpmDirs = fs.readdirSync(pnpmRoot);

function findPkgDir(name) {
  if (name.startsWith('@')) {
    const norm = name.replace('/', '+');
    return pnpmDirs.find((d) => d.startsWith(norm + '@')) || null;
  }
  return pnpmDirs.find((d) => d === name || d.startsWith(name + '@')) || null;
}
function pkgJsonOf(name) {
  const d = findPkgDir(name);
  if (!d) return null;
  const p = path.join(pnpmRoot, d, 'node_modules', name, 'package.json');
  return fs.existsSync(p) ? p : null;
}

// 收集 ROOTS 的生产传递闭包（递归；含 optional/peer）
const closure = new Set(ROOTS);
const stack = [...ROOTS];
while (stack.length) {
  const name = stack.pop();
  const pj = pkgJsonOf(name);
  if (!pj) continue;
  let j;
  try {
    j = JSON.parse(fs.readFileSync(pj, 'utf8'));
  } catch {
    continue;
  }
  const deps = {
    ...(j.dependencies || {}),
    ...(j.optionalDependencies || {}),
    ...(j.peerDependencies || {}),
  };
  for (const dep of Object.keys(deps)) {
    if (!closure.has(dep)) {
      closure.add(dep);
      stack.push(dep);
    }
  }
}

let copied = 0;
let skipped = 0;
let failed = 0;

// 从真实物理路径反推包名（用于决定是否跟进符号链接）
function pkgNameFromPath(p) {
  const idx = p.lastIndexOf('node_modules');
  if (idx < 0) return null;
  const rest = p.slice(idx + 'node_modules'.length + 1);
  const parts = rest.split(/[\\/]/).filter(Boolean);
  if (parts[0] && parts[0].startsWith('@')) return parts[0] + '/' + (parts[1] || '');
  return parts[0] || null;
}

// 真实递归复制：解析符号链接/junction 为真实内容；visited 防单次递归内的循环/重复；depth 防极端深嵌套。
// 只跟进「属于闭包」的符号链接（跳过指向 dev 包等的符号链接，避免复制 GB 级无关内容）。
function copyDirReal(src, dst, depth, visited) {
  depth = depth || 0;
  if (depth > 60) return;
  visited = visited || new Set();
  let real = src;
  let isLink = false;
  try {
    const st = fs.lstatSync(src);
    isLink = st.isSymbolicLink();
  } catch {
    return;
  }
  if (isLink) {
    try {
      real = fs.realpathSync(src);
    } catch {
      return;
    }
    const linkName = pkgNameFromPath(real);
    if (!linkName || !closure.has(linkName)) return; // 非闭包（dev 等）→ 不跟进
    if (visited.has(real)) return;
    visited.add(real);
    copyDirReal(real, dst, depth + 1, visited);
    return;
  }
  if (visited.has(real)) return;
  visited.add(real);
  const st = fs.lstatSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src)) {
      copyDirReal(path.join(src, e), path.join(dst, e), depth + 1, visited);
    }
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

function realifyIfNeeded(name, src) {
  if (!closure.has(name) || directDeps.has(name)) {
    skipped++;
    return;
  }
  const top = path.join(nm, name);
  try {
    if (!fs.existsSync(src)) {
      skipped++;
      return;
    }
    // 源必须是可解析且真实存在的路径：跳过悬空符号链接残留，避免 rmSync 误删已建好的顶层副本
    let real;
    try {
      real = fs.realpathSync(src);
    } catch {
      skipped++;
      return;
    }
    if (!fs.existsSync(real)) {
      skipped++;
      return;
    }
    try {
      fs.rmSync(top, { recursive: true, force: true });
    } catch {}
    copyDirReal(real, top, 0, new Set());
    copied++;
  } catch (e) {
    failed++;
    console.error('[link-pnpm-deps] FAIL', name, e.code || e.message);
  }
}

for (const dir of pnpmDirs) {
  const inner = path.join(pnpmRoot, dir, 'node_modules');
  if (!fs.existsSync(inner)) continue;
  for (const entry of fs.readdirSync(inner)) {
    if (entry === '.bin' || entry === '.package-lock.json') continue;
    const entryPath = path.join(inner, entry);
    if (entry.startsWith('@')) {
      let subs;
      try {
        subs = fs.readdirSync(entryPath).filter((s) => s !== '.package-lock.json');
      } catch {
        continue;
      }
      for (const s of subs) {
        realifyIfNeeded(entry + '/' + s, path.join(entryPath, s));
      }
    } else {
      realifyIfNeeded(entry, entryPath);
    }
  }
}

console.log(
  `[link-pnpm-deps] roots=${ROOTS.join(',')} closure=${closure.size} copied=${copied} skipped=${skipped} failed=${failed}`
);
