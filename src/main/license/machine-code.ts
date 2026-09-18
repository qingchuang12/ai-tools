/**
 * 机器码采集与派生（主进程）
 *
 * **安全性质（重要）**：本模块的缓存在**所有异常路径上都是 fail-closed**——
 * 缓存文件缺失、解密失败、结构校验失败、子进程超时、因子采集为空，
 * 结果一律是「重新采集」或「该因子记为 NA」，**只可能导致授权失败，绝不会导致授权通过**。
 * 因此缓存是安全的加速手段（避免每次启动付 3s 采集成本），而不是绕过口子：
 * 攻击者篡改缓存只会让自己拿不到授权。
 *
 * 采集策略：
 * - Windows：一次 PowerShell（CIM）拿全 4 因子，单行 `~|~` 分隔输出，避免多行解析受系统语言影响；
 *   `wmic` / `reg` 仅作老系统或单因子缺失时的回退（`wmic` 在 Win11 24H2+ 已被移除）。
 * - macOS / Linux：按平台可用命令尽力采集，任一因子缺失不影响其余因子参与派生（记 NA 占位）。
 *
 * 只上报**哈希**，不上报任何原始硬件信息。
 */

import {execFileSync, execSync} from 'child_process';
import {createHash} from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {safeStorage} from 'electron';
import {MACHINE_ID_FACTOR_NA, MACHINE_ID_PATTERN} from '../../shared/license-constants';
import {writeFileAtomic} from '../config/settings-store';
import {
    AI_TOOLS_DIR_NAME,
    BACKGROUND_RECHECK_DELAY_MS,
    FACTOR_SEPARATOR,
    FALLBACK_CMD_TIMEOUT_MS,
    MACHINE_CODE_CACHE_FILE,
    MACHINE_CODE_SALT,
    POSIX_COLLECT_TIMEOUT_MS,
    PS_COLLECT_TIMEOUT_MS,
} from './constants';
import {logLicenseEvent} from './errors';

/** 原始硬件因子（未归一化） */
export interface HardwareFactors {
    cpu: string;
    disk: string;
    board: string;
    osGuid: string;
}

/** 强/弱双机器码 */
export interface MachineIdPair {
    /** 强绑定码：含磁盘因子 */
    strong: string;
    /** 弱绑定码：剔除磁盘，用于换盘宽限判定 */
    soft: string;
}

/** 落盘缓存结构（factors 为可选：老缓存没有该字段时按需补采一次） */
interface MachineCodeCacheFile {
    v: 1;
    strong: string;
    soft: string;
    factors?: HardwareFactors;
}

let pairPromise: Promise<MachineIdPair> | null = null;
let factorsPromise: Promise<HardwareFactors> | null = null;

// ── 命令执行（超时/失败一律返回空串，绝不抛出） ────────────────────────────

function runFile(file: string, args: string[], timeoutMs: number): string {
    try {
        return execFileSync(file, args, {windowsHide: true, timeout: timeoutMs, encoding: 'utf-8'}).toString();
    } catch {
        return '';
    }
}

function runShell(cmd: string, timeoutMs: number): string {
    try {
        return execSync(cmd, {windowsHide: true, timeout: timeoutMs, encoding: 'utf-8'}).toString();
    } catch {
        return '';
    }
}

function readTextFile(file: string): string {
    try {
        return fs.readFileSync(file, 'utf-8').trim();
    } catch {
        return '';
    }
}

function firstMatch(text: string, re: RegExp): string {
    const m = text.match(re);
    return m ? m[1].trim() : '';
}

// ── 归一化与派生 ─────────────────────────────────────────────────────────

