"use strict";

function buildWebviewTemplate({
  nonce,
  cspSource,
  stylesUri,
  stateUri,
  rendererUri,
  mainUri
}) {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${cspSource} https: data:; style-src ${cspSource}; script-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${stylesUri}" />
    <title>Claw Sidebar</title>
  </head>
  <body>
    <div class="claw-app">
      <header class="topbar card">
        <div class="topbar-main">
          <div class="brand">Claw</div>
          <div class="topbar-session" id="statusSession">New Chat</div>
          <div class="status-badge status-idle" id="statusStateBadge">Idle</div>
        </div>
        <div class="status-strip">
          <div class="status-pill">
            <span class="status-pill-label">Workspace</span>
            <span id="statusWorkspace">unknown</span>
          </div>
          <div class="status-pill">
            <span class="status-pill-label">Model</span>
            <span id="statusModel">Auto / Main</span>
          </div>
          <div class="status-pill">
            <span class="status-pill-label">Run</span>
            <span id="statusRunState">Idle</span>
          </div>
        </div>
      </header>

      <section class="control-panels card">
        <div class="collapsible" id="panelSession">
          <button class="collapsible-header" type="button" data-panel="panelSession">
            <span>Session and Model</span>
            <span class="collapsible-chevron" id="panelSessionChevron">^</span>
          </button>
          <div class="collapsible-body" id="panelSessionBody">
            <div class="session-row">
              <select id="sessionSelect"></select>
              <button id="sessionNew" class="secondary iconish" type="button" title="New session">+</button>
              <button id="sessionDelete" class="secondary iconish" type="button" title="Delete session">-</button>
            </div>

            <div class="controls-grid">
              <select id="modelSlot">
                <option value="auto">Auto</option>
                <option value="main">Main</option>
                <option value="thinking">Thinking</option>
                <option value="explore">Explore</option>
                <option value="plan">Plan</option>
                <option value="verify">Verify</option>
                <option value="fast">Fast</option>
                <option value="custom">Custom</option>
              </select>
              <input id="model" type="text" placeholder="Custom model override" />
              <input id="maxTokens" type="number" min="128" max="8192" step="128" />
            </div>

            <label class="mini-toggle">
              <input id="includeEditor" type="checkbox" />
              <span>Include active editor context</span>
            </label>
          </div>
        </div>

        <div class="collapsible" id="panelAdvanced">
          <button class="collapsible-header" type="button" data-panel="panelAdvanced">
            <span>Advanced Model Mapping</span>
            <span class="collapsible-chevron collapsed" id="panelAdvancedChevron">^</span>
          </button>
          <div class="collapsible-body hidden" id="panelAdvancedBody">
            <div class="section">
              <div class="section-title">Role Model Mapping</div>
              <div class="subtle">
                Map each orchestration role to a concrete model. Leave empty to use provider defaults.
              </div>
              <div class="mapping-grid">
                <label class="field">
                  <span class="field-label">Main</span>
                  <input id="mapMain" type="text" />
                </label>
                <label class="field">
                  <span class="field-label">Thinking</span>
                  <input id="mapThinking" type="text" />
                </label>
                <label class="field">
                  <span class="field-label">Explore</span>
                  <input id="mapExplore" type="text" />
                </label>
                <label class="field">
                  <span class="field-label">Plan</span>
                  <input id="mapPlan" type="text" />
                </label>
                <label class="field">
                  <span class="field-label">Verify</span>
                  <input id="mapVerify" type="text" />
                </label>
                <label class="field">
                  <span class="field-label">Fast</span>
                  <input id="mapFast" type="text" />
                </label>
              </div>
              <div id="modelHint" class="subtle"></div>
            </div>
          </div>
        </div>

        <div class="collapsible" id="panelConnection">
          <button class="collapsible-header" type="button" data-panel="panelConnection">
            <span>Connection</span>
            <span class="collapsible-chevron collapsed" id="panelConnectionChevron">^</span>
          </button>
          <div class="collapsible-body hidden" id="panelConnectionBody">
            <div class="dual-grid">
              <label class="field">
                <span class="field-label">Mode</span>
                <select id="connectionMode">
                  <option value="cc-switch">CC switch</option>
                  <option value="manual">Direct API</option>
                  <option value="vcp-agent">VCP Agent Memory</option>
                </select>
              </label>
              <label class="field">
                <span class="field-label">Provider</span>
                <select id="provider">
                  <option value="anthropic">Anthropic</option>
                  <option value="openai">OpenAI / Compatible</option>
                  <option value="xai">xAI</option>
                </select>
              </label>
            </div>

            <label class="field">
              <span class="field-label">Base URL</span>
              <input id="baseUrl" type="text" placeholder="Leave empty for provider default" />
            </label>

            <div class="secret-row">
              <input id="apiKey" type="password" placeholder="API Key" />
              <button id="clearKeyBtn" class="secondary" type="button">Clear Key</button>
            </div>
            <div id="connectionHint" class="subtle"></div>

            <div id="vcpSection" class="section hidden">
              <div class="section-title">VCP Memory Binding</div>
              <div class="subtle">
                Bind the sidebar to a VCP Agent and Topic so memory lives inside VCPChat.
              </div>
              <div class="dual-grid">
                <label class="field">
                  <span class="field-label">Agent</span>
                  <select id="vcpAgent"></select>
                </label>
                <label class="field">
                  <span class="field-label">Topic</span>
                  <select id="vcpTopic"></select>
                </label>
              </div>
              <div class="row">
                <button id="refreshVcpBtn" class="secondary" type="button">Refresh VCP</button>
                <button id="newTopicBtn" class="secondary" type="button">New Topic</button>
              </div>
              <div id="vcpHint" class="subtle"></div>
            </div>
          </div>
        </div>
      </section>

      <main id="chat" class="chat" aria-live="polite"></main>

      <footer class="composer card">
        <textarea id="input" placeholder="Ask anything about your code..."></textarea>
        <div class="row composer-actions">
          <button id="sendBtn" type="button">Send</button>
          <button id="stopBtn" class="danger" type="button">Stop</button>
          <button id="newBtn" class="secondary" type="button">New Chat</button>
          <button id="quickStartBtn" class="secondary" type="button">Quick Start</button>
          <button id="viewFileBtn" class="secondary" type="button">View File</button>
          <button id="doctorBtn" class="secondary" type="button">Doctor</button>
          <button id="statusBtn" class="secondary" type="button">Status</button>
          <button id="replBtn" class="secondary" type="button">Open REPL</button>
        </div>
        <div class="hint">
          Use the editor command "Claw Sidebar: Ask Selection" to send selected code with one click.
        </div>
      </footer>
    </div>

    <script nonce="${nonce}" src="${stateUri}"></script>
    <script nonce="${nonce}" src="${rendererUri}"></script>
    <script nonce="${nonce}" src="${mainUri}"></script>
  </body>
</html>`;
}

module.exports = {
  buildWebviewTemplate
};
