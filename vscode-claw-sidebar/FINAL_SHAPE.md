# Claw Sidebar Final Shape

This document defines the target end state for `vscode-claw-sidebar`.

The goal is not "a panel that can call `claw`". The goal is a daily-driver VS Code extension that feels as natural and reliable as Claude Code for VS Code, while staying aligned with the local `claw-code` runtime and the CC switch workflow already used on this machine.

## 1. Product Goal

The finished extension should let a developer stay inside VS Code for the full loop:

- ask about code
- attach relevant context
- receive clear, streamed answers
- understand when the model is thinking, blocked, or failed
- reuse the answer immediately in the editor
- continue the same session later without losing context

The extension should feel:

- fast
- trustworthy
- local-first
- operationally clear
- close to native VS Code behavior

## 2. Final User Experience

### 2.1 Primary Entry

The main entry is a dedicated `Claw` icon in the Activity Bar.

Opening the sidebar should immediately show:

- current workspace status
- current session title
- current model
- current run state
- the latest chat history

There should be no ambiguity about whether the extension is ready.

### 2.2 Chat Surface

The final chat UI should support:

- user messages
- assistant messages
- system messages
- streaming response rendering
- markdown rendering
- code blocks with copy
- full message copy
- insert selected code into active editor
- regenerate last response

Assistant replies should feel like code-assistant output, not like raw terminal logs.

### 2.3 Context Controls

The user should be able to choose context intentionally.

Minimum final context modes:

- no extra context
- active editor context
- selected code only
- current file
- manually attached files

The UI should always make it obvious what context is being sent.

### 2.4 Session Experience

Sessions should behave like a real coding chat tool.

Minimum final session capabilities:

- create session
- rename session
- switch session
- delete session
- persist session locally
- optionally reconnect to CLI session state
- resume prior session safely

The user should never feel that sidebar reloads destroyed their work.

### 2.5 Operational Clarity

One of the biggest differences between a toy panel and a real tool is status clarity.

The finished extension should always expose one clear state:

- `Idle`
- `Starting`
- `Checking environment`
- `Waiting for model`
- `Streaming`
- `Done`
- `Cancelled`
- `Failed`

When a request fails, the UI should explain whether the problem is:

- bad workspace root
- missing script
- missing `claw.exe`
- missing CC switch database/config
- missing `node`
- missing `better-sqlite3`
- missing API env
- model/provider error
- process exit with stderr

## 3. Final Information Architecture

The extension should have three layers.

### 3.1 UI Layer

Owns:

- webview rendering
- message list
- buttons and input
- status badge
- session selector
- context attachment UI

This layer should not contain runner-specific process logic.

### 3.2 Extension Controller Layer

Owns:

- command registration
- message routing between webview and backend
- session persistence
- workspace detection
- debug logging
- error normalization

This is the orchestration layer.

### 3.3 Runner Layer

Owns:

- PowerShell invocation
- `run-with-cc-switch.ps1` execution
- `doctor`, `status`, `prompt`, `repl`
- process lifecycle
- stdout/stderr streaming
- structured diagnostic checks

This layer should be testable without the full webview.

## 4. Final Technical Shape

The extension should no longer live in one large file.

Recommended file shape:

- `extension.js`
  Thin activation entry.
- `src/provider.js`
  Webview provider and command wiring.
- `src/webview.js`
  HTML template and webview-side script builder.
- `src/runner.js`
  `claw` process spawning, chunk handling, utility commands.
- `src/workspace.js`
  Workspace root detection and path helpers.
- `src/sessions.js`
  Session store helpers and normalization.
- `src/diagnostics.js`
  Quick Start checks and repair guidance.

If the project later moves to TypeScript, this structure should remain.

## 5. Feature Complete Definition

The extension can be called "feature complete v1" when all of these are true:

- opening `A:\VCP` still resolves the real `claw-code` project
- `Quick Start` gives a structured green/yellow/red report
- sending a prompt always shows a visible request state
- successful replies always render, even if chunk streaming partially fails
- common local setup failures show actionable fixes
- users can ask about selection with one click
- users can regenerate a response
- users can copy code blocks and whole replies
- users can insert returned code into the active editor
- sessions persist and are easy to manage
- the extension is packaged as a stable VSIX

## 6. Quality Bar

The final build should meet this quality bar:

- no silent failure path for normal user actions
- no ambiguous "it didn't respond" state
- no hardcoded single-workspace assumptions
- no accidental mixing of assistant output and system diagnostics
- no need to open terminal for ordinary usage

The user should only need terminal access for advanced debugging or REPL workflows.

## 7. Non-Goals For V1

These are useful, but not required for the first strong release:

- token usage charts
- theme presets
- transcript export UI
- inline diff application
- multi-agent orchestration UI
- cloud sync

These can come after the core workflow is dependable.

## 8. Recommended Build Sequence

### Phase 1: Reliability

- workspace root detection
- structured Quick Start diagnostics
- request lifecycle logging
- actionable dependency failures

### Phase 2: UX clarity

- visible status badge
- stronger separation of system vs assistant messages
- cleaner action layout
- better session handling

### Phase 3: Core productivity

- richer context attachments
- regenerate
- full-message copy
- insert-to-editor
- resume support

### Phase 4: Maintainability

- split `extension.js`
- add tests
- formalize packaging/versioning

## 9. Acceptance Test Script

Use this script to validate the final form.

1. Open VS Code on `A:\VCP`.
2. Open the `Claw` sidebar.
3. Run `Quick Start`.
4. Confirm the extension resolves `A:\VCP\claw-code`.
5. Send `只回复 OK`.
6. Confirm a streamed or final assistant reply appears.
7. Select code in the editor and run `Ask Selection`.
8. Confirm the selected code is injected as prompt context.
9. Copy a code block from an answer.
10. Regenerate the answer.
11. Reload the VS Code window.
12. Confirm the session still exists.

If all of the above work cleanly, the extension is close to the intended end state.

