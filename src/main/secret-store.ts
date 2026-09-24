/**
 * SecretStore - API 令牌加密存储（单例）
 *
 * 安全设计：
 *  - 令牌 secret 明文永不明文落盘，使用 AES-256-GCM 加密后存于独立 .enc 文件。
 *  - 加密密钥基于机器特征派生（复用 cache-manager 的思路，scryptSync），避免系统钥匙串弹窗。
 *  - 令牌元数据（名称、scope、有效期、状态等）明文存 metadata.json，便于列表展示。
 *  - secret 仅在 reveal / 连接验证时短暂解密到内存。
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {app, safeStorage} from 'electron';
import {type TokenScope} from '../shared/platform-constants';

export type {TokenScope} from '../shared/platform-constants';
export {ALL_TOKEN_SCOPES} from '../shared/platform-constants';

// ==================== 加密常量（与 cache-manager 保持一致） ====================
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

// ==================== 类型定义 ====================

/** 令牌元数据（不含 secret 明文） */
export interface TokenMeta {
    id: string;
    name: string;
    scopes: TokenScope[];
    /** 过期时间戳(ms)，null = 永不过期 */
    expiresAt: number | null;
    createdAt: number;
    /** 是否已撤销 */
    revoked: boolean;
    /** 明文前 6 位预览，便于列表中识别 */
    preview: string;
    /** 来源平台标识（可选，用于区分外部平台 API key） */
    platform?: string;
    /** 令牌类型：imported=从外部平台粘贴；generated=本地生成 */
    kind?: 'imported' | 'generated';
}

const PLATFORM_DEFAULT_SCOPES: TokenScope[] = ['skills:read', 'skills:download'];

/**
 * 归一化外部平台 API key：
 *  - 去除首尾空白与换行
 *  - 去除常见 HTTP 鉴权前缀（Bearer / bearer / Token 等），只保留纯 secret
 *  - 去除内部多余空白
 * 这样无论用户粘贴 "Bearer xxx"、"xxx" 还是带换行/空格的，都归一为纯令牌。
 */
