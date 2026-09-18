/**
 * 机器码采集与派生单测
 *
 * 覆盖：因子归一化（含实测的 `0025_388B_01B4_6F88.`）、多盘稳定选盘、缺因子 → NA 占位、强弱双码差异。
 * 采集命令全部 mock，单测不真的拉起 PowerShell。
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';

const cpMock = vi.hoisted(() => {
    const state: {
        file: (file: string, args: string[]) => string;
        shell: (cmd: string) => string;
    } = {
        file: () => '',
        shell: () => '',
    };
    return {state};
});

vi.mock('child_process', () => ({
    execFileSync: (file: string, args: string[]): string => cpMock.state.file(file, args),
    execSync: (cmd: string): string => cpMock.state.shell(cmd),
}));

// safeStorage 不可用 → 不写落盘缓存，保证每次测试都走真实采集路径
vi.mock('electron', () => ({
    safeStorage: {
        isEncryptionAvailable: (): boolean => false,
        encryptString: (s: string): Buffer => Buffer.from(s, 'utf-8'),
        decryptString: (b: Buffer): string => b.toString('utf-8'),
    },
}));

type MachineCodeModule = typeof import('../main/license/machine-code');

/** 重新加载模块：清空进程内 memo，保证每条用例独立 */
async function loadModule(): Promise<MachineCodeModule> {
    vi.resetModules();
    return import('../main/license/machine-code');
}

/** 仅在 `powershell` 命令上返回指定输出，其余命令返回空串（触发回退链） */
function stubPowerShell(out: string): void {
    cpMock.state.file = (file: string): string => (file === 'powershell' ? out : '');
}

beforeEach(() => {
    cpMock.state.file = () => '';
    cpMock.state.shell = () => '';
});

describe('normalizeFactor', () => {
    it('保熵：只去掉不稳定性来源，非十六进制字符一律保留', async () => {
        const {normalizeFactor} = await loadModule();
        // 实测磁盘序列号（尾点）与主板序列号（含 W/K/S/X 等非 hex 字符）必须原样保留
        expect(normalizeFactor('0025_388B_01B4_6F88.')).toBe('0025_388B_01B4_6F88');
        expect(normalizeFactor('  bfeb fbff 000806ec ')).toBe('BFEBFBFF000806EC');
        expect(normalizeFactor('W1KS0BV106X')).toBe('W1KS0BV106X');
    });

    it('空白 / 控制字符 / 拼接分隔符 / 大小写差异被消除', async () => {
        const {normalizeFactor} = await loadModule();
        expect(normalizeFactor('')).toBe('');
        expect(normalizeFactor('   ')).toBe('');
        // 全角空格、NBSP、制表符与换行
        expect(normalizeFactor('AB\u3000C\u00a0D\tE\nF')).toBe('ABCDEF');
        expect(normalizeFactor('AB\u0001C\u007fD')).toBe('ABCD');
        // 因子自身含拼接分隔符时会造成解析串位，必须剔除
        expect(normalizeFactor('AB~|~CD')).toBe('ABCD');
        expect(normalizeFactor('..ABC.DEF..')).toBe('ABC.DEF');
    });
});

describe('selectWindowsFallbackDisk', () => {
    const csv = [
        'Node,Index,MediaType,SerialNumber',
        'HOST,1,Removable Media,USB123456',
        'HOST,0,Fixed hard disk media,SYS000111',
        'HOST,2,Fixed hard disk media,SEC999999',
    ].join('\r\n');

    it('多盘时选固定硬盘中 Index 最小的（排除 U 盘/移动硬盘）', async () => {
        const {selectWindowsFallbackDisk} = await loadModule();
        expect(selectWindowsFallbackDisk(csv)).toBe('SYS000111');
    });

    it('插拔 U 盘不改变结果：新增可移动盘后选盘不变', async () => {
        const {selectWindowsFallbackDisk} = await loadModule();
        const withUsb = [
            'Node,Index,MediaType,SerialNumber',
            'HOST,0,Removable Media,USBNEW999',
            'HOST,1,Removable Media,USB123456',
            'HOST,2,Fixed hard disk media,SYS000111',
        ].join('\r\n');
        expect(selectWindowsFallbackDisk(withUsb)).toBe('SYS000111');
    });

    it('无有效行时返回空串（fail-closed，交由 NA 占位）', async () => {
        const {selectWindowsFallbackDisk} = await loadModule();
        expect(selectWindowsFallbackDisk('')).toBe('');
        expect(selectWindowsFallbackDisk('Node,Index,MediaType,SerialNumber')).toBe('');
    });
});

