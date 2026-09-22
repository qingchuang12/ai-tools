/**
 * CloudSyncService - 云端存储传输（单例）
 *
 * 设计：
 *  - 「云端」被当作一个客户端：本地暂存区 ~/.ai-tools/cloud/ai-tools 与云端 <remote>/ai-tools 目录同构。
 *    同步 MCP / Skill 到云客户端 = 写本地暂存区；push/pull 负责暂存区与远端之间的传输。
 *  - Git 通道调用系统 git CLI（与项目中 tar/PowerShell 解压一致的 shell-out 思路），
 *    凭据不写入 .git/config：token 拼进临时 URL 参数，SSH 走 GIT_SSH_COMMAND。
 *  - SFTP 通道用 ssh2-sftp-client，支持密钥与用户名+密码两种认证。
 *  - 仅手动触发，无后台自动同步。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import {execFile} from 'child_process';
import {promisify} from 'util';
import SftpClient from 'ssh2-sftp-client';
import {CLOUD_ROOT_DIR, type CloudSyncResult} from '../shared/cloud-sync-constants';
import type {SyncTaskScope} from '../shared/sync-task-types';
import {resolveScopeDirs} from '../shared/sync-scope';
import {getCloudSyncStore} from './cloud-sync-store';
import {EnvManager} from './env-manager';
import {assertFeature, GATE_LOCKED_MESSAGE} from './license/feature-gate';
import {FEATURE_CLOUD_SYNC} from '../shared/license-constants';

const execFileAsync = promisify(execFile);

/** git 命令超时（clone/push 可能较慢） */
const GIT_TIMEOUT = 120_000;
/** sftp 连接超时 */
const SFTP_TIMEOUT = 20_000;

export class CloudSyncService {
    private envManager = new EnvManager();
    /** 互斥锁：保证任意入口（队列/启动/直接 IPC）的 push/pull 串行，避免两个 git 进程争用 index.lock（P1-1） */
    private lockChain: Promise<unknown> = Promise.resolve();

    // ==================== 公开接口 ====================

    /** 测试连接：git 探 ls-remote；sftp 探连接 + 建 ai-tools 目录 */
    async testConnection(): Promise<CloudSyncResult> {
        const store = getCloudSyncStore();
        const cfg = store.getConfig();
        try {
            if (cfg.provider === 'git') return await this.gitTest();
            return await this.sftpTest();
        } catch (e: any) {
            return {ok: false, message: this.normalizeError(e)};
        }
    }