export function normalizeTokenSecret(raw: string): string {
    let s = (raw || '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
    // 剥除形如 "Bearer xxx" / "bearer: xxx" / "Token xxx" 的前缀
    const prefixMatch = s.match(/^(Bearer|bearer|token|apikey|api[-_]?key)\s*[:=]?\s*/i);
    if (prefixMatch) s = s.slice(prefixMatch[0].length).trim();
    return s;
}

// ==================== SecretStore 单例 ====================

export class SecretStore {
    private dir: string;
    private metaPath: string;
    private key: Buffer;
    private metaCache: TokenMeta[] = [];

    constructor() {
        const home = app.getPath('home');
        this.dir = path.join(home, '.ai-tools', 'secrets');
        this.metaPath = path.join(this.dir, 'metadata.json');
        this.key = this.deriveKey();
        this.ensureDir();
        this.loadMeta();
    }

    // ---------- 加密 ----------
    /**
     * 派生加密密钥。
     *
     * 关键约束：密钥必须「开发模式（electron .）」与「打包安装模式」完全一致，
     * 否则打包后无法解密开发期写入的密文（反之亦然），表现为「更新后云同步密码错误」。
     *
     * 因此密钥只依赖机器级、跨模式稳定的特征：
     *   - process.platform / process.arch：运行环境，dev 与打包相同
     *   - app.getPath('home')：用户主目录，dev 与打包相同
     * 不依赖 app.getName() / productName 等会随打包/启动方式变化的字段（这正是此前
     * dev↔打包 密钥不一致的隐患来源）。
     */
    private deriveKey(): Buffer {
        const machineId = [
            process.platform,
            process.arch,
            app.getPath('home'),
        ].join('-');
        return crypto.scryptSync(machineId, 'mcp-dock-secret-v1', KEY_LENGTH);
    }

    /**
     * 优先使用 Electron safeStorage（OS 级钥匙串，密钥由系统保管，P1-4），
     * 仅在不可用时回退到基于机器特征的 AES-256-GCM（兼容旧密文）。
     * 新格式以魔法前缀 `SS1\n` 标记，旧 AES 格式走 legacy 分支。
     */
    private static safeStorageAvailable(): boolean {
        try {
            return !!safeStorage && safeStorage.isEncryptionAvailable();
        } catch {
            return false;
        }
    }

    private encrypt(plaintext: string): Buffer {
        if (SecretStore.safeStorageAvailable()) {
            const enc = safeStorage.encryptString(plaintext);
            return Buffer.concat([Buffer.from('SS1\n', 'latin1'), enc]);
        }
        return this.encryptLegacy(plaintext);
    }

    private decrypt(buf: Buffer): string {
        if (buf.length > 4 && buf.subarray(0, 4).toString('latin1') === 'SS1\n') {
            if (!SecretStore.safeStorageAvailable()) {
                throw new Error('safeStorage 不可用，无法解密该凭据（请在支持系统钥匙串的环境下运行）');
            }
            return safeStorage.decryptString(buf.subarray(4));
        }
        return this.decryptLegacy(buf);
    }

    private encryptLegacy(plaintext: string): Buffer {
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);
        const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return Buffer.concat([iv, tag, enc]);
    }

    private decryptLegacy(buf: Buffer): string {
        if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH) throw new Error('invalid ciphertext');
        const iv = buf.subarray(0, IV_LENGTH);
        const tag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
        const data = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
        const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    }

    private secretPath(id: string): string {
        return path.join(this.dir, `${id}.enc`);
    }

    private ensureDir(): void {
        if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, {recursive: true});
    }

    private loadMeta(): void {
        try {
            const raw = fs.readFileSync(this.metaPath, 'utf-8');
            this.metaCache = JSON.parse(raw) as TokenMeta[];
        } catch {
            this.metaCache = [];
        }
    }

    private persistMeta(): void {
        fs.writeFileSync(this.metaPath, JSON.stringify(this.metaCache, null, 2), 'utf-8');
    }

    // ---------- CRUD ----------

    /** 生成新令牌 */
    createToken(name: string, scopes: TokenScope[], expiresAt: number | null): TokenMeta {
        const id = `tok_${crypto.randomBytes(8).toString('hex')}`;
        const secret = crypto.randomBytes(24).toString('hex');
        const meta: TokenMeta = {
            id,
            name: name.trim() || 'untitled-token',
            scopes: scopes.length ? scopes : PLATFORM_DEFAULT_SCOPES,
            expiresAt,
            createdAt: Date.now(),
            revoked: false,
            preview: secret.slice(0, 6),
        };
        // 加密写 secret
        fs.writeFileSync(this.secretPath(id), this.encrypt(secret), {mode: 0o600});
        this.metaCache.push(meta);
        this.persistMeta();
        return meta;
    }

    /**
     * 导入外部平台 API key（如 ModelScope / SafeSkill / SkillHub 的令牌）。
     * rawKey 会先归一化（剥 Bearer 前缀、去空格/换行），只存储纯 secret；
     * 注入直连请求时由 connections-store 统一加 `Bearer ` 前缀。
     */
    importToken(rawKey: string, name: string, platform?: string, expiresAt: number | null = null): TokenMeta {
        const secret = normalizeTokenSecret(rawKey);
        if (!secret || secret.length < 8) {
            throw new Error('API key 无效：长度过短或为空，请粘贴完整的平台令牌');
        }
        const id = `tok_${crypto.randomBytes(8).toString('hex')}`;
        const meta: TokenMeta = {
            id,
            name: name.trim() || '未命名令牌',
            scopes: PLATFORM_DEFAULT_SCOPES,
            expiresAt,
            createdAt: Date.now(),
            revoked: false,
            preview: secret.slice(0, 6),
            platform,
            kind: 'imported',
        };
        fs.writeFileSync(this.secretPath(id), this.encrypt(secret), {mode: 0o600});
        this.metaCache.push(meta);
        this.persistMeta();
        return meta;
    }

    /** 列出所有令牌元数据（不含 secret） */
    listTokens(): TokenMeta[] {
        return this.metaCache.slice().sort((a, b) => b.createdAt - a.createdAt);
    }

    /** 一次性解密返回完整 secret 明文（仅用于查看/复制） */
    revealToken(id: string): string | null {
        const meta = this.metaCache.find(t => t.id === id);
        if (!meta) return null;
        try {
            const buf = fs.readFileSync(this.secretPath(id));
            return this.decrypt(buf);
        } catch {
            return null;
        }
    }

    /** 供连接验证/导出使用：返回 secret（已撤销或过期返回 null） */
    getSecretToken(id: string): string | null {
        const meta = this.metaCache.find(t => t.id === id);
        if (!meta || meta.revoked) return null;
        if (meta.expiresAt && meta.expiresAt < Date.now()) return null;
        return this.revealToken(id);
    }

    /** 撤销令牌（同时让关联连接变为 token_revoked） */
    revokeToken(id: string): TokenMeta | null {
        const meta = this.metaCache.find(t => t.id === id);
        if (!meta) return null;
        meta.revoked = true;
        this.persistMeta();
        // 延迟引入避免循环依赖：通过回调通知连接store
        this.onRevoke?.(id);
        return meta;
    }

    /** 恢复令牌（撤销的反向操作） */
    restoreToken(id: string): TokenMeta | null {
        const meta = this.metaCache.find(t => t.id === id);
        if (!meta) return null;
        meta.revoked = false;
        this.persistMeta();
        return meta;
    }

    /** 删除令牌（同时删除加密文件与关联连接） */
    deleteToken(id: string): void {
        this.metaCache = this.metaCache.filter(t => t.id !== id);
        try {
            fs.unlinkSync(this.secretPath(id));
        } catch {
            // 文件可能不存在
        }
        this.persistMeta();
        this.onDelete?.(id);
    }

    // ---------- 通用密文（非令牌体系） ----------
    // 用于云同步等场景的 SSH 口令 / SFTP 密码 / Git Token：
    // 复用同一套 AES-256-GCM 加密与 0o600 权限，但不进 metadata.json，也不参与撤销/过期逻辑。

    /**
     * 写入（或覆盖）一段密文，返回其 id。
     * 传入已有 id 时原地覆盖，便于「编辑时只改密码」的场景复用同一 id。
     */
    putRawSecret(id: string | null, plaintext: string): string {
        const secretId = id || `sec_${crypto.randomBytes(8).toString('hex')}`;
        fs.writeFileSync(this.secretPath(secretId), this.encrypt(plaintext), {mode: 0o600});
        return secretId;
    }

    /** 读取密文明文，不存在或解密失败返回 null */
    getRawSecret(id: string): string | null {
        let raw: Buffer;
        try {
            raw = fs.readFileSync(this.secretPath(id));
        } catch (e) {
            // 文件不存在 = 「从未保存过」（如首次运行尚未登录、还没写过 token），是正常态，静默返回 null；
            // 其余读取异常照实打印。
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
            console.error(`[SecretStore] 读取密文失败 secretId=${id}:`, (e as Error).message);
            return null;
        }
        try {
            return this.decrypt(raw);
        } catch (e) {
            // 解密失败通常是「密钥与写入时不一致」（如 dev↔打包 切换导致派生密钥变化）。
            // 静默返回 null 会让上层误报「密码错误」且无从排查，这里打印明确告警。
            console.error(`[SecretStore] 解密密文失败 secretId=${id}（可能因密钥与写入时不一致，密文已失效需重新保存）:`, (e as Error).message);
            return null;
        }
    }

    /** 密文文件是否存在（用于区分「从未保存」与「已保存但解密失败」） */
    existsRawSecret(id: string): boolean {
        try {
            fs.accessSync(this.secretPath(id));
            return true;
        } catch {
            return false;
        }
    }

    /** 删除密文文件 */
    deleteRawSecret(id: string): void {
        try {
            fs.unlinkSync(this.secretPath(id));
        } catch {
            // 文件可能不存在
        }
    }

    /** 令牌是否已过期（不含撤销判断） */
    isExpired(meta: TokenMeta): boolean {
        return !!meta.expiresAt && meta.expiresAt < Date.now();
    }

    /** 注册撤销/删除回调，避免与 ConnectionsStore 循环依赖 */
    onRevoke?: (tokenId: string) => void;
    onDelete?: (tokenId: string) => void;
}

// ==================== 单例 ====================
let instance: SecretStore | null = null;

export function getSecretStore(): SecretStore {
    if (!instance) instance = new SecretStore();
    return instance;
}
