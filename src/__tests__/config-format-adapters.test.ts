/**
 * 配置格式适配器自动化测试（ZCode / Qoder / Warp / Kimi Code CLI）
 *
 * ZCode 原生格式（官方 https://zcode.z.ai/cn/newdocs/mcp-services）：
 *   {"mcp": {"servers": {"<name>": {"command": ..., "args": [...], "env": {...}}}}}
 * 与业界通用的 mcpServers 不同，故需专用读写分支。
 * 停用标记写在 server 对象内的 "enable": false，字段缺失即视为启用。
 *
 * Qoder 的用户级 MCP 配置寄居在客户端主设置文件 ~/.qoder/settings.json 的顶层
 * mcpServers 键（官方 docs/cli/mcp-reference），同文件还有 enabledPlugins 等无关设置，
 * 故必须定点合并写入，不能整文件重写。
 *
 * 覆盖：mcp.servers 双向转换、enable 透传、非 MCP 字段保留、分支开关。
 *
 * Warp（官方 docs.warp.dev/agents/capabilities/mcp）与 Kimi Code CLI
 * （官方 kimi-code-cli/customization/mcp）都用顶层 mcpServers，但字段名不同：
 *   Warp 用 working_directory（≡ cwd）；Kimi 用 transport（≡ type）与 enabled（≡ enable）。
 */

import {describe, expect, it} from 'vitest';
import {
    defaultConfigForMissing,
    reachesDefaultBranch,
    readClientConfig,
    writeClientConfig,
} from '../main/config/format-adapters';

describe('ZCode 读取（mcp.servers → mcpServers）', () => {
    it('解析 stdio 型 server', () => {
        const raw = JSON.stringify({
            mcp: {servers: {memory: {command: 'npx', args: ['-y', '@m/server-memory'], env: {FOO: 'bar'}}}},
        });
        expect(readClientConfig('zcode', raw).mcpServers).toEqual({
            memory: {command: 'npx', args: ['-y', '@m/server-memory'], env: {FOO: 'bar'}},
        });
    });

    it('解析 http 型 server', () => {
        const raw = JSON.stringify({
            mcp: {servers: {remote: {url: 'https://example.com/mcp', type: 'http', headers: {Authorization: 'Bearer x'}}}},
        });
        expect(readClientConfig('zcode', raw).mcpServers).toEqual({
            remote: {url: 'https://example.com/mcp', type: 'http', headers: {Authorization: 'Bearer x'}},
        });
    });

    it('保留 enable: false，且不把缺失的 enable 补成 true', () => {
        const raw = JSON.stringify({mcp: {servers: {off: {command: 'node', enable: false}, on: {command: 'node'}}}});
        const servers = readClientConfig('zcode', raw).mcpServers!;
        expect(servers.off.enable).toBe(false);
        expect(servers.on.enable).toBeUndefined();
    });

    it('mcp 键缺失时降级为空 mcpServers', () => {
        expect(readClientConfig('zcode', '{"model":"glm"}').mcpServers).toEqual({});
    });
});

describe('ZCode 写入（mcpServers → mcp.servers）', () => {
    it('文件不存在时从 {} 建出 mcp.servers', () => {
        const out = writeClientConfig('zcode', {mcpServers: {memory: {command: 'npx', args: ['-y', 'pkg']}}}, '{}');
        expect(JSON.parse(out).mcp.servers.memory).toEqual({command: 'npx', args: ['-y', 'pkg']});
    });

    it('保留 config.json 内的非 MCP 字段，且只覆盖 mcp.servers', () => {
        const existing = JSON.stringify({model: 'glm-5', mcp: {servers: {old: {command: 'node'}}}});
        const out = writeClientConfig('zcode', {mcpServers: {added: {command: 'npx'}}}, existing);
        const parsed = JSON.parse(out);
        expect(parsed.model).toBe('glm-5');
        expect(Object.keys(parsed.mcp.servers)).toEqual(['added']);
    });

    it('写回时透传 enable: false', () => {
        const existing = JSON.stringify({mcp: {servers: {off: {command: 'node', enable: false}}}});
        const out = writeClientConfig('zcode', {mcpServers: {off: {command: 'node', enable: false}}}, existing);
        expect(JSON.parse(out).mcp.servers.off.enable).toBe(false);
    });

    it('读 → 写 → 读 往返一致', () => {
        const original = JSON.stringify({
            theme: 'dark',
            mcp: {
                servers: {
                    a: {command: 'node', args: ['a.js'], env: {K: 'V'}, cwd: '/tmp'},
                    b: {url: 'https://x/mcp', type: 'http', enable: false},
                },
            },
        });
        const once = readClientConfig('zcode', original);
        const out = writeClientConfig('zcode', once, original);

        expect(JSON.parse(out).theme).toBe('dark');
        expect(readClientConfig('zcode', out).mcpServers).toEqual(once.mcpServers);
    });
});

