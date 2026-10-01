/**
 * 缓存容量上限单测（plan-8.0 D12）。
 *
 * 背景：CacheManager 的内存 Map 与磁盘 .enc 文件此前均无上限，而 platform-search-*
 * 的 key 按（平台 × 连接 × 关键词 × 页码 × 分类 × 排序）组合爆炸，长期使用无界增长。
 * 修复：set() 写入后按 cachedAt / mtimeMs 升序裁剪最旧条目（淘汰失败静默跳过）。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// CacheManager → electron（app.getPath / safeStorage）：指向一次性临时目录，不污染真实用户目录
let tmpHome: string;
vi.mock('electron', () => ({
    app: {getPath: (_k: string) => tmpHome, isPackaged: false},
    safeStorage: {isEncryptionAvailable: () => false},
}));

const {CacheManager} = await import('../main/cache-manager');

function newManager(maxMemoryEntries: number, maxDiskFiles: number): InstanceType<typeof CacheManager> {
    return new CacheManager({maxMemoryEntries, maxDiskFiles});
}

/** 把指定缓存文件的 mtime 依次错开（向过去偏移，保证磁盘裁剪按写入顺序确定） */
function staggerMtimes(cacheDir: string, keys: string[]): void {
    keys.forEach((k, i) => {
        const p = path.join(cacheDir, `${k}.enc`);
        if (fs.existsSync(p)) {
            const t = new Date(Date.now() - (keys.length - i) * 1000);
            fs.utimesSync(p, t, t);
        }
    });
}

describe('CacheManager 容量上限（D12）', () => {
    beforeEach(() => {
        tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-dock-cache-test-'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        try {
            fs.rmSync(tmpHome, {recursive: true, force: true});
        } catch {
            // 清理失败不影响测试结论
        }
    });

    it('内存条目超 maxMemoryEntries 时淘汰最旧、保留最新', async () => {
        const cm = newManager(3, 999);
        for (let i = 1; i <= 5; i++) {
            await cm.set(`platform-search-k${i}`, {i});
        }
        const mem = (cm as unknown as {memoryCache: Map<string, unknown>}).memoryCache;
        expect(mem.size).toBe(3);
        // 最旧的 k1/k2 被淘汰，最新的 k3/k4/k5 保留
        expect(mem.has('platform-search-k1')).toBe(false);
        expect(mem.has('platform-search-k2')).toBe(false);
        expect(mem.has('platform-search-k5')).toBe(true);
    });

    it('磁盘文件超 maxDiskFiles 时按 mtime 删除最旧的 .enc（不含 details/）', async () => {
        const cm = newManager(999, 3);
        const keys = ['platform-search-d1', 'platform-search-d2', 'platform-search-d3', 'platform-search-d4', 'platform-search-d5'];
        for (const k of keys) {
            // keys 字面量均匹配 platform-search 前缀；staggerMtimes 需要 string[]，故数组元素保持宽类型，写缓存时按 CacheKey 的模板字面量收窄
            await cm.set(k as `platform-search-${string}`, {k});
        }
        const cacheDir = cm.getCacheDirectory();
        staggerMtimes(cacheDir, keys);
        // 手动触发一次裁剪（stagger 发生在 set 之后，重新写一次以触发 evict）
        await cm.set('platform-search-d5', {touch: true});
        const encs = fs.readdirSync(cacheDir).filter(f => f.endsWith('.enc'));
        expect(encs.length).toBe(3);
        // 最旧的 d1/d2 文件被删，最新的仍在
        expect(encs).not.toContain('platform-search-d1.enc');
        expect(encs).not.toContain('platform-search-d2.enc');
        expect(encs).toContain('platform-search-d5.enc');
    });

    it('未超上限时不做任何淘汰', async () => {
        const cm = newManager(10, 10);
        for (let i = 1; i <= 3; i++) {
            await cm.set(`platform-search-m${i}`, {i});
        }
        const mem = (cm as unknown as {memoryCache: Map<string, unknown>}).memoryCache;
        expect(mem.size).toBe(3);
        const encs = fs.readdirSync(cm.getCacheDirectory()).filter(f => f.endsWith('.enc'));
        expect(encs.length).toBe(3);
    });

    it('淘汰不影响数据可读性：留下的条目 get() 原样返回', async () => {
        const cm = newManager(2, 99);
        await cm.set('platform-search-a1', {v: 1});
        await cm.set('platform-search-a2', {v: 2});
        await cm.set('platform-search-a3', {v: 3});
        const hit = await cm.get<{v: number}>('platform-search-a3');
        expect(hit?.data).toEqual({v: 3});
    });
});
