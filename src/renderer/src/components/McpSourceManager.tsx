/**
 * MCP 源管理卡片（P2-6）
 * 实现已抽到通用 SourceManager，本文件仅做参数化薄 wrapper。
 */
import {BUILTIN_MCP_SOURCE_IDS, MCP_PLATFORM_TYPES} from '../../../shared/platform-constants';
import SourceManager from './SourceManager';

interface Props {
    /** 源列表变化后通知外部（Store 下拉需要重新拉取） */
    onChanged?: () => void;
}

export default function McpSourceManager({onChanged}: Props) {
    return (
        <SourceManager
            namespace="mcpSource"
            kind="mcp"
            platformTypes={MCP_PLATFORM_TYPES}
            builtinIds={[BUILTIN_MCP_SOURCE_IDS.smithery, BUILTIN_MCP_SOURCE_IDS.bailian]}
            // 默认用无需 baseUrl 的内置源；自定类型已从新建下拉移除（custom）
            createDefaults={{platformType: 'smithery', baseUrl: ''}}
            exportNames={{single: 'mcp-source.json', multi: 'mcp-sources.json'}}
            showPlatformHint
            onChanged={onChanged}
        />
    );
}