describe('ZCode 分支开关', () => {
    it('配置文件缺失时返回空 mcpServers', () => {
        expect(defaultConfigForMissing('zcode')).toEqual({mcpServers: {}});
    });

    it('走专用分支，不进默认分支（默认分支会整文件覆盖，丢非 MCP 设置）', () => {
        expect(reachesDefaultBranch('zcode')).toBe(false);
    });
});

describe('Qoder 读写（settings.json 顶层 mcpServers，定点合并）', () => {
    it('文件不存在时从 {} 建出 mcpServers', () => {
        const out = writeClientConfig('qoder', {mcpServers: {fetch: {command: 'uvx', args: ['mcp-server-fetch']}}}, '{}');
        expect(JSON.parse(out).mcpServers.fetch).toEqual({command: 'uvx', args: ['mcp-server-fetch']});
    });

    it('写入只动 mcpServers，保留同文件内客户端自身的其他设置', () => {
        const existing = JSON.stringify({
            enabledPlugins: {'code-simplifier@qoder-marketplace': true},
            mcpServers: {old: {command: 'node'}},
        });
        const out = writeClientConfig('qoder', {mcpServers: {added: {command: 'npx'}}}, existing);
        const parsed = JSON.parse(out);
        expect(parsed.enabledPlugins).toEqual({'code-simplifier@qoder-marketplace': true});
        expect(Object.keys(parsed.mcpServers)).toEqual(['added']);
    });

    it('保留 JSONC 注释（客户端主设置文件常带用户注释）', () => {
        const existing = '{\n  // 我的插件开关\n  "enabledPlugins": {}\n}';
        const out = writeClientConfig('qoder', {mcpServers: {a: {command: 'node'}}}, existing);
        expect(out).toContain('// 我的插件开关');
        expect(readClientConfig('qoder', out).mcpServers).toEqual({a: {command: 'node'}});
    });

    it('读 → 写 → 读 往返一致，且不丢非 MCP 设置', () => {
        const original = JSON.stringify({
            enabledPlugins: {x: true},
            mcpServers: {a: {command: 'node', args: ['a.js'], env: {K: 'V'}}, b: {url: 'https://x/mcp', type: 'http'}},
        });
        const once = readClientConfig('qoder', original);
        const out = writeClientConfig('qoder', once, original);

        expect(JSON.parse(out).enabledPlugins).toEqual({x: true});
        expect(readClientConfig('qoder', out).mcpServers).toEqual(once.mcpServers);
    });

    it('mcpServers 缺失时降级为空，不误报已安装 server', () => {
        expect(readClientConfig('qoder', '{"enabledPlugins":{}}').mcpServers).toBeUndefined();
        expect(defaultConfigForMissing('qoder')).toEqual({mcpServers: {}});
    });

    it('走定点合并分支，不进默认分支（默认分支整文件重写会压掉客户端其他设置与注释）', () => {
        expect(reachesDefaultBranch('qoder')).toBe(false);
    });
});

