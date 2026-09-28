/**
 * 识别「客户端托管代理型」远程 MCP 条目。
 *
 * 部分客户端从自家市场安装远程 MCP 时，会在条目里同时写下上游直连地址与自家代理地址
 * （字段名为 `<客户端>_url`，如 Qoder 的 `qoder_url`）。代理地址凭该客户端的登录态鉴权，
 * 凭证不落配置文件，因此外部工具（含本 Inspector）拿它必然连不上；能用的只有 `url`。
 */

export interface ManagedProxyField {
    /** 原始字段名，如 `qoder_url` */
    field: string;
    /** 该字段指向的代理地址 */
    url: string;
    /** 从字段名反推的客户端标识，如 `qoder` */
    clientKey: string;
}

const PROXY_FIELD_RE = /^(.+?)_url$/i;

function hostOf(value: string): string | null {
    try {
        return new URL(value).hostname.toLowerCase();
    } catch {
        return null;
    }
}

/**
 * @param raw 条目的原始配置对象（可能带 `ServerConfig` 未声明的扩展字段）
 * @returns host 与直连 `url` 不同的 `*_url` 字段；无直连地址或无代理字段时为空数组
 */
export function detectManagedProxyFields(raw?: Record<string, unknown> | null): ManagedProxyField[] {
    if (!raw) return [];
    const directHost = typeof raw.url === 'string' ? hostOf(raw.url) : null;
    if (!directHost) return [];

    const found: ManagedProxyField[] = [];
    for (const [field, value] of Object.entries(raw)) {
        const matched = PROXY_FIELD_RE.exec(field);
        if (!matched || typeof value !== 'string') continue;
        const host = hostOf(value);
        if (!host || host === directHost) continue;
        found.push({field, url: value, clientKey: matched[1]});
    }
    return found;
}

/** 展示用客户端名：字段前缀首字母大写（`qoder` → `Qoder`） */
export function proxyClientLabel(clientKey: string): string {
    return clientKey.charAt(0).toUpperCase() + clientKey.slice(1);
}
