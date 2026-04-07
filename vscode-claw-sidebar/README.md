# Claw Sidebar (Claude Code-style for VS Code)

See the target end-state spec here:

- [FINAL_SHAPE.md](a:\VCP\claw-code\vscode-claw-sidebar\FINAL_SHAPE.md)

This extension provides a Claude Code-like sidebar chat workflow for local `claw-code`:

- chat UI in Activity Bar (`Claw`)
- one-shot prompt execution via `rust/run-with-cc-switch.ps1`
- stop running request
- utility actions: `doctor`, `status`, `REPL`
- one-click file preview from the workspace (`View File`)
- one-click `Quick Start` (auto-check + auto-build if needed + doctor/status)
- optional active editor context injection
- model / max output token controls
- markdown-style assistant rendering (including code blocks)
- lightweight syntax highlighting for code blocks
- one-click copy button on code blocks
- multi-session chat list with create/switch/delete
- chat session persistence across sidebar reloads
- one-click "Ask Selection" from editor selected code

## Prerequisites

- Workspace root opened in VS Code: `a:\VCP\claw-code`
- Built binary exists: `rust/target/debug/claw.exe`
- Runner script exists: `rust/run-with-cc-switch.ps1`
- CC switch config exists: `%USERPROFILE%\.cc-switch`
- Node.js installed

## Cross-machine notes

This repo is now more portable than before:

- `run-with-cc-switch.ps1` no longer depends on the hardcoded local path `A:/VCP/VCPToolBox/node_modules/better-sqlite3`
- it prefers Node.js 22+ built-in `node:sqlite`
- on older Node versions it can still fall back to `better-sqlite3` if that package is installed locally

For a fresh machine, the practical setup is:

1. clone the repo
2. install Rust
3. install Node.js 22+
4. install and configure CC switch
5. open the repo and run `Quick Start`

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