describe('Warp 读写（working_directory ≡ cwd）', () => {
    it('读入时把 working_directory 映射成 cwd', () => {
        const raw = JSON.stringify({
            mcpServers: {fs: {command: 'npx', args: ['-y', 'pkg'], env: {A: 'b'}, working_directory: '/tmp'}},
        });
        expect(readClientConfig('warp', raw).mcpServers).toEqual({
            fs: {command: 'npx', args: ['-y', 'pkg'], env: {A: 'b'}, cwd: '/tmp'},
        });
    });

    it('working_directory 缺失时不凭空补 cwd', () => {
        const servers = readClientConfig('warp', '{"mcpServers":{"a":{"command":"node"}}}').mcpServers!;
        expect(servers.a.cwd).toBeUndefined();
    });

    it('写出时把 cwd 映射回 working_directory，且不残留 cwd 键', () => {
        const out = writeClientConfig('warp', {mcpServers: {fs: {command: 'node', args: ['x.js'], cwd: '/tmp'}}}, '{}');
        const server = JSON.parse(out).mcpServers.fs;
        expect(server.working_directory).toBe('/tmp');
        expect(server.cwd).toBeUndefined();
    });

    it('保留客户端文件内的非 MCP 顶层键与 server 上的自定义字段', () => {
        const existing = JSON.stringify({
            $schema: 'https://example.com/warp.schema.json',
            mcpServers: {a: {command: 'node', timeout: 30}},
        });
        const parsed = JSON.parse(writeClientConfig('warp', readClientConfig('warp', existing), existing));
        expect(parsed.$schema).toBe('https://example.com/warp.schema.json');
        expect(parsed.mcpServers.a.timeout).toBe(30);
    });

    it('读 → 写 → 读 往返一致', () => {
        const original = JSON.stringify({
            mcpServers: {
                local: {command: 'node', args: ['a.js'], env: {K: 'V'}, working_directory: '/tmp'},
                remote: {url: 'https://x/mcp', headers: {Authorization: 'Bearer x'}},
            },
        });
        const once = readClientConfig('warp', original);
        expect(readClientConfig('warp', writeClientConfig('warp', once, original)).mcpServers).toEqual(once.mcpServers);
    });

    it('走专用分支，不进默认分支', () => {
        expect(defaultConfigForMissing('warp')).toEqual({mcpServers: {}});
        expect(reachesDefaultBranch('warp')).toBe(false);
    });
});

describe('Kimi Code CLI 读写（transport ≡ type、enabled ≡ enable）', () => {
    it('读入时把 transport 映射成 type、enabled:false 映射成 enable:false', () => {
        const raw = JSON.stringify({
            mcpServers: {
                remote: {url: 'https://x/mcp', transport: 'http', headers: {A: 'b'}},
                off: {command: 'node', enabled: false},
                on: {command: 'node', enabled: true},
            },
        });
        const servers = readClientConfig('kimi-code', raw).mcpServers!;
        expect(servers.remote).toEqual({url: 'https://x/mcp', type: 'http', headers: {A: 'b'}});
        expect(servers.off.enable).toBe(false);
        // 缺失或显式 true 都不补 enable：补 false 以外的值会给客户端配置平添噪声
        expect(servers.on.enable).toBeUndefined();
    });

    it('写出时把 type 映射成 transport；stdio 由 command 隐含，不写 transport', () => {
        const out = writeClientConfig('kimi-code', {
            mcpServers: {
                local: {command: 'node', args: ['a.js'], cwd: '/tmp', type: 'stdio'},
                remote: {url: 'https://x/mcp', type: 'sse'},
            },
        }, '{}');
        const servers = JSON.parse(out).mcpServers;
        expect(servers.local.transport).toBeUndefined();
        expect(servers.local.cwd).toBe('/tmp');
        expect(servers.remote.transport).toBe('sse');
    });

    it('写回时透传停用标记 enabled:false，且不写 enable 键', () => {
        const out = writeClientConfig('kimi-code', {mcpServers: {off: {command: 'node', enable: false}}}, '{}');
        const server = JSON.parse(out).mcpServers.off;
        expect(server.enabled).toBe(false);
        expect(server.enable).toBeUndefined();
    });

    it('读 → 写 → 读 往返一致，且保留非 MCP 顶层键', () => {
        const original = JSON.stringify({
            model: 'kimi-k2',
            mcpServers: {
                a: {command: 'node', args: ['a.js'], env: {K: 'V'}, cwd: '/tmp', deferred: true},
                b: {url: 'https://x/mcp', transport: 'sse', enabled: false},
            },
        });
        const once = readClientConfig('kimi-code', original);
        const out = writeClientConfig('kimi-code', once, original);
        const parsed = JSON.parse(out);
        expect(parsed.model).toBe('kimi-k2');
        expect(parsed.mcpServers.a.deferred).toBe(true);
        expect(readClientConfig('kimi-code', out).mcpServers).toEqual(once.mcpServers);
    });

    it('走专用分支，不进默认分支', () => {
        expect(defaultConfigForMissing('kimi-code')).toEqual({mcpServers: {}});
        expect(reachesDefaultBranch('kimi-code')).toBe(false);
    });
});

