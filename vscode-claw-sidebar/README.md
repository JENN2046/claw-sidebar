# Claw Sidebar (Claude Code-style for VS Code)

See the target end-state spec here:

- [FINAL_SHAPE.md](a:\VCP\claw-code\vscode-claw-sidebar\FINAL_SHAPE.md)

This extension provides a Claude Code-like sidebar chat workflow for local `claw-code`:

- chat UI in Activity Bar (`Claw`)
- one-shot prompt execution via `rust/run-with-cc-switch.ps1`
- two connection modes:
  - `CC switch` for reusing your current Claude provider
  - `Direct API` for entering provider, API key, and optional base URL directly in the sidebar
- `VCP Agent Memory` mode for binding the sidebar to a VCP Agent + Topic
- stop running request
- utility actions: `doctor`, `status`, `REPL`
- one-click file preview from the workspace (`View File`)
- one-click `Quick Start` (auto-check + auto-build if needed + doctor/status)
- optional active editor context injection
- role-based model mapping / max output token controls
- provider / base URL / API key controls in the sidebar
- VCP Agent / Topic binding so memory is stored in `VCPChat/AppData/UserData/.../history.json`
- markdown-style assistant rendering (including code blocks)
- lightweight syntax highlighting for code blocks
- one-click copy button on code blocks
- multi-session chat list with create/switch/delete
- chat session persistence across sidebar reloads
- one-click "Ask Selection" from editor selected code

## Connection modes

### CC switch

- Workspace root opened in VS Code: `a:\VCP\claw-code`
- Built binary exists: `rust/target/debug/claw.exe`
- Runner script exists: `rust/run-with-cc-switch.ps1`
- CC switch config exists: `%USERPROFILE%\.cc-switch`
- Node.js installed

### Direct API

- Workspace root opened in VS Code: `a:\VCP\claw-code`
- Built binary exists: `rust/target/debug/claw.exe`
- Runner script exists: `rust/run-with-cc-switch.ps1`
- API key for the provider you want to use
- Optional custom base URL for OpenAI-compatible gateways or self-hosted endpoints

Supported direct providers:

- `Anthropic`
- `OpenAI / OpenAI-compatible`
- `xAI`

### VCP Agent Memory

- `VCPChat` exists beside your workspace, for example:
  - `a:\VCP\VCPChat`
- `VCPChat/AppData/settings.json` contains:
  - `vcpServerUrl`
  - `vcpApiKey`
- You have created at least one Agent in VCP
- In the sidebar, switch connection mode to `VCP Agent Memory`
- Pick the Agent and Topic you want to bind

When this mode is active:

- the sidebar sends requests through the VCP server
- the selected Agent config provides the model + active system prompt
- the selected Topic stores user / assistant history
- future VCP memory upgrades can be inherited by this binding path more naturally than a separate local-only memory layer

## Role-based model mapping

The sidebar now supports Claude Code-style role mapping:

- `Auto`
- `Main`
- `Thinking`
- `Explore`
- `Plan`
- `Verify`
- `Fast`
- optional `Custom` one-off override

You can keep a different model name for each role, then choose `Auto` or a specific role before sending a message.
`Auto` uses lightweight prompt heuristics to route the turn to a role, which is a practical first step toward Claude Code-like orchestration.

This works well for gateways where the same provider uses non-Claude model names, such as:

- `moonshotai/kimi-k2.5`
- `NV_qwen/qwen3.5-397b-a17b`
- `google/gemma-4-31b-it`

## Cross-machine notes

This repo is now more portable than before:

- `run-with-cc-switch.ps1` no longer depends on the hardcoded local path `A:/VCP/VCPToolBox/node_modules/better-sqlite3`
- it prefers Node.js 22+ built-in `node:sqlite`
- on older Node versions it can still fall back to `better-sqlite3` if that package is installed locally

For a fresh machine, the practical setup is:

1. clone the repo
2. install Rust
3. choose one of:
4. install Node.js 22+ and configure CC switch
5. or prepare a provider API key for direct API mode
6. open the repo and run `Quick Start`

If you choose `Direct API`, the API key is stored in VS Code Secret Storage, not plain workspace state.
In this mode, sidebar chat works directly against the provider API. `REPL` still stays on the local Claw runtime / CC switch path.

## Run (Development Host)

1. Open folder `a:\VCP\claw-code\vscode-claw-sidebar` in VS Code.
2. Press `F5` (`Run Claw Sidebar Extension`).
3. In the new Extension Development Host window, open `a:\VCP\claw-code`.
4. Click the `Claw` icon in the Activity Bar.

## Commands (Command Palette)

- `Claw Sidebar: Focus`
- `Claw Sidebar: New Chat`
- `Claw Sidebar: Stop Request`
- `Claw Sidebar: Run Doctor`
- `Claw Sidebar: Run Status`
- `Claw Sidebar: Open REPL`
- `Claw Sidebar: View File`
- `Claw Sidebar: Quick Start`
- `Claw Sidebar: Ask Selection` (also available in editor right-click when text is selected)

## Package as VSIX (optional)

```bash
npm install -g @vscode/vsce
cd a:\VCP\claw-code\vscode-claw-sidebar
vsce package
```

Install via: `Extensions: Install from VSIX...`
