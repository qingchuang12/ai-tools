/**
 * detectManagedProxyFields 单测（G 批次）
 *
 * 背景：客户端自家市场安装的远程 MCP 条目会额外带 `<客户端>_url` 代理字段（如 Qoder 的
 * `qoder_url`）。该地址凭客户端登录态鉴权、凭证不落配置文件，Inspector 只能用 `url` 直连，
 * 故需按字段名通用式识别（非客户端白名单），据此提示用户补 Authorization。
 */
import {describe, expect, it} from 'vitest';
import {detectManagedProxyFields, proxyClientLabel} from '../renderer/src/lib/managed-proxy-fields';

describe('detectManagedProxyFields', () => {
    it('识别 host 与直连地址不同的 *_url 字段', () => {
        const found = detectManagedProxyFields({
            url: 'https://api.githubcopilot.com/mcp/',
            qoder_url: 'https://mcp.qoder.com/api/v1/mcp/servers/mcp_srv_x',
            type: 'http',
        });
        expect(found).toEqual([
            {
                field: 'qoder_url',
                url: 'https://mcp.qoder.com/api/v1/mcp/servers/mcp_srv_x',
                clientKey: 'qoder',
            },
        ]);
    });

    it('同 host 的 *_url 字段不算代理（大小写不敏感）', () => {
        expect(detectManagedProxyFields({
            url: 'https://API.Example.com/mcp',
            mirror_url: 'https://api.example.com:8443/mcp',
        })).toEqual([]);
    });

    it('多个代理字段全部检出', () => {
        const found = detectManagedProxyFields({
            url: 'https://upstream.example.com/mcp',
            qoder_url: 'https://p1.example.net/mcp',
            cursor_url: 'https://p2.example.org/mcp',
        });
        expect(found.map(f => f.clientKey)).toEqual(['qoder', 'cursor']);
    });

    it('stdio 条目（无 url）不产出', () => {
        expect(detectManagedProxyFields({command: 'npx', args: ['-y', 'x']})).toEqual([]);
        expect(detectManagedProxyFields(null)).toEqual([]);
        expect(detectManagedProxyFields(undefined)).toEqual([]);
    });

    it('非 *_url 字段与非法地址一律忽略', () => {
        expect(detectManagedProxyFields({
            url: 'https://upstream.example.com/mcp',
            qoderHeaders: {Authorization: 'Bearer x'},
            broken_url: 'not a url',
            count_url: 42,
        })).toEqual([]);
    });

    it('直连 url 本身非法时不判定', () => {
        expect(detectManagedProxyFields({
            url: 'garbage',
            qoder_url: 'https://mcp.qoder.com/mcp',
        })).toEqual([]);
    });
});

describe('proxyClientLabel', () => {
    it('字段前缀首字母大写', () => {
        expect(proxyClientLabel('qoder')).toBe('Qoder');
        expect(proxyClientLabel('trae-cn')).toBe('Trae-cn');
    });
});
