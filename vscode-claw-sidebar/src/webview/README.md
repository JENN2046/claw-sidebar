# Webview Split Draft

This directory is a draft extraction target for the current inline webview code in `extension.js`.

## Files

- `template.js`
  Exports `buildWebviewTemplate()` and owns the HTML shell plus bootstrap script.

- `styles.css`
  Owns layout, state badge styles, cards, sessions, context chips, and composer styles.

- `webview-state.js`
  Owns the front-end state container for sessions, messages, context chips, and run-state transitions.

- `message-renderer.js`
  Owns message/session/context rendering helpers so message HTML is no longer embedded in the main webview logic.

## Intended migration path

1. Keep current `extension.js` behavior unchanged.
2. Replace `buildWebviewHtml(...)` with `buildWebviewTemplate(...)`.
3. Convert local disk paths to webview URIs for the CSS and JS files in this directory.
4. Move existing init/event handling into the bootstrap script gradually.
5. Expand the renderer to support:
   - code block toolbars
   - system diagnostic cards
   - error classification cards
   - context chips with source-specific icons

## Non-goals of this draft

- This draft is not wired into the extension yet.
- This draft does not yet preserve all existing connection-mode UI or VCP-specific forms.
- This draft is a layout and code-organization extraction target, not a full feature migration.