/**
 * 因子归一化（**保熵优先**）。
 *
 * 因子是 SHA-256 的**输入**，不要求是十六进制；过滤非 hex 字符只会砍掉熵
 * （`W1KS0BV106X` 会被削成 `10B106`，不同厂商的序列号还会大量碰撞到同一残值），
 * 反而削弱一机一码。归一化真正要消除的只是「同一台机器两次采集的字符串不一致」，
 * 其来源只有四类：空白字符、控制字符、我们自己的拼接分隔符、大小写。
 *
 * 规则（顺序即实现顺序）：
 * 1. `trim()`；
 * 2. 剔除所有空白（含 `\r\n\t`、全角空格 `U+3000`、NBSP `U+00A0`）；
 * 3. 剔除控制字符（`< 0x20` 与 `0x7F`）；
 * 4. 剔除内部分隔符 `~|~`（防止因子自身含它造成解析时串位）；
 * 5. 去掉首尾的 `.`（实测磁盘序列号带尾点：`0025_388B_01B4_6F88.`）；
 * 6. 转大写（消除大小写差异）；
 * 7. **其余字符一律保留**，包括 `W` `K` `S` `X` 这类非十六进制字符。
 */
export function normalizeFactor(raw: string): string {
    if (!raw) return '';
    return raw
        .trim()
        .replace(/[\s\u3000\u00a0]/g, '')
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .split(FACTOR_SEPARATOR)
        .join('')
        .replace(/^\.+/, '')
        .replace(/\.+$/, '')
        .toUpperCase();
}

/** SHA-256 前 16 位十六进制 → `XXXX-XXXX-XXXX-XXXX` */
function formatMachineId(hashHex: string): string {
    return hashHex
        .slice(0, 16)
        .toUpperCase()
        .replace(/(.{4})/g, '$1-')
        .replace(/-$/, '');
}

function sha256Hex(input: string): string {
    return createHash('sha256').update(input, 'utf-8').digest('hex');
}

function fill(factor: string): string {
    return factor || MACHINE_ID_FACTOR_NA;
}

/**
 * 由硬件因子派生强/弱双码。
 * 缺因子用固定占位 `NA`，保证**维度固定**（不会因为少一个因子就让分隔符位置错位）。
 * 弱码剔除磁盘：换硬盘时强码变、弱码不变，据此给换盘宽限而不是直接判定盗版。
 */
export function deriveMachineIds(factors: HardwareFactors): MachineIdPair {
    const cpu = fill(factors.cpu);
    const disk = fill(factors.disk);
    const board = fill(factors.board);
    const osGuid = fill(factors.osGuid);
    return {
        strong: formatMachineId(
            sha256Hex(`${cpu}${FACTOR_SEPARATOR}${disk}${FACTOR_SEPARATOR}${board}${FACTOR_SEPARATOR}${osGuid}${FACTOR_SEPARATOR}${MACHINE_CODE_SALT}`)
        ),
        soft: formatMachineId(
            sha256Hex(`${cpu}${FACTOR_SEPARATOR}${board}${FACTOR_SEPARATOR}${osGuid}${FACTOR_SEPARATOR}${MACHINE_CODE_SALT}`)
        ),
    };
}

// ── Windows 采集 ─────────────────────────────────────────────────────────

/**
 * 一次 PowerShell 进程取全 4 因子，单行 `~|~` 分隔输出。
 *
 * **系统盘选盘规则**：`$env:SystemDrive` → `Win32_LogicalDisk` → `Win32_LogicalDiskToPartition`
 * → `Win32_DiskDriveToDiskPartition` → `Win32_DiskDrive.SerialNumber`。
 * 理由：插拔 U 盘 / 移动硬盘 / 加第二块盘**不应**改变机器码，只有换系统盘才算实质变化。
 * 关联查询失败时回退「固定硬盘（MediaType 含 Fixed）按 Index 升序取首个」。
 */
const WINDOWS_PS_SCRIPT = `$ErrorActionPreference='SilentlyContinue';
$p=Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1;
$b=Get-CimInstance -ClassName Win32_BaseBoard | Select-Object -First 1;
$cpu=''; if($p){$cpu=[string]$p.ProcessorId};
$bd=''; if($b){$bd=[string]$b.SerialNumber};
$dsk='';
$sd=$env:SystemDrive;
if($sd){
  $ld=Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='$sd'";
  if($ld){
    $pt=@(Get-CimAssociatedInstance -InputObject $ld -Association Win32_LogicalDiskToPartition);
    if($pt.Count -gt 0){
      $dd=@(Get-CimAssociatedInstance -InputObject $pt[0] -Association Win32_DiskDriveToDiskPartition);
      if($dd.Count -gt 0){$dsk=[string]$dd[0].SerialNumber}
    }
  }
};
if(-not $dsk){
  $fx=Get-CimInstance -ClassName Win32_DiskDrive | Where-Object{$_.MediaType -like '*Fixed*'} | Sort-Object -Property Index | Select-Object -First 1;
  if($fx){$dsk=[string]$fx.SerialNumber}
};
$g='';
$gp=Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid;
if($gp){$g=[string]$gp.MachineGuid};
Write-Output ($cpu+'~|~'+$bd+'~|~'+$dsk+'~|~'+$g)`;