describe('deriveMachineIds', () => {
    it('缺因子用 NA 占位，且强弱双码不相等', async () => {
        const {deriveMachineIds} = await loadModule();
        const pair = deriveMachineIds({cpu: '', disk: '', board: 'W1KS0BV106X', osGuid: '52968A50'});
        expect(pair.strong).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
        expect(pair.soft).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
        expect(pair.strong).not.toBe(pair.soft);
    });

    it('换硬盘时强码变、弱码不变（宽限判定的依据）', async () => {
        const {deriveMachineIds} = await loadModule();
        const base = {cpu: 'BFEBFBFF000806EC', disk: '0025_388B_01B4_6F88', board: 'W1KS0BV106X', osGuid: '52968A50'};
        const changed = {...base, disk: 'NEWDISKSERIAL0001'};
        expect(deriveMachineIds(base).soft).toBe(deriveMachineIds(changed).soft);
        expect(deriveMachineIds(base).strong).not.toBe(deriveMachineIds(changed).strong);
    });
});

describe('getMachineCode（采集链路）', () => {
    it('PowerShell 一次返回 4 因子时直接派生', async () => {
        const mod = await loadModule();
        stubPowerShell('BFEBFBFF000806EC~|~W1KS0BV106X~|~0025_388B_01B4_6F88.~|~52968a50-f61c-46ea-90e5-6e8ade012856');
        const code = await mod.getMachineCode();
        expect(code).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
        // deriveMachineIds 的输入是**已归一化**因子，故这里逐项过 normalizeFactor 后再比对
        const expected = mod.deriveMachineIds({
            cpu: mod.normalizeFactor('BFEBFBFF000806EC'),
            board: mod.normalizeFactor('W1KS0BV106X'),
            disk: mod.normalizeFactor('0025_388B_01B4_6F88.'),
            osGuid: mod.normalizeFactor('52968a50-f61c-46ea-90e5-6e8ade012856'),
        });
        expect(code).toBe(expected.strong);
    });

    it('PS 缺磁盘因子时回退 wmic 并按固定硬盘选盘（多盘不影响结果）', async () => {
        const mod = await loadModule();
        stubPowerShell('BFEBFBFF000806EC~|~W1KS0BV106X~|~~|~52968a50');
        cpMock.state.file = (file: string, args: string[]): string => {
            if (file === 'powershell') {
                return 'BFEBFBFF000806EC~|~W1KS0BV106X~|~~|~52968a50';
            }
            if (file === 'wmic' && args.includes('Index,MediaType,SerialNumber')) {
                return [
                    '',
                    'Node,Index,MediaType,SerialNumber',
                    'HOST,3,Removable Media,USBXXXXXX',
                    'HOST,1,Fixed hard disk media,SYS000111',
                    'HOST,2,Fixed hard disk media,SEC999999',
                    '',
                ].join('\r\n');
            }
            return '';
        };
        const code = await mod.getMachineCode();
        const expected = mod.deriveMachineIds({
            cpu: mod.normalizeFactor('BFEBFBFF000806EC'),
            board: mod.normalizeFactor('W1KS0BV106X'),
            disk: mod.normalizeFactor('SYS000111'),
            osGuid: mod.normalizeFactor('52968a50'),
        });
        expect(code).toBe(expected.strong);
    });

    it('全部采集失败时仍返回合法格式（因子全部 NA，fail-closed）', async () => {
        const mod = await loadModule();
        cpMock.state.file = () => '';
        cpMock.state.shell = () => '';
        const pair = await mod.getMachineCodePair();
        expect(pair.strong).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
        expect(pair.strong).toBe(
            mod.deriveMachineIds({cpu: 'NA', board: 'NA', disk: 'NA', osGuid: 'NA'}).strong
        );
    });

    it('进程内 memo：重复调用返回同一结果', async () => {
        const mod = await loadModule();
        let calls = 0;
        cpMock.state.file = (): string => {
            calls++;
            return 'CPU1~|~BOARD1~|~DISK1~|~GUID1';
        };
        const first = await mod.getMachineCode();
        const second = await mod.getMachineCode();
        expect(first).toBe(second);
        expect(calls).toBe(1);
    });
});
