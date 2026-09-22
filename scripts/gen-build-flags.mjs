// 生成 dist/build-flags.json（主进程运行时读取，随 `files: dist/**/*` 进 asar）。
// 值原样透传，归一化统一在 src/shared/build-flags.ts 的 resolveBuildFlags（单点）。
// 由 build:main 链调用；未设置的环境变量写 null，运行时按 edition 推导默认。
import fs from 'fs';
import path from 'path';

const flags = {
    edition: process.env.AI_TOOLS_EDITION ?? null,
    adRegion: process.env.AI_TOOLS_AD_REGION ?? null,
    adsEnabled: process.env.AI_TOOLS_ADS ?? null,
    cloudSyncEnabled: process.env.AI_TOOLS_CLOUD_SYNC ?? null,
    cloudSyncActivationUnlocks: process.env.AI_TOOLS_CLOUD_SYNC_ACTIVATION_UNLOCKS ?? null,
};

const out = path.join(process.cwd(), 'dist', 'build-flags.json');
fs.mkdirSync(path.dirname(out), {recursive: true});
fs.writeFileSync(out, JSON.stringify(flags, null, 2), 'utf-8');

console.log(`[build-flags] edition=${flags.edition || '(default free1)'} adRegion=${flags.adRegion || '(default cn)'} ads=${flags.adsEnabled ?? '(auto)'} cloudSync=${flags.cloudSyncEnabled ?? '(auto)'}`);