    /**
     * 上传：把本地暂存区推到云端（失败时自动重试，最多重试 2 次）。
     * @param scope 同步内容范围：'mcp' 只传 MCP 配置、'skills' 只传技能、
     *              'all'/缺省 传整个暂存区（兼容）。sftp 通道按子目录真实分开上传；
     *              git 通道只提交对应子目录变更（push 仍整仓库）。
     */
    async push(scope?: SyncTaskScope): Promise<CloudSyncResult> {
        const gate = await assertFeature(FEATURE_CLOUD_SYNC);
        if (!gate.allowed) return {ok: false, message: GATE_LOCKED_MESSAGE};
        return this.withLock(async () => {
        const store = getCloudSyncStore();
        if (!store.isActive()) return {ok: false, message: '云同步未配置或未启用'};
        store.ensureStagingDirs();
        this.writeManifest();
        const maxAttempts = 3; // 1 次 + 重试 2 次
        let last: CloudSyncResult = {ok: false, message: '未知错误'};
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const cfg = store.getConfig();
                const res = cfg.provider === 'git' ? await this.gitPush(scope) : await this.sftpPush(scope);
                if (res.ok) {
                    store.recordSync(res.message);
                    return res;
                }
                last = res;
                // 仅对可重试的传输错误重试，配置类错误直接返回
                if (!this.isRetryable(res.message)) {
                    return res;
                }
            } catch (e: any) {
                last = {ok: false, message: this.normalizeError(e)};
            }
            if (attempt < maxAttempts) {
                console.warn(`[CloudSync] push attempt ${attempt} failed, retrying...`, last.message);
                await new Promise(r => setTimeout(r, 1000 * attempt));
            }
        }
        return last;
        });
    }

    /** 判断错误是否值得重试（网络/超时/连接类） */
    private isRetryable(msg: string): boolean {
        return /timed? out|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|getaddrinfo|Could not resolve|connection (reset|closed)|EOF|reset by peer|EPIPE/i.test(msg);
    }

    /** 串行化任意 push/pull 调用，避免并发传输相互干扰 */
    private withLock<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.lockChain.then(() => fn());
        this.lockChain = run.then(() => undefined, () => undefined);
        return run;
    }

    /** 下载：把云端拉到本地暂存区（失败时自动重试，最多重试 2 次） */
    async pull(): Promise<CloudSyncResult> {
        // 与 push() 同构的授权门：未激活云同步 License 时禁止从云端下载，避免越权拉取。
        const gate = await assertFeature(FEATURE_CLOUD_SYNC);
        if (!gate.allowed) return {ok: false, message: GATE_LOCKED_MESSAGE};
        return this.withLock(async () => {
        const store = getCloudSyncStore();
        if (!store.isActive()) return {ok: false, message: '云同步未配置或未启用'};
        store.ensureStagingDirs();
        const maxAttempts = 3; // 1 次 + 重试 2 次
        let last: CloudSyncResult = {ok: false, message: '未知错误'};
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const cfg = store.getConfig();
                const res = cfg.provider === 'git' ? await this.gitPull() : await this.sftpPull();
                if (res.ok) {
                    store.recordSync(res.message);
                    return res;
                }
                last = res;
                if (!this.isRetryable(res.message)) {
                    return res;
                }
            } catch (e: any) {
                last = {ok: false, message: this.normalizeError(e)};
            }
            if (attempt < maxAttempts) {
                console.warn(`[CloudSync] pull attempt ${attempt} failed, retrying...`, last.message);
                await new Promise(r => setTimeout(r, 1000 * attempt));
            }
        }
        return last;
        });
    }

    // ==================== Git ====================

    /**
     * 构造带凭据的远端 URL。
     * https-token 模式把 token 拼进 URL 作为一次性命令参数，不写入 .git/config，避免明文落盘。
     */
    private gitRemoteUrl(): string {
        const store = getCloudSyncStore();
        const git = store.getConfig().git;
        const url = git.repoUrl.trim();
        if (git.authType !== 'https-token') return url;
        const token = store.revealSecret(git.tokenSecretId);
        if (!token) {
            // secretId 已配置但解密失败（密文失效），明确提示重存而非走无令牌的 URL
            if (store.isSecretStale(git.tokenSecretId)) {
                throw new Error('CLOUD_CREDENTIAL_STALE: 访问令牌已失效，请重新保存云同步凭据');
            }
            return url;
        }
        try {
            const u = new URL(url);
            u.username = encodeURIComponent(token);
            u.password = '';
            return u.toString();
        } catch {
            return url;
        }
    }

    /** git 子进程环境：增强 PATH + SSH 密钥 + 关掉交互式凭据弹窗 */
    private gitEnv(): NodeJS.ProcessEnv {
        const store = getCloudSyncStore();
        const git = store.getConfig().git;
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            PATH: this.envManager.getEnhancedPath(),
            // 任何需要交互输入的场景直接失败，而不是挂起等待用户
            GIT_TERMINAL_PROMPT: '0',
            GCM_INTERACTIVE: 'never',
        };
        if (git.authType === 'ssh-key' && git.privateKeyPath) {
            const key = git.privateKeyPath.replace(/\\/g, '/');
            env.GIT_SSH_COMMAND = `ssh -i "${key}" -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes -o BatchMode=yes`;
        }
        return env;
    }

    private async git(args: string[], cwd?: string): Promise<string> {
        const {stdout} = await execFileAsync('git', args, {
            cwd: cwd || getCloudSyncStore().getStagingRoot(),
            env: this.gitEnv(),
            timeout: GIT_TIMEOUT,
            maxBuffer: 10 * 1024 * 1024,
        });
        return (stdout || '').trim();
    }

    /** 确保暂存区是一个 git 仓库，并写好提交身份 */
    private async ensureRepo(): Promise<void> {
        const store = getCloudSyncStore();
        const root = store.getStagingRoot();
        store.ensureStagingDirs();
        if (!fs.existsSync(path.join(root, '.git'))) {
            await this.git(['init']);
        }
        const git = store.getConfig().git;
        await this.git(['config', 'user.name', git.userName || 'AI-Tools']);
        await this.git(['config', 'user.email', git.userEmail || 'ai-tools@localhost']);
    }

    private async gitTest(): Promise<CloudSyncResult> {
        const store = getCloudSyncStore();
        const git = store.getConfig().git;
        if (!git.repoUrl.trim()) return {ok: false, message: '请填写仓库地址'};

        const runtime = await this.envManager.checkGit();
        if (!runtime.available) {
            return {ok: false, message: '未检测到 git，请先安装 Git 后重试'};
        }

        const out = await this.git(['ls-remote', '--heads', this.gitRemoteUrl()], os.tmpdir());
        const hasBranch = out.includes(`refs/heads/${git.branch}`);
        return {
            ok: true,
            message: hasBranch
                ? `连接成功，已找到分支 ${git.branch}（git ${runtime.version}）`
                : `连接成功，但远端还没有分支 ${git.branch}，首次上传时会自动创建`,
        };
    }

    private async gitPull(): Promise<CloudSyncResult> {
        const store = getCloudSyncStore();
        const git = store.getConfig().git;
        await this.ensureRepo();

        const url = this.gitRemoteUrl();
        const heads = await this.git(['ls-remote', '--heads', url, git.branch], os.tmpdir());
        if (!heads.trim()) {
            return {ok: true, message: `云端分支 ${git.branch} 还是空的，没有可下载的内容`, changed: false};
        }

        await this.git(['fetch', url, git.branch]);
        // 保护未推送 / 未提交的本地改动：硬重置前先提交到本地备份分支，
        // 否则上次失败重试的任务里用户的本地修改会被无声丢弃（P0-2）。
        const statusBefore = await this.git(['status', '--porcelain']).catch(() => '');
        if (statusBefore.trim()) {
            const backupBranch = `backup-before-pull-${Date.now()}`;
            try {
                await this.git(['checkout', '-b', backupBranch]);
                await this.git(['add', '-A']);
                await this.git(['commit', '-m', `auto-backup before pull @ ${new Date().toISOString()}`]);
                await this.git(['checkout', git.branch]);
            } catch (e: any) {
                console.warn('[CloudSync] 创建 pull 前备份分支失败（继续硬重置）:', e?.message);
            }
        }
        // 暂存区是应用私有目录，以远端为准硬重置；未提交改动已备份到本地分支。
        await this.git(['reset', '--hard', 'FETCH_HEAD']);
        store.ensureStagingDirs();
        return {ok: true, message: '已从云端下载最新内容', changed: true};
    }

    private async gitPush(scope?: SyncTaskScope): Promise<CloudSyncResult> {
        const store = getCloudSyncStore();
        const git = store.getConfig().git;
        await this.ensureRepo();

        // 按 scope 只把对应子目录纳入提交：mcp / skills 各自独立，互不牵连。
        // 整仓库 push 仍会发生，但仅提交本次 scope 涉及的子目录变更。
        const addArg = scope === 'mcp'
            ? 'ai-tools/mcp'
            : scope === 'skills'
                ? 'ai-tools/skills'
                : '-A';
        await this.git(['add', '-A', addArg]);
        // 判定本 scope 是否有暂存变更（P1-2）：用带 pathspec 的 diff --cached --quiet，
        // 退出码 0 = 无差异，1 = 有差异（this.git 在非零退出时抛错，故 catch 即视为有变更）。
        let staged = false;
        if (scope === 'mcp' || scope === 'skills') {
            const scopePath = scope === 'mcp' ? 'ai-tools/mcp' : 'ai-tools/skills';
            try {
                await this.git(['diff', '--cached', '--quiet', '--', scopePath]);
            } catch {
                staged = true;
            }
        } else {
            staged = (await this.git(['status', '--porcelain'])).trim().length > 0;
        }
        if (staged) {
            await this.git(['commit', '-m', `sync ${scope || 'all'} from ${os.hostname()} @ ${new Date().toISOString()}`]);
        }

        const hasCommit = await this.git(['rev-parse', '--verify', 'HEAD']).catch(() => '');
        if (!hasCommit) {
            return {ok: true, message: '暂存区没有可上传的内容', changed: false};
        }

        const url = this.gitRemoteUrl();
        try {
            await this.git(['push', url, `HEAD:refs/heads/${git.branch}`]);
        } catch (e: any) {
            console.error('[CloudSync] git push failed:', e?.stderr || e?.message || e);
            return {ok: false, message: this.normalizeError(e)};
        }
        return {
            ok: true,
            message: staged ? '已上传到云端' : '云端已是最新，无需上传',
            changed: !!staged,
        };
    }

    // ==================== SFTP ====================

    private async sftpConnect(): Promise<SftpClient> {
        const store = getCloudSyncStore();
        const sftp = store.getConfig().sftp;
        const client = new SftpClient();

        const opts: Record<string, any> = {
            host: sftp.host.trim(),
            port: sftp.port || 22,
            username: sftp.username.trim(),
            readyTimeout: SFTP_TIMEOUT,
        };

        if (sftp.authType === 'password') {
            const password = store.revealSecret(sftp.passwordSecretId);
            if (!password) {
                if (store.isSecretStale(sftp.passwordSecretId)) {
                    throw new Error('CLOUD_CREDENTIAL_STALE: 登录密码已失效，请重新保存云同步凭据');
                }
                opts.password = '';
            } else {
                opts.password = password;
            }
        } else {
            if (!sftp.privateKeyPath) throw new Error('请填写私钥文件路径');
            opts.privateKey = fs.readFileSync(sftp.privateKeyPath);
            const passphrase = store.revealSecret(sftp.passphraseSecretId);
            if (passphrase) opts.passphrase = passphrase;
            else if (store.isSecretStale(sftp.passphraseSecretId)) {
                throw new Error('CLOUD_CREDENTIAL_STALE: 私钥口令已失效，请重新保存云同步凭据');
            }
        }

        await client.connect(opts as any);
        return client;
    }

    /** 云端根目录：<remoteDir>/ai-tools（posix 分隔符） */
    private remoteDataDir(): string {
        const sftp = getCloudSyncStore().getConfig().sftp;
        const base = (sftp.remoteDir || '/').replace(/\/+$/, '');
        return `${base}/${CLOUD_ROOT_DIR}`;
    }

    private async sftpTest(): Promise<CloudSyncResult> {
        const cfg = getCloudSyncStore().getConfig().sftp;
        if (!cfg.host.trim() || !cfg.username.trim()) {
            return {ok: false, message: '请填写主机与用户名'};
        }
        const client = await this.sftpConnect();
        try {
            const remote = this.remoteDataDir();
            // 自动创建云端 ai-tools 存储目录
            if (!(await client.exists(remote))) await client.mkdir(remote, true);
            return {ok: true, message: `连接成功，云端存储目录：${remote}`};
        } finally {
            await client.end().catch(() => {
            });
        }
    }

    private async sftpPush(scope?: SyncTaskScope): Promise<CloudSyncResult> {
        const store = getCloudSyncStore();
        const client = await this.sftpConnect();

        // 按 scope 决定上传哪个子目录：mcp / skills 各自独立；all/缺省 传整个 ai-tools
        const {local, remote} = resolveScopeDirs(scope, store.getStagingDataDir(), this.remoteDataDir());

        const scopeLabel = scope === 'mcp' ? 'MCP 配置' : scope === 'skills' ? '技能' : '内容';
        try {
            // 本地暂存区（子目录）必须存在且有内容，否则没有可上传的东西
            let localEntries: string[] = [];
            try {
                localEntries = fs.readdirSync(local);
            } catch {
                return {ok: false, message: `本地暂存区不存在，请先同步${scopeLabel}到云端再上传`};
            }
            if (localEntries.length === 0) {
                return {ok: false, message: `本地暂存区没有可上传的${scopeLabel}`};
            }

            // 稳妥创建远端目录：exists 抛错也视为不存在，mkdir 父链已存在则忽略
            try {
                const exists = await client.exists(remote);
                if (!exists) await client.mkdir(remote, true);
            } catch (e: any) {
                console.warn('[CloudSync] sftp mkdir check skipped:', e?.message);
                try {
                    await client.mkdir(remote, true);
                } catch { /* 已存在则忽略 */ }
            }

            await client.uploadDir(local, remote);
            // 镜像清理：uploadDir 只增量上传，不会删除远端本地已删除的文件/目录。
            // 这里递归比对远端与本地（限定在 scope 子目录内），删除远端多余项，
            // 使 Skill 卸载等操作真正生效，且不会误删另一范围的内容。
            await this.mirrorRemote(client, local, remote);
            return {ok: true, message: '已上传到云端', changed: true};
        } catch (e: any) {
            console.error('[CloudSync] sftp push failed:', e?.message || e, e?.stack);
            return {ok: false, message: this.normalizeError(e)};
        } finally {
            await client.end().catch(() => {
            });
        }
    }

    /**
     * 镜像清理：删除远端存在但本地暂存区已不存在的文件/目录。
     * 解决 ssh2-sftp-client 的 uploadDir 只增量上传、不会删除远端遗留项的问题
     * （例如 Skill 目录级卸载后，远端仍残留该 Skill 目录）。
     */
    private async mirrorRemote(
        client: SftpClient,
        localDir: string,
        remoteDir: string
    ): Promise<void> {
        let listing: Array<{ name: string; type: string }> = [];
        try {
            const status = await client.exists(remoteDir);
            if (!status) return;
            listing = await client.list(remoteDir);
        } catch (e: any) {
            console.warn('[CloudSync] mirrorRemote list skipped:', e?.message);
            return;
        }

        for (const item of listing) {
            const localPath = path.join(localDir, item.name);
            const remotePath = `${remoteDir}/${item.name}`;
            const localExists = fs.existsSync(localPath);
            if (!localExists) {
                // 本地已删除 → 远端同步删除
                try {
                    await client.rmdir(remotePath, true);
                } catch (e: any) {
                    console.warn('[CloudSync] mirrorRemote remove failed:', remotePath, e?.message);
                }
            } else if (item.type === 'd') {
                // 目录：递归比对子级
                await this.mirrorRemote(client, localPath, remotePath);
            }
        }
    }

    private async sftpPull(): Promise<CloudSyncResult> {
        const store = getCloudSyncStore();
        const client = await this.sftpConnect();
        try {
            const remote = this.remoteDataDir();
            if (!(await client.exists(remote))) {
                await client.mkdir(remote, true);
                return {ok: true, message: '云端存储目录为空，没有可下载的内容', changed: false};
            }
            await client.downloadDir(remote, store.getStagingDataDir());
            // 以云端为准：删除本地暂存区中云端已不存在的文件/目录，
            // 否则 downloadDir 仅增量下载，本地残留会保留并与云端不一致。
            await this.mirrorLocal(client, remote, store.getStagingDataDir());
            store.ensureStagingDirs();
            return {ok: true, message: '已从云端下载最新内容', changed: true};
        } finally {
            await client.end().catch(() => {
            });
        }
    }

    /**
     * 以云端为准清理本地：删除本地暂存区存在但远端已不存在的文件/目录。
     * 解决 ssh2-sftp-client 的 downloadDir 只增量下载、不删除本地多余项的问题
     * （表现：启动拉取后「本地还有、云端没有」）。
     */
    private async mirrorLocal(
        client: SftpClient,
        remoteDir: string,
        localDir: string,
        trashRoot?: string
    ): Promise<void> {
        // 回收站放在暂存区「外面」（与 ai-tools 子目录同级），既不在同步范围内，
        // 又与原文件同文件系统可原子 rename（P0-1）。
        const trash = trashRoot ?? path.join(path.dirname(localDir), '.cloud-trash', `pull-${Date.now()}`);
        let localEntries: Array<{ name: string; isDirectory: () => boolean }> = [];
        try {
            localEntries = fs.readdirSync(localDir, {withFileTypes: true});
        } catch {
            return;
        }
        for (const entry of localEntries) {
            // 不处理回收站目录本身，避免自引用
            if (entry.name === '.cloud-trash') continue;
            const localPath = path.join(localDir, entry.name);
            const remotePath = `${remoteDir}/${entry.name}`;
            let remoteExists: boolean;
            try {
                remoteExists = !!(await client.exists(remotePath));
            } catch (e: any) {
                // 远端探测失败：无法确认文件是否仍存在，宁可中止整个清理也不冒险删除本地文件。
                throw new Error(
                    `[CloudSync] 拉取清理中止：远端探测 ${remotePath} 失败 (${e?.message || e})，已避免误删本地文件`
                );
            }
            if (!remoteExists) {
                // 删除前先移入回收站，出现问题时可从 .cloud-trash 恢复，而非直接 rm 丢失。
                const rel = path.relative(localDir, localPath);
                const target = path.join(trash, rel);
                try {
                    fs.mkdirSync(path.dirname(target), {recursive: true});
                    fs.renameSync(localPath, target);
                } catch (e: any) {
                    console.warn('[CloudSync] mirrorLocal 移至回收站失败（保留原文件）:', localPath, e?.message);
                }
            } else if (entry.isDirectory()) {
                await this.mirrorLocal(client, remotePath, localPath, trash);
            }
        }
    }

    // ==================== 工具 ====================

    /** 写一份清单，便于在云端识别来源设备与时间 */
    private writeManifest(): void {
        const store = getCloudSyncStore();
        const file = path.join(store.getStagingDataDir(), 'manifest.json');
        const data = {
            version: 1,
            updatedAt: new Date().toISOString(),
            device: os.hostname(),
            platform: process.platform,
        };
        try {
            fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
        } catch {
            /* 清单写入失败不阻断同步 */
        }
    }

    /** 错误归一：把底层报错翻译成可读提示 */
    private normalizeError(e: any): string {
        const raw = [e?.stderr, e?.message, String(e)].find(x => x && String(x).trim()) || '未知错误';
        const msg = String(raw);

        // 凭据密文失效（密钥变化导致解密失败）：明确提示用户重新保存，而非报「密码错误」
        if (msg.includes('CLOUD_CREDENTIAL_STALE:')) {
            return msg.split('CLOUD_CREDENTIAL_STALE:')[1].trim() || '云同步凭据已失效，请重新保存密码';
        }

        if (e?.code === 'ENOENT' && /git/i.test(msg)) return '未检测到 git，请先安装 Git 后重试';
        if (e?.killed || /ETIMEDOUT|timed? out/i.test(msg)) return '连接超时，请检查网络或主机地址';
        if (/Authentication failed|All configured authentication methods failed|Permission denied \(publickey/i.test(msg)) {
            return '认证失败，请检查密钥 / 密码是否正确';
        }
        if (/could not read Username|terminal prompts disabled|Invalid username or password/i.test(msg)) {
            return '认证失败，请检查访问令牌是否正确或已过期';
        }
        if (/Repository not found|does not appear to be a git repository/i.test(msg)) {
            return '仓库不存在或无访问权限，请检查仓库地址';
        }
        if (/ENOTFOUND|getaddrinfo|Could not resolve host/i.test(msg)) return '无法解析主机地址，请检查网络与地址拼写';
        if (/ECONNREFUSED/i.test(msg)) return '连接被拒绝，请检查主机与端口';
        if (/No such file/i.test(msg)) return '远程路径不存在，请检查远程目录配置';

        return msg.split('\n').slice(0, 3).join(' ').slice(0, 300);
    }
}

// ==================== 单例 ====================
let instance: CloudSyncService | null = null;

export function getCloudSyncService(): CloudSyncService {
    if (!instance) instance = new CloudSyncService();
    return instance;
}
