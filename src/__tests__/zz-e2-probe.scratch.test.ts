// 一次性探针（plan-1.0 E2 准备）：取**真实硬件机器码**，供后续联调与建单使用。跑完即删，不入库。
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it, vi} from 'vitest';

vi.mock('electron', () => ({
    safeStorage: {
        isEncryptionAvailable: (): boolean => true,
        encryptString: (s: string): Buffer => Buffer.from(`safe:${s}`, 'utf-8'),
        decryptString: (b: Buffer): string => b.toString('utf-8').replace(/^safe:/, ''),
    },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }) },
}));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'e2-probe-home-'));
vi.spyOn(os, 'homedir').mockImplementation(() => home);

const { getMachineCodePair } = await import('../main/license/machine-code');
const { loadConfig } = await import('../main/license/config');

describe('probe', () => {
    it('prints real machine code + effective config', async () => {
        const pair = await getMachineCodePair();
        const cfg = loadConfig();
        console.log(JSON.stringify({
            home,
            strong: pair.strong,
            soft: pair.soft,
            serviceBaseUrl: cfg.serviceBaseUrl,
            recheck: cfg.recheck,
        }, null, 2));
        expect(pair.strong).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
    });
});
