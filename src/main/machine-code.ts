/**
 * 机器码生成
 *
 * 基于「CPU 序列号 + 主板 UUID + 网卡 MAC 地址」采集硬件指纹，
 * 经 SHA-256 派生出稳定且唯一的机器码。跨平台通过 child_process 调用
 * 各平台原生命令实现，不引入额外依赖（避免打包体积与兼容风险）。
 *
 * 渲染层无 Node/hardware 权限，机器码必须在主进程采集后经由 IPC 下发。
 */

import {execSync} from 'child_process';
import {createHash} from 'crypto';
import os from 'os';

/** 执行命令并裁剪输出；超时/失败返回空串，保证单条信息缺失也不致命 */
function run(cmd: string, timeoutMs = 5000): string {
    try {
        return execSync(cmd, { windowsHide: true, timeout: timeoutMs, encoding: 'utf-8' })
            .toString()
            .trim();
    } catch {
        return '';
    }
}

/** 取首个匹配的硬件标识；无匹配则返回空串 */
function firstMatch(text: string, re: RegExp): string {
    const m = text.match(re);
    return m ? m[1].trim() : '';
}

function getCpuId(): string {
    const p = os.platform();
    if (p === 'win32') {
        return run('wmic cpu get ProcessorId')
            .replace(/ProcessorId/i, '')
            .replace(/\s+/g, '');
    }
    if (p === 'darwin') {
        return firstMatch(run('ioreg -l | grep IOPlatformSerialNumber'), /"(.*)"/);
    }
    // Linux：优先 DMI 序列号，回退 hostid
    return (
        run('cat /sys/class/dmi/id/product_serial 2>/dev/null')
        || firstMatch(run('grep -i serial /proc/cpuinfo'), /serial\s*:\s*(\S+)/)
        || run('hostid')
    ).trim();
}

function getBoardUuid(): string {
    const p = os.platform();
    if (p === 'win32') {
        return run('wmic csproduct get UUID')
            .replace(/UUID/i, '')
            .replace(/\s+/g, '');
    }
    if (p === 'darwin') {
        return firstMatch(run('ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID'), /"(.*)"/);
    }
    return run('cat /sys/class/dmi/id/product_uuid 2>/dev/null').trim();
}

function getMac(): string {
    const p = os.platform();
    if (p === 'win32') {
        const out = run('getmac');
        const m = out.match(/([0-9A-Fa-f]{2}[-:]){5}[0-9A-Fa-f]{2}/);
        return m ? m[0].replace(/[:-]/g, '').toUpperCase() : '';
    }
    if (p === 'darwin') {
        const m = run('ifconfig en0 | awk \'/ether/{print $2}\'')
            || run('networksetup -listallhardwareports | awk \'/Ethernet Address/{print $3}\'');
        return (m || '').replace(/[:-]/g, '').toUpperCase();
    }
    const m = run('ip link | awk \'/ether/{print $2}\' | head -1');
    return (m || '').replace(/[:-]/g, '').toUpperCase();
}

/**
 * 生成本机机器码。
 * 采集三项硬件标识，拼接后 SHA-256 派生，格式：AI-XXXX-XXXX-XXXX-XXXX（前 16 位十六进制）。
 * 哈希保证稳定、定长、不可逆；任一硬件项缺失不影响其它项参与派生。
 */
export function getMachineCode(): string {
    const raw = [getCpuId(), getBoardUuid(), getMac()].join('|');
    const hash = createHash('sha256').update(raw).digest('hex').toUpperCase();
    const code = hash.slice(0, 16);
    return 'AI-' + code.replace(/(.{4})/g, '$1-').replace(/-$/, '');
}
