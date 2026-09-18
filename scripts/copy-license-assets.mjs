// 把授权资产拷进主进程构建产物：
//   src/main/license/assets/** -> dist/main/license/assets/**
//   src/public.key             -> dist/main/license/assets/public.key
// tsc 只编译 .ts，.json 与公钥资产必须显式拷贝，否则运行时找不到配置/公钥。
//
// 源缺失只打日志、不 exit(1)：构建期不应因为「还没放公钥」而中断（占位公钥上线前才替换），
// 缺失的后果由运行时双源加载 + 内置硬编码兜底承担。
import {cpSync, existsSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const assetsSrc = join(root, 'src', 'main', 'license', 'assets');
const assetsDest = join(root, 'dist', 'main', 'license', 'assets');
const publicKeySrc = join(root, 'src', 'public.key');

mkdirSync(assetsDest, {recursive: true});

let copied = 0;
if (existsSync(assetsSrc)) {
    cpSync(assetsSrc, assetsDest, {recursive: true});
    copied++;
    console.log(`[copy-license-assets] license/assets -> dist/main/license/assets`);
} else {
    console.log(`[copy-license-assets] 源目录不存在，跳过：${assetsSrc}`);
}

if (existsSync(publicKeySrc)) {
    cpSync(publicKeySrc, join(assetsDest, 'public.key'));
    copied++;
    console.log('[copy-license-assets] src/public.key -> dist/main/license/assets/public.key');
} else {
    console.log(`[copy-license-assets] 公钥不存在，跳过（运行时回落到内置硬编码兜底）：${publicKeySrc}`);
}

if (copied === 0) {
    console.log('[copy-license-assets] 无授权资产被拷贝');
}