describe('OpenClaw 读写（transport ≡ type、enabled ≡ enable）', () => {
    it('读入时认 transport，并兼容 CLI 写法 type；enabled:false 映射成 enable:false', () => {
        const raw = JSON.stringify({
            mcp: {
                servers: {
                    stream: {url: 'https://x/mcp', transport: 'streamable-http', headers: {A: 'b'}},
                    sse: {url: 'https://x/sse', transport: 'sse'},
                    legacy: {url: 'https://y/mcp', type: 'http'},
                    off: {command: 'node', enabled: false},
                },
            },
        });
        const servers = readClientConfig('openclaw', raw).mcpServers!;
        expect(servers.stream).toEqual({url: 'https://x/mcp', type: 'http', headers: {A: 'b'}});
        expect(servers.sse.type).toBe('sse');
        expect(servers.legacy.type).toBe('http');
        expect(servers.off.enable).toBe(false);
    });

    it('写出时用 transport 而非 type：内部 http 落 streamable-http，stdio 不写 transport', () => {
        const out = writeClientConfig('openclaw', {
            mcpServers: {
                local: {command: 'node', args: ['a.js'], cwd: '/tmp', type: 'stdio'},
                remote: {url: 'https://x/mcp', type: 'http'},
                sse: {url: 'https://x/sse', type: 'sse'},
                off: {command: 'node', enable: false},
            },
        }, '{}');
        const servers = JSON.parse(out).mcp.servers;
        expect(servers.local.type).toBeUndefined();
        expect(servers.local.transport).toBeUndefined();
        expect(servers.local.enabled).toBeUndefined();
        expect(servers.remote.transport).toBe('streamable-http');
        expect(servers.remote.type).toBeUndefined();
        expect(servers.sse.transport).toBe('sse');
        // 只写显式 false：停用标记丢失会把客户端内已停用的 server 静默启用
        expect(servers.off.enabled).toBe(false);
    });

    it('读 → 写 → 读 往返一致', () => {
        const original = JSON.stringify({
            agents: {defaults: {model: 'openclaw'}},
            mcp: {servers: {a: {url: 'https://x/mcp', transport: 'streamable-http', headers: {A: 'b'}}}},
        });
        const once = readClientConfig('openclaw', original);
        const out = writeClientConfig('openclaw', once, original);
        expect(JSON.parse(out).agents).toEqual({defaults: {model: 'openclaw'}});
        expect(readClientConfig('openclaw', out).mcpServers).toEqual(once.mcpServers);
    });
});

