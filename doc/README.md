# AI-Tools

<p align="center">
  <img src="https://raw.githubusercontent.com/OldJii/mcp-dock/main/assets/icon.png" width="128" height="128" alt="MCP Dock">
</p>

<p align="center">
  <strong>MCP Server & Config Manager for 19 AI Clients</strong>
</p>

<p align="center">
  Manage MCP server configurations across Cursor, VS Code, Claude Code, Gemini CLI, Codex CLI, Windsurf, Zed, TRAE, Kiro, JetBrains, CodeBuddy, WorkBuddy, Qoder, and more — all from one app.
</p>

<p align="center">
  <a href="http://mcp.folay.top">Website</a> |
  <a href="#features">Features</a> |
  <a href="#download">Download</a> |
  <a href="#supported-clients">Supported Clients</a> |
  <a href="#faq">FAQ</a> |
  <a href="./README_CN.md">中文</a>
</p>

---

## Features

- **MCP Store** - Browse and search 8500+ MCP Servers from Official Registry and Smithery
- **Skills Store** - Discover 4400+ AI Skills for Cursor, Claude Code, Gemini CLI, Codex CLI, Opencode, and more
- **One-Click Install** - Auto-configure to Cursor, VS Code, Claude Code, Gemini CLI, Codex CLI, Windsurf, Zed, TRAE, TRAE CN, TRAE SOLO CN (TraeWork), TRAE Plugin (MarsCode), Kiro, Opencode, JetBrains, Antigravity, OpenClaw, CodeBuddy, WorkBuddy, Qoder, ZCode, Cloud
- **Agent Skills Standard** - Support for `~/.agents/skills/` unified standard ([skills.sh](https://skills.sh/))
- **MCP Inspector** - Interactive debugging tool for testing MCP Server tools
- **Config Management** - Unified management of MCP configurations across all clients
- **Multi-Client Sync** - Sync MCP configurations to multiple clients
- **Cloud Sync** - Push/pull MCP and Skills configs to cloud storage for backup and cross-device sync
- **History & Rollback** - Auto-backup configurations with one-click rollback
- **Multi-Language** - English and Simplified Chinese

## Download

### macOS (Recommended: Homebrew)

```bash
# Install
brew install --cask OldJii/tap/mcp-dock

# Upgrade
brew upgrade --cask mcp-dock
```

### macOS (Manual Download)

- [Apple Silicon (M1/M2/M3)](https://github.com/OldJii/mcp-dock/releases/latest/download/MCP.Dock-1.0.0-arm64.dmg)
- [Intel](https://github.com/OldJii/mcp-dock/releases/latest/download/MCP.Dock-1.0.0.dmg)

> Note: The app is not signed. If you see "damaged" or "can't be opened" message, run: `xattr -cr /Applications/MCP\ Dock.app`

### Windows

- [Installer](https://github.com/OldJii/mcp-dock/releases/latest/download/MCP.Dock.Setup.1.0.0.exe)
- [Portable](https://github.com/OldJii/mcp-dock/releases/latest/download/MCP.Dock-1.0.0.exe)

### Linux

- [AppImage (x64)](https://github.com/OldJii/mcp-dock/releases/latest/download/MCP.Dock-1.0.0.AppImage)
- [AppImage (arm64)](https://github.com/OldJii/mcp-dock/releases/latest/download/MCP.Dock-1.0.0-arm64.AppImage)
- [Debian/Ubuntu (x64)](https://github.com/OldJii/mcp-dock/releases/latest/download/mcp-dock_1.0.0_amd64.deb)
- [Debian/Ubuntu (arm64)](https://github.com/OldJii/mcp-dock/releases/latest/download/mcp-dock_1.0.0_arm64.deb)

## Supported Clients

### MCP Clients

| Client | Status |
|--------|--------|
| Cursor | Supported |
| VS Code | Supported |
| Claude Code | Supported |
| Gemini CLI | Supported |
| Codex CLI | Supported |
| Windsurf | Supported |
| Zed | Supported |
| TRAE | Supported |
| TRAE CN | Supported |
| TRAE SOLO CN (TraeWork) | Supported |
| TRAE Plugin (MarsCode, `~/.marscode`) | Supported |
| Kiro | Supported |
| Opencode | Supported |
| JetBrains (IntelliJ, WebStorm, PyCharm, etc.) | Supported |
| Antigravity | Supported |
| OpenClaw | Supported |
| CodeBuddy | Supported |
| WorkBuddy | Supported |
| Qoder | Supported |
| ZCode | Supported |
| Cline | Supported |
| Qwen Code | Supported |
| iFlow CLI | Supported |
| LM Studio | Supported |
| OpenHands | Supported |
| GitHub Copilot CLI | Supported |
| Warp | Supported |
| Kimi Code CLI | Supported |
| Cloud (云端存储) | Supported |

### Skills Clients

| Client | Status |
|--------|--------|
| Cursor | Supported |
| Claude Code | Supported |
| Gemini CLI | Supported |
| Codex CLI | Supported |
| Opencode | Supported |
| Agent Skills (.agents) | Supported |
| CodeBuddy | Supported |
| WorkBuddy | Supported |
| Qoder | Supported |
| ZCode | Supported |
| Antigravity | Supported |
| Cline | Supported |
| Qwen Code | Supported |
| TRAE | Supported |
| TRAE CN | Supported |
| TRAE SOLO CN (TraeWork) | Supported |
| TRAE Plugin (MarsCode) | Supported |
| Cloud (云端存储) | Supported |

## Data Sources

AI-Tools supports two data sources:

- **Official** - MCP Official Registry with verified servers
- **Smithery** - Smithery.ai community with community-contributed servers

Data syncs automatically every 3 days.

## FAQ

### Where is data stored?

All configurations and data are stored locally:
- macOS: `~/.ai-tool/`
- Windows: `%USERPROFILE%\.ai-tool\`
- Linux: `~/.ai-tool/`

### Does it require internet?

Internet is required for loading the MCP list. Installed MCP configurations are stored locally and work offline.

### How to uninstall?

1. Delete the application
2. Delete the config directory `~/.ai-tool/`
3. MCP configurations remain in each client's config file. Remove manually if needed.

## Source Code

This repository includes the full source code of AI-Tools (Community Edition). You can build, modify, and contribute to the project.

### Tech Stack

- **Framework**: Electron 43 + React 18 + TypeScript 5.3
- **Styling**: Tailwind CSS 3.4
- **State**: Zustand 4
- **Build**: Vite 7 + electron-builder 24
- **Testing**: Vitest 4
- **Protocol**: MCP JSON-RPC over stdio

### Development

```bash
# Install dependencies
npm install

# Start development mode
npm run electron:dev

# Build for production
npm run package
```

### Project Structure

```
src/
├── renderer/           # Frontend (React + Vite + Tailwind)
│   ├── src/
│   │   ├── components/ # UI components
│   │   ├── pages/      # App pages (Store, Library, Inspector, etc.)
│   │   ├── api/        # Registry API layer
│   │   ├── store/      # Zustand state management
│   │   ├── lib/        # Utilities and Electron bridge
│   │   └── locales/    # i18n (English + Chinese)
│   └── assets/         # Icons and static assets
├── main/               # Electron main process
│   ├── config-manager  # Multi-client config read/write (19 clients)
│   ├── mcp-client      # MCP JSON-RPC client for Inspector
│   ├── skills-manager  # Skills installation and management
│   ├── history-manager # Config backup and rollback
│   ├── env-manager     # Runtime environment detection
│   ├── cache-manager   # Local data caching
│   ├── cloud-sync-store # Cloud sync config persistence
│   └── cloud-sync-service # Cloud push/pull for config sync
├── preload/            # Electron preload (secure IPC bridge)
├── shared/             # Shared constants (cloud-sync, platform, frontmatter)
└── __tests__/          # Unit tests
```

### Community Edition vs Full Version

| Feature | Community | Full |
|---------|-----------|------|
| Manual server install to 19 clients | ✅ | ✅ |
| MCP Inspector | ✅ | ✅ |
| Config history & rollback | ✅ | ✅ |
| Multi-client sync | ✅ | ✅ |
| Skills management | ✅ | ✅ |
| Browse 8,500+ MCP servers | ❌ | ✅ |
| Browse 4,400+ AI Skills | ❌ | ✅ |
| One-click install from registry | ❌ | ✅ |

To get the full version with registry browsing, [download the latest release](https://github.com/OldJii/mcp-dock/releases).

## License

This software is a proprietary derivative of the open-source project mcp-dock (MIT License). See [LICENSE](./LICENSE) and the [Third-Party Open-Source License Notice](./THIRD_PARTY_LICENSES.md).

## Credits

- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Smithery.ai](https://smithery.ai/)