/** 解析 PS 单行输出：取最后一个含分隔符的行，缺位补空串 */
function parseFactorLine(output: string): string[] {
    const lines = output
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.includes(FACTOR_SEPARATOR));
    const line = lines.length > 0 ? lines[lines.length - 1] : '';
    const parts = line.split(FACTOR_SEPARATOR);
    return [parts[0] || '', parts[1] || '', parts[2] || '', parts[3] || ''];
}

/** `wmic <...> get <Prop>` 输出：跳过表头行，取其后第一个非空行 */
function parseWmicFirstValue(output: string): string {
    const lines = output
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    return lines.length > 1 ? lines[1] : '';
}

/**
 * `wmic diskdrive get Index,MediaType,SerialNumber /format:csv` 输出的选盘。
 * 优先 MediaType 含 `Fixed` 的盘（排除 U 盘/移动硬盘），按 Index 升序取首个非空序列号。
 */
export function selectWindowsFallbackDisk(csv: string): string {
    const lines = csv
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    if (lines.length < 2) return '';

    const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
    const idxIndex = header.indexOf('index');
    const idxMedia = header.indexOf('mediatype');
    const idxSerial = header.indexOf('serialnumber');
    if (idxSerial < 0) return '';

    const rows = lines.slice(1).map((l) => l.split(',').map((c) => c.trim()));
    const fixed = rows.filter((r) => idxMedia >= 0 && /fixed/i.test(r[idxMedia] || ''));
    const pool = fixed.length > 0 ? fixed : rows;
    const sorted = [...pool].sort((a, b) => {
        const ia = idxIndex >= 0 ? Number.parseInt(a[idxIndex] || '0', 10) : 0;
        const ib = idxIndex >= 0 ? Number.parseInt(b[idxIndex] || '0', 10) : 0;
        return (Number.isFinite(ia) ? ia : 0) - (Number.isFinite(ib) ? ib : 0);
    });
    for (const r of sorted) {
        const serial = r[idxSerial] || '';
        if (serial) return serial;
    }
    return '';
}

function collectWindows(): HardwareFactors {
    const raw = parseFactorLine(
        runFile(
            'powershell',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_PS_SCRIPT],
            PS_COLLECT_TIMEOUT_MS
        )
    );
    const factors: HardwareFactors = {
        cpu: normalizeFactor(raw[0]),
        board: normalizeFactor(raw[1]),
        disk: normalizeFactor(raw[2]),
        osGuid: normalizeFactor(raw[3]),
    };

    // 仅当某个因子为空才触发回退（wmic 在 Win11 24H2+ 已移除，故只作老系统兼容）
    if (!factors.cpu) {
        factors.cpu = normalizeFactor(parseWmicFirstValue(runFile('wmic', ['cpu', 'get', 'ProcessorId'], FALLBACK_CMD_TIMEOUT_MS)));
    }
    if (!factors.board) {
        factors.board = normalizeFactor(parseWmicFirstValue(runFile('wmic', ['baseboard', 'get', 'SerialNumber'], FALLBACK_CMD_TIMEOUT_MS)));
    }
    if (!factors.disk) {
        const csv = runFile('wmic', ['diskdrive', 'get', 'Index,MediaType,SerialNumber', '/format:csv'], FALLBACK_CMD_TIMEOUT_MS);
        factors.disk = normalizeFactor(selectWindowsFallbackDisk(csv));
    }
    if (!factors.osGuid) {
        const out = runFile('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], FALLBACK_CMD_TIMEOUT_MS);
        factors.osGuid = normalizeFactor(firstMatch(out, /MachineGuid\s+REG_SZ\s+(\S+)/i));
    }
    return factors;
}

