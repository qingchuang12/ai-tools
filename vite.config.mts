import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {obfuscateChunks} from 'vite-plugin-electron-obfuscator';

// 编译期 build flag（renderer 侧）：值原样透传，归一化在 src/shared/build-flags.ts。
// define 产物中不存在 __BUILD_FLAGS__ 标识符（直接内联对象字面量），与 terser/混淆链兼容。
const buildFlagEnv = {
    edition: process.env.AI_TOOLS_EDITION ?? null,
    adRegion: process.env.AI_TOOLS_AD_REGION ?? null,
    adsEnabled: process.env.AI_TOOLS_ADS ?? null,
    cloudSyncEnabled: process.env.AI_TOOLS_CLOUD_SYNC ?? null,
    cloudSyncActivationUnlocks: process.env.AI_TOOLS_CLOUD_SYNC_ACTIVATION_UNLOCKS ?? null,
};

export default defineConfig({
    plugins: [react(), obfuscateChunks()],
    define: {
        __BUILD_FLAGS__: JSON.stringify(buildFlagEnv),
    },
    root: 'src/renderer',
    base: './',
    build: {
        outDir: '../../dist/renderer',
        emptyOutDir: true,
        minify: 'terser',
        terserOptions: {
            compress: {
                drop_console: true,
                drop_debugger: true,
                pure_funcs: ['console.log', 'console.info', 'console.debug'],
            },
            mangle: {
                toplevel: true,
                safari10: true,
            },
            format: {
                comments: false,
            },
        },
        rollupOptions: {
            output: {
                // 混淆 chunk 名称
                chunkFileNames: 'assets/[hash].js',
                entryFileNames: 'assets/[hash].js',
                assetFileNames: 'assets/[hash].[ext]',
            },
        },
    },
    resolve: {
        alias: {
            '@': path.resolve(import.meta.dirname, 'src/renderer/src'),
        },
    },
    server: {
        // 显式绑定 IPv4 回环，避免「本地 dev server 只监听 [::1]、而 wait-on/Electron 按 127.0.0.1 连接」
        // 造成的地址族错配：此时 wait-on tcp:5173 会一直连不上 → electron 永不启动 → 无窗口。
        host: '127.0.0.1',
        port: 5173,
        // 端口被占时直接报错退出，而不是静默改用 5174——否则 wait-on/VITE_DEV_SERVER_URL 仍指向
        // 5173，会再次静默挂死（无窗口且无日志），且渲染进程可能连到残留的旧实例。
        strictPort: true,
    },
});
