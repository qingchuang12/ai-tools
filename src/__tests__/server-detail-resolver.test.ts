import {describe, expect, it} from 'vitest';
import {bailianAdapter} from '../main/platforms/bailian';
import {fetchPlatformServerDetail} from '../main/resolvers/servers';

describe('fetchPlatformServerDetail adapter delegation', () => {
    it('delegates bailian details to the registered offline adapter', async () => {
        const page = await bailianAdapter.searchServers!({query: '', page: 1, pageSize: 1, baseUrl: ''});
        const detail = await fetchPlatformServerDetail('bailian', '', null, page.items[0].id);

        expect(detail.id).toBe(page.items[0].id);
        expect(detail.source).toBe('bailian');
        // 百炼为远程托管型安装：delegation 原样透传适配器的 URL 接入点（而非 null）与鉴权头模板
        expect(detail.install).toEqual({
            url: expect.stringMatching(/^https:\/\/dashscope\.aliyuncs\.com\/api\/v1\/mcps\/.+\/sse$/),
            type: 'sse',
            headersTemplate: {Authorization: 'Bearer ${DASHSCOPE_API_KEY}'},
        });
    });

    it('preserves the explicit error for platforms without detail support', async () => {
        await expect(fetchPlatformServerDetail('coze', '', null, 'missing')).rejects.toThrow(
            '平台 coze 暂不支持 MCP server 详情'
        );
    });
});
