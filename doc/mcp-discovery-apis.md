1. MCPAnvil API（最完整）

网址：
https://mcpanvil.com/

API 端点：

    GET /api/v1/all.json — 获取完整数据库（2,300+ 服务器）

    GET /api/v1/index.json — 轻量级索引

    GET /api/v1/categories/{name}.json — 按分类筛选

    GET /api/v1/mcp/{id}.json — 获取单个服务器详情

特点： 专为 AI 代理设计的结构化 JSON API，支持发现和安装 MCP 服务器

示例：

bash
curl https://mcpanvil.com/api/v1/all.json
curl https://mcpanvil.com/api/v1/categories/ai.json

2. PulseMCP Registry API（v0.1）

网址：
https://www.pulsemcp.com/api/docs/v0.1

API 端点：

    GET /v0.1/servers — 分页获取 MCP 服务器列表（支持过滤）

特点： 实现 Generic MCP Registry API 规范，提供丰富元数据（流行度、安全分析、兼容性数据）
3. A2ASearch API

网址： https://a2asearch.ai/api/v1/agents

API 端点：

    GET /api/v1/agents?q={query} — 搜索 MCP 服务器、AI 代理、CLI 工具

    GET /api/v1/agents?type=MCP+Server&sort=stars — 按类型和排序获取

特点： 搜索 4,800+ MCP 服务器和 AI 工具，提供免费 REST API

示例：

bash
curl "https://a2asearch.ai/api/v1/agents?q=playwright"
curl "https://a2asearch.ai/api/v1/agents?type=MCP+Server&sort=stars"

https://www.skills.sh/