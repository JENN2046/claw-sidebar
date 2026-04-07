# VS Code Sidebar TODO

This checklist is ordered for practical execution. Start at `P0`, then move downward.

## P0 Stability

- [ ] Unify workspace root detection
  Goal: opening `A:\VCP` or `A:\VCP\claw-code` should both resolve to the real `claw-code` root.
  Done when: the sidebar always finds `rust/run-with-cc-switch.ps1` automatically.
  Files: `extension.js`

- [ ] Improve `Quick Start` diagnostics
  Goal: show a structured health report instead of a single generic failure.
  Done when: the UI clearly reports `workspace`, `runner script`, `claw.exe`, `cc-switch`, and API env health separately.
  Files: `extension.js`

- [ ] Add request lifecycle debug logging
  Goal: make it easy to diagnose "sent but no reply" cases.
  Done when: a debug mode can show `ask sent`, `process started`, `chunk received`, `run ended`, and `exit code`.
  Files: `extension.js`

- [ ] Handle missing local dependencies gracefully
  Goal: fail with actionable guidance when PowerShell, Node, or `better-sqlite3` is unavailable.
  Done when: the UI explains exactly what is missing and how to fix it.
  Files: `extension.js`, `../rust/run-with-cc-switch.ps1`

## P1 Interaction

- [ ] Add a visible run status indicator
  Goal: users should know whether the sidebar is idle, starting, waiting, streaming, done, or failed.
  Done when: every request has an explicit state label in the UI.
  Files: `extension.js`

- [ ] Separate system output from assistant replies more clearly
  Goal: startup errors, doctor output, and status output should not feel like assistant messages.
  Done when: system messages use a more distinct layout and visual treatment.
  Files: `extension.js`

- [ ] Clean up top action layout
  Goal: reduce visual clutter from command exposure and make the primary actions clearer.
  Done when: the main actions feel intentional in the sidebar, with command palette support remaining secondary.
  Files: `package.json`, `extension.js`

- [ ] Improve session list usability
  Goal: make session management feel more like a real chat client.
  Done when: sessions can be renamed, show recent activity clearly, and stay sorted by recent use.
  Files: `extension.js`

## P2 Core Features

- [ ] Add richer context attachment
  Goal: allow more than just the active editor snippet.
  Done when: users can attach current file, selected code, or specific file paths to a prompt.
  Files: `extension.js`

- [ ] Add regenerate support
  Goal: rerun the last user turn without manual copy/paste.
  Done when: the previous prompt can be re-issued with one action.
  Files: `extension.js`

- [ ] Add full-message copy and insert-to-editor actions
  Goal: make answers easier to reuse.
  Done when: users can copy an entire assistant reply and insert selected code into the active editor.
  Files: `extension.js`

- [ ] Add CLI session resume support
  Goal: reconnect UI sessions to real CLI session history.
  Done when: the sidebar can reuse or resume a prior `claw --resume` context instead of only restoring local UI state.
  Files: `extension.js`, `../rust/crates/rusty-claude-cli/src/main.rs`

## P3 Engineering

- [ ] Split `extension.js` into smaller modules
  Goal: reduce maintenance cost and lower regression risk.
  Suggested split:
  `provider`
  `webview`
  `runner`
  `workspace-root`
  `session-store`
  Done when: the main entry file is small and responsibility boundaries are clear.
  Files: `extension.js`

- [ ] Add minimal automated tests
  Goal: protect the most fragile logic first.
  Priority cases:
  workspace root detection
  prompt composition
  session persistence
  stdout fallback behavior
  Done when: these paths have repeatable automated checks.
  Files: `extension.js` and any extracted modules

- [ ] Formalize versioning and packaging flow
  Goal: make releases predictable.
  Done when: patch releases increment `0.1.x`, feature releases increment `0.2.x`, and the VSIX package always matches `package.json`.
  Files: `package.json`

## Recommended Execution Order

1. Finish all `P0` items.
2. Do `P1` status indicator and system message cleanup.
3. Add `P2` context attachment and regenerate support.
4. Split files and add tests.