// ── macOS / Linux 采集（尽力而为，任一因子缺失只记 NA） ─────────────────────

function collectDarwin(): HardwareFactors {
    const ioreg = runShell('ioreg -rd1 -c IOPlatformExpertDevice', POSIX_COLLECT_TIMEOUT_MS);
    const serial = firstMatch(ioreg, /"IOPlatformSerialNumber"\s*=\s*"([^"]+)"/);
    const uuid = firstMatch(ioreg, /"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    const prof = runShell('system_profiler SPSerialATADataType', POSIX_COLLECT_TIMEOUT_MS);
    const disk = firstMatch(prof, /Serial Number:\s*(\S+)/i);
    // macOS 不暴露 CPU 序列号，用平台序列号 + UUID 组合，保证维度固定且换机必变
    return {
        cpu: normalizeFactor(serial),
        board: normalizeFactor(uuid),
        disk: normalizeFactor(disk),
        osGuid: normalizeFactor(uuid),
    };
}

function linuxSystemDiskSerial(): string {
    const mounts = readTextFile('/proc/mounts');
    const rootLine = mounts
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .find((l) => /\s\/\s/.test(l));
    if (rootLine) {
        const dev = rootLine.split(/\s+/)[0] || '';
        const base = dev.split('/').pop() || '';
        const diskName = base.replace(/\d+$/, '');
        if (diskName) {
            const serial = readTextFile(path.join('/sys/class/block', diskName, 'serial'));
            if (serial) return serial;
        }
    }
    const lsblk = runShell('lsblk -no SERIAL', POSIX_COLLECT_TIMEOUT_MS);
    return lsblk
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0) || '';
}

function collectLinux(): HardwareFactors {
    const board = readTextFile('/sys/class/dmi/id/product_serial');
    const uuid = readTextFile('/sys/class/dmi/id/product_uuid');
    const machineId = readTextFile('/etc/machine-id') || readTextFile('/var/lib/dbus/machine-id');
    // Linux 无统一 CPU 序列号，用 DMI UUID 充当 CPU 维度因子
    return {
        cpu: normalizeFactor(uuid),
        board: normalizeFactor(board),
        disk: normalizeFactor(linuxSystemDiskSerial()),
        osGuid: normalizeFactor(machineId),
    };
}

function collect(): HardwareFactors {
    const p = os.platform();
    if (p === 'win32') return collectWindows();
    if (p === 'darwin') return collectDarwin();
    return collectLinux();
}

// ── 缓存：进程内 memo + safeStorage 落盘 ─────────────────────────────────

function cacheFilePath(): string {
    return path.join(os.homedir(), AI_TOOLS_DIR_NAME, MACHINE_CODE_CACHE_FILE);
}

/** safeStorage 在 app ready 之前调用会抛异常，这里一律吞掉并按「不可用」处理 */
function encryptionAvailable(): boolean {
    try {
        return safeStorage.isEncryptionAvailable();
    } catch {
        return false;
    }
}

function isFactorMap(v: unknown): v is HardwareFactors {
    if (!v || typeof v !== 'object') return false;
    const m = v as Record<string, unknown>;
    return typeof m.cpu === 'string' && typeof m.disk === 'string'
        && typeof m.board === 'string' && typeof m.osGuid === 'string';
}

/**
 * 读落盘缓存。任何异常/结构不符都返回 null（fail-closed → 重新采集）。
 * 仅在 safeStorage 可用时才存在有效缓存（Linux 缺 libsecret 时每次重采，Linux 采集 <100ms，无感）。
 */
