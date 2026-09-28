/**
 * 云同步共享常量与类型（main / renderer 双端引用）
 *
 * 设计：
 *  - 把云端当作一个「客户端」看待：本地暂存区 ~/.ai-tools/cloud/ai-tools 与云端 <remote>/ai-tools 目录同构。
 *  - 凭据明文不落 cloud-sync.json，只存 SecretStore 里的 secretId 引用。
 *  - 前端表单用 *Input 字段传明文，主进程落盘前换成 secretId。
 */

/** 云端存储提供方 */
export type CloudProvider = 'git' | 'sftp';

/** 云端自动创建的存储目录名（MCP 与 Skill 都存在它下面） */
export const CLOUD_ROOT_DIR = 'ai-tools';

/** 云客户端在 ClientType 中的固定 id */
export const CLOUD_CLIENT_ID = 'cloud';

/** Git 认证方式 */
export type GitAuthType = 'ssh-key' | 'https-token' | 'none';

/** SFTP 认证方式 */
export type SftpAuthType = 'password' | 'key';

export interface GitCloudConfig {
  repoUrl: string;
  branch: string;
  authType: GitAuthType;
  /** SSH 私钥文件路径（authType=ssh-key） */
  privateKeyPath?: string;
  /** 私钥口令的 secretId（可选） */
  passphraseSecretId?: string;
  /** HTTPS 访问令牌的 secretId（authType=https-token） */
  tokenSecretId?: string;
  /** commit 身份 */
  userName?: string;
  userEmail?: string;
}

export interface SftpCloudConfig {
  host: string;
  port: number;
  username: string;
  authType: SftpAuthType;
  /** 登录密码的 secretId（authType=password） */
  passwordSecretId?: string;
  /** SSH 私钥文件路径（authType=key） */
  privateKeyPath?: string;
  /** 私钥口令的 secretId（可选） */
  passphraseSecretId?: string;
  /** 远程根目录，ai-tool 会建在它下面 */
  remoteDir: string;
}

export interface CloudSyncConfig {
  enabled: boolean;
  provider: CloudProvider;
  git: GitCloudConfig;
  sftp: SftpCloudConfig;
  lastSyncAt: number | null;
  lastSyncMessage?: string;
}

/**
 * 前端提交的配置补丁：在 CloudSyncConfig 基础上，用 *Input 字段携带明文凭据。
 * 约定：字段缺省 = 不修改；空字符串 = 清除该凭据。
 */
export interface CloudSyncConfigInput {
  enabled?: boolean;
  provider?: CloudProvider;
  git?: Omit<GitCloudConfig, 'passphraseSecretId' | 'tokenSecretId'> & {
    passphraseInput?: string;
    tokenInput?: string;
  };
  sftp?: Omit<SftpCloudConfig, 'passwordSecretId' | 'passphraseSecretId'> & {
    passwordInput?: string;
    passphraseInput?: string;
  };
}

/** 传输操作的统一返回 */
export interface CloudSyncResult {
  ok: boolean;
  message: string;
  /** 本次操作是否真的产生了变更（git 无改动时为 false） */
  changed?: boolean;
}

/**
 * push 行为选项。
 * 默认（缺省）只增量上传——绝不删除云端内容，避免陈旧设备把其他设备新推的内容清掉（P1-b）。
 * mirror / deletes 都是「以本地为准」的显式操作，仅由用户确认过的入口传入。
 */
export interface SyncPushOptions {
  /** 镜像模式：上传后删除「云端有而本地暂存区没有」的项（仅 sftp 通道生效；git 通道由非快进拒绝保护） */
  mirror?: boolean;
  /** 定向删除的 Skill 名清单（卸载联动；仅 skills 范围生效） */
  deletes?: string[];
}

/** 默认配置 */
export function defaultCloudSyncConfig(): CloudSyncConfig {
  return {
    enabled: false,
    provider: 'git',
    git: {
      repoUrl: '',
      branch: 'main',
      authType: 'none',
      userName: 'AI-Tools',
      userEmail: 'ai-tools@localhost',
    },
    sftp: {
      host: '',
      port: 22,
      username: '',
      authType: 'password',
      remoteDir: '/',
    },
    lastSyncAt: null,
  };
}