describe('Antigravity 读写（远程字段为 serverUrl，schema 不认 type/cwd）', () => {
    it('读入时把 serverUrl 映射成 url 并补默认 type；disabled:true 映射成 enable:false', () => {
        const raw = JSON.stringify({
            mcpServers: {
                remote: {serverUrl: 'https://x/mcp', headers: {A: 'b'}},
                sse: {serverUrl: 'https://x/sse', type: 'sse'},
                off: {command: 'npx', args: ['-y', 'pkg'], disabled: true},
            },
        });
        const servers = readClientConfig('antigravity', raw).mcpServers!;
        expect(servers.remote).toEqual({url: 'https://x/mcp', type: 'http', headers: {A: 'b'}});
        expect(servers.sse.type).toBe('sse');
        expect(servers.off.enable).toBe(false);
    });

    it('写出时把 url 换成 serverUrl，并剥掉 schema 不认的 type / cwd', () => {
        const out = writeClientConfig('antigravity', {
            mcpServers: {
                local: {command: 'npx', args: ['-y', 'pkg'], cwd: '/tmp', type: 'stdio'},
                remote: {url: 'https://x/mcp', type: 'http', headers: {A: 'b'}},
                off: {command: 'node', enable: false},
            },
        }, '{}');
        const servers = JSON.parse(out).mcpServers;
        expect(servers.local).toEqual({command: 'npx', args: ['-y', 'pkg']});
        expect(servers.remote).toEqual({serverUrl: 'https://x/mcp', headers: {A: 'b'}});
        expect(servers.off.disabled).toBe(true);
        expect(servers.off.enable).toBeUndefined();
    });

    it('读 → 写 → 读 往返一致', () => {
        const original = JSON.stringify({
            mcpServers: {a: {serverUrl: 'https://x/mcp', headers: {A: 'b'}}, b: {command: 'node', disabled: true}},
        });
        const once = readClientConfig('antigravity', original);
        const out = writeClientConfig('antigravity', once, original);
        expect(readClientConfig('antigravity', out).mcpServers).toEqual(once.mcpServers);
    });

    it('走专用分支，不进默认分支', () => {
        expect(reachesDefaultBranch('antigravity')).toBe(false);
    });
});

describe('TRAE IDE 家族读写（官方形态无 type，停用字段为 disabled）', () => {
    // 取自本机 %APPDATA%\Trae CN\User\mcp.json 的真实形态
    const traeRaw = JSON.stringify({
        mcpServers: {
            'Figma Desktop': {url: 'http://127.0.0.1:3845/mcp', disabled: true},
            'Chrome DevTools MCP': {
                command: 'npx',
                args: ['-y', 'chrome-devtools-mcp@latest'],
                env: {},
                fromGalleryId: 'byted-mcp.chrome-devtools-mcp',
                disabled: true,
            },
            codegraph: {command: 'npx', args: ['@colbymchenry/codegraph', 'serve', '--mcp']},
        },
    });

    it.each(['trae', 'trae-cn', 'trae-solo-cn'])('%s 读入时 url 条目补 type、disabled:true 映射成 enable:false', (client) => {
        const servers = readClientConfig(client, traeRaw).mcpServers!;
        expect(servers['Figma Desktop']).toEqual({url: 'http://127.0.0.1:3845/mcp', type: 'http', enable: false});
        expect(servers['Chrome DevTools MCP'].enable).toBe(false);
        expect(servers['Chrome DevTools MCP'].fromGalleryId).toBe('byted-mcp.chrome-devtools-mcp');
        expect(servers.codegraph.enable).toBeUndefined();
    });

    it.each(['trae', 'trae-cn', 'trae-solo-cn'])('%s 写出时剥掉 type / enable，停用映射为 disabled:true', (client) => {
        const out = writeClientConfig(client, {
            mcpServers: {
                remote: {url: 'http://127.0.0.1:3845/mcp', type: 'http', enable: false},
                local: {command: 'npx', args: ['-y', 'pkg'], type: 'stdio'},
            },
        }, '{}');
        const servers = JSON.parse(out).mcpServers;
        expect(servers.remote).toEqual({url: 'http://127.0.0.1:3845/mcp', disabled: true});
        expect(servers.local).toEqual({command: 'npx', args: ['-y', 'pkg']});
    });

    it('读 → 写 → 读 往返一致，且保留 fromGalleryId 等扩展字段', () => {
        const once = readClientConfig('trae-cn', traeRaw);
        const out = writeClientConfig('trae-cn', once, traeRaw);
        expect(JSON.parse(out).mcpServers['Chrome DevTools MCP'].fromGalleryId).toBe('byted-mcp.chrome-devtools-mcp');
        expect(readClientConfig('trae-cn', out).mcpServers).toEqual(once.mcpServers);
    });

    it('走专用分支，不进默认分支', () => {
        for (const client of ['trae', 'trae-cn', 'trae-solo-cn']) {
            expect(reachesDefaultBranch(client), client).toBe(false);
        }
    });
});