function readDiskCache(): {pair: MachineIdPair; factors: HardwareFactors | null} | null {
    try {
        if (!encryptionAvailable()) return null;
        const file = cacheFilePath();
        if (!fs.existsSync(file)) return null;
        const decoded = safeStorage.decryptString(Buffer.from(fs.readFileSync(file, 'utf-8').trim(), 'base64'));
        const parsed = JSON.parse(decoded) as MachineCodeCacheFile | null;
        if (!parsed) return null;
        if (MACHINE_ID_PATTERN.test(parsed.strong) && MACHINE_ID_PATTERN.test(parsed.soft)) {
            return {
                pair: {strong: parsed.strong, soft: parsed.soft},
                factors: isFactorMap(parsed.factors) ? parsed.factors : null,
            };
        }
        return null;
    } catch {
        return null;
    }
}

/** 写落盘缓存；不加密可用时不写盘（宁可每次重采，也不明文落地可复用的机器码） */
function writeDiskCache(pair: MachineIdPair, factors: HardwareFactors): Promise<void> {
    if (!encryptionAvailable()) return Promise.resolve();
    const payload: MachineCodeCacheFile = {v: 1, strong: pair.strong, soft: pair.soft, factors};
    try {
        const encrypted = safeStorage.encryptString(JSON.stringify(payload)).toString('base64');
        return writeFileAtomic(cacheFilePath(), encrypted);
    } catch {
        return Promise.resolve();
    }
}

/**
 * 取归一化后的硬件因子（进程内 memo）。
 * 硬件变更宽限判定需要知道「cpu / board / osGuid 是否都非空」，因此因子必须可取。
 */
export function getHardwareFactors(): Promise<HardwareFactors> {
    if (!factorsPromise) factorsPromise = Promise.resolve(collect());
    return factorsPromise;
}

async function resolvePair(): Promise<MachineIdPair> {
    const cached = readDiskCache();
    if (cached) {
        if (cached.factors) factorsPromise = Promise.resolve(cached.factors);
        return cached.pair;
    }
    const factors = await getHardwareFactors();
    const pair = deriveMachineIds(factors);
    await writeDiskCache(pair, factors);
    return pair;
}

/**
 * 取强/弱双机器码（进程内 memo，整个进程生命周期有效，永不失效）。
 * 首次调用才会真正采集（Windows 约 3s），因此启动路径上应先用 `warmupMachineCode()` 预热。
 */
export function getMachineCodePair(): Promise<MachineIdPair> {
    if (!pairPromise) pairPromise = resolvePair();
    return pairPromise;
}

/** 取强绑定机器码（形如 XXXX-XXXX-XXXX-XXXX） */
export async function getMachineCode(): Promise<string> {
    return (await getMachineCodePair()).strong;
}

/**
 * 后台惰性复核：窗口 ready 后 2s 重采一次，与当前值不同则刷新进程内缓存与落盘缓存。
 * 只记录 diff 事件，不在此处做任何授权判定（状态机由 T03 的 `license/index.ts` 负责）。
 */
async function recheckInBackground(): Promise<void> {
    try {
        const current = await getMachineCodePair();
        // 复核必须**重新采集**，不能用进程内 memo（否则永远比对不出硬件变更）
        const freshFactors = collect();
        const fresh = deriveMachineIds(freshFactors);
        if (fresh.strong === current.strong && fresh.soft === current.soft) return;
        pairPromise = Promise.resolve(fresh);
        factorsPromise = Promise.resolve(freshFactors);
        await writeDiskCache(fresh, freshFactors);
        logLicenseEvent('LIC_INTERNAL', {event: 'machine_code_recheck_changed'});
    } catch (error) {
        logLicenseEvent('LIC_INTERNAL', {event: 'machine_code_recheck_failed', reason: (error as Error).name});
    }
}

/**
 * 预热：立即触发一次采集（结果进 memo 与落盘缓存），并安排在 2s 后做一次后台复核。
 * 由 `license/index.ts` 的 `init()`（T03）在 `app.whenReady()` 之后调用，不阻塞窗口显示。
 */
export function warmupMachineCode(): void {
    void getMachineCodePair().catch((error: Error) => {
        logLicenseEvent('LIC_INTERNAL', {event: 'machine_code_warmup_failed', reason: error.name});
    });
    const timer = setTimeout(() => {
        void recheckInBackground();
    }, BACKGROUND_RECHECK_DELAY_MS);
    // 后台任务不应阻止进程退出
    if (typeof timer.unref === 'function') timer.unref();
}
