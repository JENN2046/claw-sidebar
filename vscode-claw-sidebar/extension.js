const vscode = require("vscode");
const path = require("path");
const { spawn } = require("child_process");

const SESSIONS_KEY = "clawSidebar.sessions";
const ACTIVE_SESSION_KEY = "clawSidebar.activeSessionId";
const SESSION_LIMIT = 40;

function activate(context) {
  const provider = new ClawSidebarProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("clawSidebar.view", provider)
  );

  const bind = (id, handler) => {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  };

  bind("clawSidebar.focus", async () => {
    await provider.reveal();
  });
  bind("clawSidebar.newChat", async () => {
    await provider.reveal();
    provider.invokeClientAction("newChat");
  });
  bind("clawSidebar.stop", async () => {
    await provider.reveal();
    provider.stopActiveProcess();
    provider.invokeClientAction("stop");
  });
  bind("clawSidebar.doctor", async () => {
    await provider.reveal();
    provider.invokeClientAction("doctor");
  });
  bind("clawSidebar.status", async () => {
    await provider.reveal();
    provider.invokeClientAction("status");
  });
  bind("clawSidebar.repl", async () => {
    await provider.reveal();
    provider.invokeClientAction("repl");
  });
  bind("clawSidebar.quickStart", async () => {
    await provider.reveal();
    provider.invokeClientAction("quickStart");
  });
  bind("clawSidebar.viewFile", async () => {
    await provider.reveal();
    provider.invokeClientAction("viewFile");
  });
  bind("clawSidebar.askSelection", async () => {
    const prompt = buildSelectionAskPrompt();
    if (!prompt) {
      vscode.window.showInformationMessage("Select code first, then run 'Claw Sidebar: Ask Selection'.");
      return;
    }
    await provider.reveal();
    provider.invokeClientAction("askSelection", { prompt, send: true });
  });
}

function deactivate() {}

class ClawSidebarProvider {
  constructor(context) {
    this.context = context;
    this.view = null;
    this.activeRun = null;
    this.pendingClientActions = [];
  }

  async reveal() {
    await vscode.commands.executeCommand("workbench.view.extension.clawSidebar");
  }

  invokeClientAction(action, payload = {}) {
    const event = { action, payload };
    if (!this.view) {
      this.pendingClientActions.push(event);
      return;
    }
    this.post("invoke", event);
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = buildWebviewHtml(String(Date.now()));

    webviewView.onDidDispose(() => this.stopActiveProcess());
    webviewView.webview.onDidReceiveMessage(async (message) => {
      try {
        switch (message.type) {
          case "init":
            await this.handleInit();
            break;
          case "savePrefs":
            await this.savePrefs(message.payload || {});
            break;
          case "saveSession":
            await this.saveSession(message.payload || {});
            break;
          case "switchSession":
            await this.switchSession(message.payload || {});
            break;
          case "newChat":
            await this.createSession();
            break;
          case "deleteSession":
            await this.deleteSession(message.payload || {});
            break;
          case "ask":
            await this.runChatTurn(message);
            break;
          case "stop":
            this.stopActiveProcess();
            break;
          case "runDoctor":
            await this.runUtility("doctor");
            break;
          case "runStatus":
            await this.runUtility("status");
            break;
          case "openRepl":
            await this.openRepl();
            break;
          case "quickStart":
            await this.quickStart();
            break;
          case "viewFile":
            await this.viewFile();
            break;
          default:
            break;
        }
      } catch (error) {
        this.post("error", {
          message: error instanceof Error ? error.message : String(error)
        });
      }
    });
  }

  async handleInit() {
    const store = this.loadSessionStore();
    await this.persistSessionStore(store);
    const active = getActiveSession(store);
    this.post("init", {
      model: this.context.workspaceState.get("clawSidebar.model", ""),
      maxTokens: this.context.workspaceState.get("clawSidebar.maxTokens", 1024),
      includeEditorContext: this.context.workspaceState.get("clawSidebar.includeEditorContext", true),
      sessions: toSessionMetaList(store.sessions),
      activeSessionId: active.id,
      session: active.messages
    });
    if (this.pendingClientActions.length > 0) {
      for (const pending of this.pendingClientActions) {
        this.post("invoke", pending);
      }
      this.pendingClientActions = [];
    }
  }

  async savePrefs(payload) {
    if (Object.prototype.hasOwnProperty.call(payload, "model")) {
      await this.context.workspaceState.update("clawSidebar.model", String(payload.model || ""));
    }
    if (Object.prototype.hasOwnProperty.call(payload, "maxTokens")) {
      const parsed = Number(payload.maxTokens);
      if (Number.isFinite(parsed) && parsed > 0) {
        await this.context.workspaceState.update("clawSidebar.maxTokens", Math.floor(parsed));
      }
    }
    if (Object.prototype.hasOwnProperty.call(payload, "includeEditorContext")) {
      await this.context.workspaceState.update("clawSidebar.includeEditorContext", Boolean(payload.includeEditorContext));
    }
  }

  async saveSession(payload) {
    const store = this.loadSessionStore();
    const targetId = String(payload.sessionId || store.activeSessionId || "");
    const target = store.sessions.find((item) => item.id === targetId) || getActiveSession(store);
    target.messages = sanitizeSessionMessages(payload.messages);
    target.updatedAt = Date.now();
    target.title = buildSessionTitle(target.messages, target.title);
    store.activeSessionId = target.id;
    store.sessions = sortSessionsByUpdated(store.sessions);
    await this.persistSessionStore(store);
  }

  async switchSession(payload) {
    if (this.activeRun) {
      throw new Error("Stop the running request before switching sessions.");
    }
    const store = this.loadSessionStore();
    const sessionId = String(payload.sessionId || "");
    if (!store.sessions.some((item) => item.id === sessionId)) {
      return;
    }
    store.activeSessionId = sessionId;
    await this.persistSessionStore(store);
    this.postSessionState(store);
  }

  async createSession() {
    if (this.activeRun) {
      throw new Error("Stop the running request before creating a session.");
    }
    const store = this.loadSessionStore();
    const session = createEmptySession();
    store.sessions.unshift(session);
    store.sessions = store.sessions.slice(0, SESSION_LIMIT);
    store.activeSessionId = session.id;
    await this.persistSessionStore(store);
    this.postSessionState(store);
  }

  async deleteSession(payload) {
    if (this.activeRun) {
      throw new Error("Stop the running request before deleting a session.");
    }
    const store = this.loadSessionStore();
    const targetId = String(payload.sessionId || store.activeSessionId || "");
    if (store.sessions.length <= 1) {
      store.sessions[0] = createEmptySession(store.sessions[0].id);
      store.activeSessionId = store.sessions[0].id;
      await this.persistSessionStore(store);
      this.postSessionState(store);
      return;
    }

    store.sessions = store.sessions.filter((item) => item.id !== targetId);
    if (!store.sessions.some((item) => item.id === store.activeSessionId)) {
      store.activeSessionId = store.sessions[0].id;
    }
    await this.persistSessionStore(store);
    this.postSessionState(store);
  }

  postSessionState(store) {
    const active = getActiveSession(store);
    this.post("sessionState", {
      sessions: toSessionMetaList(store.sessions),
      activeSessionId: active.id,
      session: active.messages
    });
  }

  loadSessionStore() {
    let sessions = sanitizeStoredSessions(this.context.workspaceState.get(SESSIONS_KEY, []));
    if (sessions.length === 0) {
      sessions = [createEmptySession()];
    }
    const activeSessionIdRaw = String(this.context.workspaceState.get(ACTIVE_SESSION_KEY, sessions[0].id));
    const activeSessionId = sessions.some((item) => item.id === activeSessionIdRaw)
      ? activeSessionIdRaw
      : sessions[0].id;
    return { sessions: sortSessionsByUpdated(sessions), activeSessionId };
  }

  async persistSessionStore(store) {
    const sessions = sanitizeStoredSessions(store.sessions).slice(0, SESSION_LIMIT);
    const activeSessionId = sessions.some((item) => item.id === store.activeSessionId)
      ? store.activeSessionId
      : sessions[0].id;
    await this.context.workspaceState.update(SESSIONS_KEY, sessions);
    await this.context.workspaceState.update(ACTIVE_SESSION_KEY, activeSessionId);
  }

  async runChatTurn(message) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error("Open the claw-code workspace first.");
    }
    const scriptPath = path.join(workspaceRoot, "rust", "run-with-cc-switch.ps1");
    if (!pathExists(scriptPath)) {
      throw new Error(`Missing script: ${scriptPath}`);
    }
    if (this.activeRun) {
      throw new Error("A request is already running. Stop it first.");
    }

    const history = Array.isArray(message.history) ? message.history : [];
    const input = String(message.input || "").trim();
    if (!input) {
      throw new Error("Input is empty.");
    }

    const includeEditorContext = Boolean(message.includeEditorContext);
    const editorContext = includeEditorContext ? buildEditorContext(workspaceRoot) : "";
    const composedPrompt = buildComposedPrompt(history, input, editorContext);
    const model = String(message.model || "").trim();
    const maxTokens = clampPositiveInteger(message.maxTokens, 1024, 128, 8192);
    const args = [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
      "-Prompt", composedPrompt, "-MaxOutputTokens", String(maxTokens)
    ];
    if (model) {
      args.push("-Model", model);
    }

    const child = spawn("powershell.exe", args, {
      cwd: workspaceRoot,
      windowsHide: true,
      env: withHomeEnv(process.env)
    });
    const run = { child, cancelled: false, finished: false };
    this.activeRun = run;
    this.post("runStart", { model: model || "(cc-switch default)", maxTokens });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = sanitizeProcessText(chunk.toString());
      if (!text) return;
      stdout += text;
      this.post("runChunk", { text });
    });
    child.stderr.on("data", (chunk) => {
      const text = sanitizeProcessText(chunk.toString());
      if (!text) return;
      stderr += text;
      this.post("runChunk", { text });
    });
    child.on("error", (err) => {
      if (run.cancelled || run.finished) return;
      run.finished = true;
      const msg = sanitizeProcessText(err.message || String(err));
      stderr += msg;
      this.post("runEnd", { code: 1, stdout, stderr: msg || stderr });
      if (this.activeRun === run) this.activeRun = null;
    });
    child.on("close", (code) => {
      if (run.finished) return;
      run.finished = true;
      if (run.cancelled) {
        if (this.activeRun === run) this.activeRun = null;
        return;
      }
      this.post("runEnd", { code: code || 0, stdout, stderr });
      if (this.activeRun === run) this.activeRun = null;
    });
  }

  async quickStart() {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error("Open the claw-code workspace first.");
    }
    const rustDir = path.join(workspaceRoot, "rust");
    const scriptPath = path.join(rustDir, "run-with-cc-switch.ps1");
    if (!pathExists(scriptPath)) {
      throw new Error(`Missing script: ${scriptPath}`);
    }

    const logs = [];
    logs.push("Quick Start: checking workspace...");
    logs.push(`Workspace: ${workspaceRoot}`);
    logs.push(`Runner: ${scriptPath}`);

    const clawExe = path.join(rustDir, "target", "debug", "claw.exe");
    if (!pathExists(clawExe)) {
      logs.push("claw.exe not found. Building workspace...");
      const cargo = resolveCargoCommand(workspaceRoot);
      const buildResult = await runCommand(
        cargo.command,
        [...cargo.prefixArgs, "build", "--workspace"],
        rustDir,
        withHomeEnv(process.env)
      );
      if (buildResult.code !== 0) {
        throw new Error(
          [
            "Quick Start failed while building claw.",
            buildResult.stderr || buildResult.stdout || "cargo build returned non-zero exit code."
          ].join("\n\n")
        );
      }
      logs.push("Build completed.");
    } else {
      logs.push("claw.exe found.");
    }

    if (!pathExists(clawExe)) {
      throw new Error(`Quick Start could not find built binary: ${clawExe}`);
    }

    const doctor = await runCommand(clawExe, ["doctor"], rustDir, withHomeEnv(process.env));
    const status = await runCommand(clawExe, ["status"], rustDir, withHomeEnv(process.env));

    const outputParts = [logs.join("\n")];
    if (doctor.stdout) {
      outputParts.push(`[doctor]\n${doctor.stdout.trim()}`);
    }
    if (doctor.stderr) {
      outputParts.push(`[doctor stderr]\n${doctor.stderr.trim()}`);
    }
    if (status.stdout) {
      outputParts.push(`[status]\n${status.stdout.trim()}`);
    }
    if (status.stderr) {
      outputParts.push(`[status stderr]\n${status.stderr.trim()}`);
    }

    const code = doctor.code !== 0 ? doctor.code : status.code;
    this.post("utilityResult", {
      command: "quick-start",
      code,
      stdout: outputParts.join("\n\n"),
      stderr: ""
    });
  }

  async runUtility(command) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error("Open the claw-code workspace first.");
    }
    const rustDir = path.join(workspaceRoot, "rust");
    const clawExe = path.join(rustDir, "target", "debug", "claw.exe");
    if (!pathExists(clawExe)) {
      throw new Error(`Build claw first: missing ${clawExe}`);
    }

    const result = await runCommand(clawExe, [command], rustDir, withHomeEnv(process.env));
    this.post("utilityResult", { command, ...result });
  }

  async openRepl() {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error("Open the claw-code workspace first.");
    }
    const scriptPath = path.join(workspaceRoot, "rust", "run-with-cc-switch.ps1");
    if (!pathExists(scriptPath)) {
      throw new Error(`Missing script: ${scriptPath}`);
    }
    const terminal = vscode.window.createTerminal({
      name: "Claw REPL (CC switch)",
      cwd: workspaceRoot
    });
    terminal.show(true);
    terminal.sendText(`powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" -Repl`, true);
    this.post("utilityResult", { command: "repl", code: 0, stdout: "Opened Claw REPL in integrated terminal.", stderr: "" });
  }

  async viewFile() {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error("Open the claw-code workspace first.");
    }

    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(workspaceRoot, "**/*"),
      "**/{.git,node_modules,target,.claw,.claude,.vscode}/**",
      1500
    );
    const textFiles = files
      .filter((uri) => uri.scheme === "file")
      .sort((a, b) => a.fsPath.localeCompare(b.fsPath));

    if (textFiles.length === 0) {
      throw new Error("No files found in the current workspace.");
    }

    const picked = await vscode.window.showQuickPick(
      textFiles.map((uri) => ({
        label: getRelativePath(workspaceRoot, uri.fsPath),
        description: path.dirname(getRelativePath(workspaceRoot, uri.fsPath)) || ".",
        uri
      })),
      {
        matchOnDescription: true,
        placeHolder: "Choose a file to preview in Claw Sidebar"
      }
    );

    if (!picked) {
      return;
    }

    const fs = require("fs");
    let contentBuffer;
    try {
      contentBuffer = fs.readFileSync(picked.uri.fsPath);
    } catch (error) {
      throw new Error(`Failed to read file: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (contentBuffer.includes(0)) {
      this.post("fileViewed", {
        path: picked.label,
        language: getFileLanguage(picked.uri.fsPath),
        content: "Binary file preview is not supported in the sidebar.",
        truncated: false
      });
      return;
    }

    const fullText = contentBuffer.toString("utf8");
    const limit = 12000;
    const truncated = fullText.length > limit;
    const content = truncated ? `${fullText.slice(0, limit)}\n...[truncated]` : fullText;
    this.post("fileViewed", {
      path: picked.label,
      language: getFileLanguage(picked.uri.fsPath),
      content,
      truncated
    });
  }

  stopActiveProcess() {
    if (!this.activeRun) {
      return;
    }
    try {
      this.activeRun.cancelled = true;
      this.activeRun.child.kill();
    } catch (_) {
      // best effort
    }
    this.post("runCancelled", { message: "Request cancelled." });
  }

  post(type, payload) {
    if (this.view) {
      this.view.webview.postMessage({ type, payload });
    }
  }
}

function buildWebviewHtml(nonce) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      --bg: var(--vscode-sideBar-background);
      --fg: var(--vscode-sideBar-foreground);
      --muted: var(--vscode-descriptionForeground);
      --panel: var(--vscode-editorWidget-background);
      --border: var(--vscode-panel-border);
      --btn: var(--vscode-button-background);
      --btnfg: var(--vscode-button-foreground);
      --btnhover: var(--vscode-button-hoverBackground);
      --inputbg: var(--vscode-input-background);
      --inputfg: var(--vscode-input-foreground);
      --inputborder: var(--vscode-input-border);
    }
    * { box-sizing: border-box; }
    body { margin: 0; height: 100vh; display: flex; flex-direction: column; font-family: var(--vscode-font-family); color: var(--fg); background: var(--bg); font-size: 12px; }
    .top { border-bottom: 1px solid var(--border); padding: 8px; display: grid; gap: 6px; }
    .title { font-weight: 700; }
    .session-row { display: grid; grid-template-columns: 1fr auto auto; gap: 6px; }
    select, input, textarea { width: 100%; background: var(--inputbg); color: var(--inputfg); border: 1px solid var(--inputborder); border-radius: 8px; padding: 6px 8px; font-family: inherit; font-size: 12px; }
    .controls { display: grid; grid-template-columns: 1fr 88px; gap: 6px; }
    .mini { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11px; }
    .mini input { width: 14px; height: 14px; }
    .chat { flex: 1; overflow: auto; padding: 8px; display: grid; gap: 8px; }
    .msg { border: 1px solid var(--border); border-radius: 8px; padding: 8px; white-space: normal; word-break: break-word; }
    .msg.user { background: color-mix(in srgb, #3fb9a8 20%, transparent); }
    .msg.assistant { background: color-mix(in srgb, var(--panel) 80%, transparent); }
    .msg.system { background: color-mix(in srgb, #f59e0b 18%, transparent); }
    .label { display: block; font-size: 10px; text-transform: uppercase; color: var(--muted); margin-bottom: 4px; }
    .plain { white-space: pre-wrap; }
    .md p { margin: 0 0 8px; }
    .md ul { margin: 0 0 8px; padding-left: 18px; }
    .md p:last-child, .md ul:last-child { margin-bottom: 0; }
    .md code.inline { font-family: var(--vscode-editor-font-family); border: 1px solid var(--border); border-radius: 5px; padding: 1px 4px; }
    .composer { border-top: 1px solid var(--border); padding: 8px; display: grid; gap: 6px; }
    textarea { min-height: 74px; resize: vertical; }
    .row { display: flex; gap: 6px; flex-wrap: wrap; }
    button { border: none; border-radius: 8px; background: var(--btn); color: var(--btnfg); padding: 6px 10px; font-size: 12px; cursor: pointer; }
    button.secondary { border: 1px solid var(--border); background: color-mix(in srgb, var(--panel) 80%, transparent); color: var(--fg); }
    button.danger { background: #b42318; color: #fff; }
    button:hover { background: var(--btnhover); }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
 .status-bar { display: flex; align-items: center; gap: 4px; padding: 6px 8px; background: color-mix(in srgb, var(--panel) 80%, transparent); border-bottom: 1px solid var(--border); font-size: 11px; flex-wrap: wrap; }
 .status-item { display: flex; align-items: center; gap: 4px; padding: 2px 6px; border-radius: 4px; background: color-mix(in srgb, var(--bg) 60%, transparent); }
 .status-icon { font-size: 11px; }
 .status-text { color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px; }
 .status-sep { color: var(--muted); font-size: 10px; margin: 0 2px; }
 .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
 .status-dot.idle { background: #22c55e; box-shadow: 0 0 2px #22c55e; }
 .status-dot.running { background: #f59e0b; box-shadow: 0 0 2px #f59e0b; animation: pulse 1.5s ease-in-out infinite; }
 .status-dot.error { background: #ef4444; box-shadow: 0 0 2px #ef4444; }
 @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    .hint { color: var(--muted); font-size: 11px; }
    .code { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; margin: 8px 0; }
    .code-head { display: flex; align-items: center; justify-content: space-between; padding: 4px 8px; border-bottom: 1px solid var(--border); font-size: 10px; color: var(--muted); text-transform: uppercase; }
    .copy-btn { border: 1px solid var(--border); border-radius: 6px; padding: 2px 6px; background: color-mix(in srgb, var(--panel) 80%, transparent); color: var(--fg); font-size: 10px; }
    .code pre { margin: 0; padding: 8px; overflow: auto; }
    .code code { display: block; white-space: pre; font-family: var(--vscode-editor-font-family); }
    .tok-kw { color: #d19a66; font-weight: 600; }
    .tok-str { color: #98c379; }
    .tok-com { color: #7f848e; font-style: italic; }
    .tok-num { color: #61afef; }
    .tok-bi { color: #c678dd; }
  </style>
</head>
<body>
  <!-- Status Bar -->
<div class="status-bar">
  <div class="status-item" title="Workspace folder">
    <span class="status-icon">📁</span>
    <span id="statusWorkspace" class="status-text">—</span>
  </div>
  <div class="status-sep">|</div>
  <div class="status-item" title="Active session">
    <span class="status-icon">💬</span>
    <span id="statusSession" class="status-text">—</span>
  </div>
  <div class="status-sep">|</div>
  <div class="status-item" title="Model">
    <span class="status-icon">🤖</span>
    <span id="statusModel" class="status-text">—</span>
  </div>
  <div class="status-sep">|</div>
  <div class="status-item" title="Run state">
    <span id="statusIndicator" class="status-dot idle"></span>
    <span id="statusRunState" class="status-text">Idle</span>
  </div>
</div>
    <div class="title">Claw Code Sidebar</div>
    <div class="session-row">
      <select id="sessionSelect"></select>
      <button id="sessionNew" class="secondary" title="New session">+</button>
      <button id="sessionDelete" class="secondary" title="Delete session">-</button>
    </div>
    <div class="controls">
      <input id="model" type="text" placeholder="Model (empty = cc-switch default)" />
      <input id="maxTokens" type="number" min="128" max="8192" step="128" />
    </div>
    <label class="mini"><input id="includeEditor" type="checkbox" />Include active editor context</label>
  </div>

  <div id="chat" class="chat"></div>

  <div class="composer">
    <textarea id="input" placeholder="Ask anything about your code..."></textarea>
    <div class="row">
      <button id="sendBtn">Send</button>
      <button id="stopBtn" class="danger">Stop</button>
      <button id="newBtn" class="secondary">New Chat</button>
      <button id="quickStartBtn" class="secondary">Quick Start</button>
      <button id="viewFileBtn" class="secondary">View File</button>
      <button id="doctorBtn" class="secondary">Doctor</button>
      <button id="statusBtn" class="secondary">Status</button>
      <button id="replBtn" class="secondary">Open REPL</button>
    </div>
    <div class="hint">Use command "Claw Sidebar: Ask Selection" to ask about selected code with one click.</div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const el = {
      chat: document.getElementById("chat"),
      input: document.getElementById("input"),
      send: document.getElementById("sendBtn"),
      stop: document.getElementById("stopBtn"),
      newBtn: document.getElementById("newBtn"),
      quickStart: document.getElementById("quickStartBtn"),
      viewFile: document.getElementById("viewFileBtn"),
      doctor: document.getElementById("doctorBtn"),
      status: document.getElementById("statusBtn"),
      repl: document.getElementById("replBtn"),
      model: document.getElementById("model"),
      maxTokens: document.getElementById("maxTokens"),
      includeEditor: document.getElementById("includeEditor"),
      sessionSelect: document.getElementById("sessionSelect"),
      sessionNew: document.getElementById("sessionNew"),
      sessionDelete: document.getElementById("sessionDelete")
    };

    const state = {
      sessions: [],
      activeSessionId: "",
      messages: [],
      running: false,
      assistantMessageIndex: -1
    };
    let persistTimer = null;

    function normalizeMessages(messages) {
      if (!Array.isArray(messages)) return [];
      return messages
        .filter((m) => m && (m.role === "user" || m.role === "assistant" || m.role === "system") && typeof m.content === "string")
        .slice(-120)
        .map((m) => ({ role: m.role, content: String(m.content) }));
    }

    function normalizeSessions(sessions) {
      if (!Array.isArray(sessions)) return [];
      return sessions
        .filter((s) => s && typeof s.id === "string" && typeof s.title === "string")
        .map((s) => ({ id: s.id, title: s.title, updatedAt: Number(s.updatedAt) || Date.now() }));
    }

    function persistNow() {
      if (!state.activeSessionId) return;
      vscode.postMessage({
        type: "saveSession",
        payload: { sessionId: state.activeSessionId, messages: state.messages }
      });
    }

    function schedulePersist() {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        persistTimer = null;
        persistNow();
      }, 250);
    }

    function renderSessionSelect() {
      const html = state.sessions.map((s) => {
        const selected = s.id === state.activeSessionId ? " selected" : "";
        return "<option value=\\"" + escapeHtml(s.id) + "\\"" + selected + ">" + escapeHtml(s.title || "New Chat") + "</option>";
      }).join("");
      el.sessionSelect.innerHTML = html;
      el.sessionSelect.disabled = state.running || state.sessions.length === 0;
      el.sessionNew.disabled = state.running;
      el.sessionDelete.disabled = state.running || state.sessions.length === 0;
    }

    function render(scroll = true) {
      el.chat.innerHTML = state.messages.map((m) => {
        const who = m.role === "user" ? "You" : (m.role === "assistant" ? "Claw" : "System");
        return "<div class=\\"msg " + m.role + "\\"><span class=\\"label\\">" + who + "</span><div>" + renderMessageHtml(m) + "</div></div>";
      }).join("");
      if (scroll) el.chat.scrollTop = el.chat.scrollHeight;
    }

    function addMessage(role, content) {
      state.messages.push({ role, content });
      render();
      schedulePersist();
    }

    function updateAssistantChunk(text) {
      if (state.assistantMessageIndex < 0) return;
      const msg = state.messages[state.assistantMessageIndex];
      if (!msg) return;
      msg.content += text;
      render(false);
      schedulePersist();
    }

    function setRunning(running) {
      state.running = running;
      el.send.disabled = running;
      el.newBtn.disabled = running;
      el.quickStart.disabled = running;
      el.viewFile.disabled = running;
      el.doctor.disabled = running;
      el.status.disabled = running;
      el.repl.disabled = running;
      el.stop.disabled = !running;
      renderSessionSelect();
    }

    function applySessionState(payload, options) {
      const opts = options || {};
      const sessions = normalizeSessions(payload.sessions);
      if (sessions.length === 0) return;
      state.sessions = sessions;
      state.activeSessionId = sessions.some((s) => s.id === payload.activeSessionId) ? payload.activeSessionId : sessions[0].id;
      state.messages = normalizeMessages(payload.session);
      state.assistantMessageIndex = -1;
      renderSessionSelect();
      render();
      if (!opts.skipPersist) schedulePersist();
    }

    function sendPrompt() {
      if (state.running) return;
      const input = el.input.value.trim();
      if (!input) return;
      addMessage("user", input);
      el.input.value = "";
      state.assistantMessageIndex = state.messages.length;
      addMessage("assistant", "");
      setRunning(true);
      vscode.postMessage({
        type: "ask",
        input,
        history: state.messages.slice(0, -1),
        model: el.model.value.trim(),
        maxTokens: Number(el.maxTokens.value || 1024),
        includeEditorContext: el.includeEditor.checked
      });
    }

    function savePrefs() {
      vscode.postMessage({
        type: "savePrefs",
        payload: {
          model: el.model.value,
          maxTokens: Number(el.maxTokens.value || 1024),
          includeEditorContext: el.includeEditor.checked
        }
      });
    }

    function prefillPrompt(prompt, sendNow) {
      const text = String(prompt || "").trim();
      if (!text) return;
      el.input.value = text;
      el.input.focus();
      if (sendNow) sendPrompt();
    }

    el.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendPrompt();
      }
    });
    el.model.addEventListener("change", savePrefs);
    el.maxTokens.addEventListener("change", savePrefs);
    el.includeEditor.addEventListener("change", savePrefs);
    el.send.addEventListener("click", sendPrompt);
    el.stop.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
    el.newBtn.addEventListener("click", () => {
      if (!state.running) {
        persistNow();
        vscode.postMessage({ type: "newChat" });
      }
    });
    el.quickStart.addEventListener("click", () => {
      if (!state.running) {
        setRunning(true);
        vscode.postMessage({ type: "quickStart" });
      }
    });
    el.viewFile.addEventListener("click", () => {
      if (!state.running) {
        vscode.postMessage({ type: "viewFile" });
      }
    });
    el.sessionNew.addEventListener("click", () => {
      if (!state.running) {
        persistNow();
        vscode.postMessage({ type: "newChat" });
      }
    });
    el.sessionDelete.addEventListener("click", () => {
      if (!state.running && state.activeSessionId) {
        persistNow();
        vscode.postMessage({ type: "deleteSession", payload: { sessionId: state.activeSessionId } });
      }
    });
    el.sessionSelect.addEventListener("change", () => {
      if (!state.running && el.sessionSelect.value && el.sessionSelect.value !== state.activeSessionId) {
        persistNow();
        vscode.postMessage({ type: "switchSession", payload: { sessionId: el.sessionSelect.value } });
      }
    });
    el.doctor.addEventListener("click", () => { if (!state.running) { setRunning(true); vscode.postMessage({ type: "runDoctor" }); } });
    el.status.addEventListener("click", () => { if (!state.running) { setRunning(true); vscode.postMessage({ type: "runStatus" }); } });
    el.repl.addEventListener("click", () => vscode.postMessage({ type: "openRepl" }));

    el.chat.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest(".copy-btn");
      if (!button) return;
      const block = button.closest(".code");
      if (!block) return;
      const code = block.querySelector("pre code");
      const text = code ? code.textContent || "" : "";
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = "Copied";
        setTimeout(() => { button.textContent = "Copy"; }, 1200);
      } catch (_) {
        addMessage("system", "Copy failed: clipboard unavailable.");
      }
    });

    window.addEventListener("message", (event) => {
      const msg = event.data || {};
      const payload = msg.payload || {};
      if (msg.type === "init") {
        el.model.value = payload.model || "";
        el.maxTokens.value = payload.maxTokens || 1024;
        el.includeEditor.checked = Boolean(payload.includeEditorContext);
        applySessionState(payload, { skipPersist: true });
        if (state.messages.length === 0) addMessage("system", "Ready. Connected to local Claw runner.");
        setRunning(false);
        return;
      }
      if (msg.type === "sessionState") {
        applySessionState(payload, { skipPersist: true });
        setRunning(false);
        return;
      }
      if (msg.type === "runChunk") {
        updateAssistantChunk(payload.text || "");
        return;
      }
      if (msg.type === "runEnd") {
        setRunning(false);
        if (payload.code !== 0) {
          if (state.assistantMessageIndex >= 0) {
            const m = state.messages[state.assistantMessageIndex];
            if (m && !m.content.trim()) state.messages.splice(state.assistantMessageIndex, 1);
          }
          addMessage("system", (payload.stderr || payload.stdout || "Request failed.").trim());
        } else if (state.assistantMessageIndex >= 0) {
          const m = state.messages[state.assistantMessageIndex];
          if (m && !m.content.trim()) {
            const fallback = String(payload.stdout || payload.stderr || "").trim();
            m.content = fallback || "(no output)";
            render();
          }
          schedulePersist();
        }
        state.assistantMessageIndex = -1;
        return;
      }
      if (msg.type === "runCancelled") {
        setRunning(false);
        if (state.assistantMessageIndex >= 0) {
          const m = state.messages[state.assistantMessageIndex];
          if (m && !m.content.trim()) {
            state.messages.splice(state.assistantMessageIndex, 1);
            render();
          }
        }
        addMessage("system", payload.message || "Cancelled.");
        state.assistantMessageIndex = -1;
        return;
      }
      if (msg.type === "utilityResult") {
        setRunning(false);
        const lines = [];
        if (payload.stdout) lines.push(payload.stdout.trim());
        if (payload.stderr) lines.push(payload.stderr.trim());
        addMessage("system", lines.join("\\n\\n") || (payload.command + " done."));
        return;
      }
      if (msg.type === "fileViewed") {
        setRunning(false);
        const note = payload.truncated ? "\\n\\nPreview truncated for sidebar readability." : "";
        const fence = String.fromCharCode(96).repeat(3);
        addMessage(
          "system",
          [
            "Viewing file:",
            "- Path: " + (payload.path || "<unknown>"),
            "- Language: " + (payload.language || "text"),
            "",
            fence + (payload.language || "text"),
            payload.content || "",
            fence,
            note.trim()
          ].filter(Boolean).join("\\n")
        );
        return;
      }
      if (msg.type === "error") {
        setRunning(false);
        addMessage("system", payload.message || "Unexpected error.");
        return;
      }
      if (msg.type === "invoke") {
        const action = payload.action;
        const data = payload.payload || {};
        if (action === "newChat") el.newBtn.click();
        else if (action === "stop") el.stop.click();
        else if (action === "quickStart") el.quickStart.click();
        else if (action === "viewFile") el.viewFile.click();
        else if (action === "doctor") el.doctor.click();
        else if (action === "status") el.status.click();
        else if (action === "repl") el.repl.click();
        else if (action === "askSelection") prefillPrompt(data.prompt || "", Boolean(data.send));
      }
    });

    window.addEventListener("beforeunload", persistNow);
    vscode.postMessage({ type: "init" });
    setRunning(false);

    function renderMessageHtml(message) {
      const content = String((message && message.content) || "");
      if (message.role === "assistant" || message.role === "system") return "<div class=\\"md\\">" + renderMarkdown(content) + "</div>";
      return "<div class=\\"plain\\">" + escapeHtml(content).replace(/\\n/g, "<br />") + "</div>";
    }

    function renderMarkdown(text) {
      const source = String(text || "");
      const fence = String.fromCharCode(96).repeat(3);
      const parts = [];
      let i = 0;
      while (i < source.length) {
        const start = source.indexOf(fence, i);
        if (start < 0) {
          parts.push(renderMarkdownText(source.slice(i)));
          break;
        }
        const before = source.slice(i, start);
        if (before) parts.push(renderMarkdownText(before));
        const lineEnd = source.indexOf("\\n", start + fence.length);
        if (lineEnd < 0) {
          parts.push(renderMarkdownText(source.slice(start)));
          break;
        }
        const end = source.indexOf(fence, lineEnd + 1);
        if (end < 0) {
          parts.push(renderMarkdownText(source.slice(start)));
          break;
        }
        const langRaw = source.slice(start + fence.length, lineEnd).trim();
        const lang = escapeHtml(langRaw || "code");
        const codeRaw = source.slice(lineEnd + 1, end);
        const code = highlightCode(codeRaw, langRaw);
        parts.push("<div class=\\"code\\"><div class=\\"code-head\\"><span>" + lang + "</span><button class=\\"copy-btn\\">Copy</button></div><pre><code>" + code + "</code></pre></div>");
        i = end + fence.length;
      }
      return parts.join("") || "<p></p>";
    }

    function renderMarkdownText(raw) {
      const lines = String(raw).split("\\n");
      const parts = [];
      let para = [];
      let list = [];
      const flushPara = () => {
        if (para.length === 0) return;
        parts.push("<p>" + renderInline(para.join("\\n")).replace(/\\n/g, "<br />") + "</p>");
        para = [];
      };
      const flushList = () => {
        if (list.length === 0) return;
        parts.push("<ul>" + list.map((x) => "<li>" + x + "</li>").join("") + "</ul>");
        list = [];
      };
      for (const line of lines) {
        const m = line.match(/^\\s*[-*]\\s+(.*)$/);
        if (m) {
          flushPara();
          list.push(renderInline(m[1]));
          continue;
        }
        if (!line.trim()) {
          flushPara();
          flushList();
          continue;
        }
        flushList();
        para.push(line);
      }
      flushPara();
      flushList();
      return parts.join("");
    }

    function renderInline(text) {
      const marker = String.fromCharCode(96);
      let source = String(text || "");
      let out = "";
      while (source.length > 0) {
        const start = source.indexOf(marker);
        if (start < 0) {
          out += escapeHtml(source);
          break;
        }
        const end = source.indexOf(marker, start + 1);
        if (end < 0) {
          out += escapeHtml(source);
          break;
        }
        out += escapeHtml(source.slice(0, start));
        out += "<code class=\\"inline\\">" + escapeHtml(source.slice(start + 1, end)) + "</code>";
        source = source.slice(end + 1);
      }
      return out;
    }

    function highlightCode(codeRaw, languageRaw) {
      const lang = normalizeLang(languageRaw);
      let text = escapeHtml(String(codeRaw || ""));
      const frozen = [];
      const freeze = (regex, cls) => {
        text = text.replace(regex, (s) => {
          const idx = frozen.push("<span class=\\"" + cls + "\\">" + s + "</span>") - 1;
          return "@@HL" + idx + "@@";
        });
      };
      freeze(/"(?:[^"\\n\\\\]|\\\\.)*"|'(?:[^'\\n\\\\]|\\\\.)*'/g, "tok-str");
      if (lang === "js" || lang === "ts" || lang === "rust" || lang === "c" || lang === "cpp") {
        freeze(/\\/\\*[\\s\\S]*?\\*\\//g, "tok-com");
        freeze(/\\/\\/[^\\n]*/g, "tok-com");
      } else if (lang === "py" || lang === "sh") {
        freeze(/#[^\\n]*/g, "tok-com");
      }
      text = text.replace(/\\b\\d+(?:\\.\\d+)?\\b/g, "<span class=\\"tok-num\\">$&</span>");
      const kw = getKeywords(lang);
      if (kw.length) {
        text = text.replace(new RegExp("\\\\b(" + kw.join("|") + ")\\\\b", "g"), "<span class=\\"tok-kw\\">$1</span>");
      }
      const bi = getBuiltins(lang);
      if (bi.length) {
        text = text.replace(new RegExp("\\\\b(" + bi.join("|") + ")\\\\b", "g"), "<span class=\\"tok-bi\\">$1</span>");
      }
      text = text.replace(/@@HL(\\d+)@@/g, (_, n) => frozen[Number(n)] || "");
      return text;
    }

    function normalizeLang(raw) {
      const s = String(raw || "").trim().toLowerCase();
      if (!s) return "plain";
      if (s === "javascript" || s === "jsx") return "js";
      if (s === "typescript" || s === "tsx") return "ts";
      if (s === "python" || s === "py") return "py";
      if (s === "bash" || s === "shell" || s === "sh" || s === "zsh" || s === "powershell" || s === "ps1") return "sh";
      if (s === "rs") return "rust";
      if (s === "c++") return "cpp";
      return s;
    }

    function getKeywords(lang) {
      if (lang === "js" || lang === "ts") return ["const","let","var","function","return","if","else","for","while","switch","case","break","continue","try","catch","finally","throw","class","extends","new","import","from","export","default","async","await","typeof","instanceof","in","of","this"];
      if (lang === "json") return ["true","false","null"];
      if (lang === "py") return ["def","class","return","if","elif","else","for","while","break","continue","try","except","finally","raise","with","as","import","from","lambda","yield","async","await","pass"];
      if (lang === "rust") return ["fn","let","mut","pub","struct","enum","impl","trait","match","if","else","loop","while","for","in","return","break","continue","use","mod","crate","self","super","where","async","await","move"];
      if (lang === "sh") return ["if","then","else","fi","for","in","do","done","case","esac","while","until","function"];
      if (lang === "c" || lang === "cpp") return ["int","char","float","double","void","if","else","for","while","switch","case","break","continue","return","struct","class","public","private","protected","template","typename","using","namespace","new","delete","const","static","auto"];
      return [];
    }

    function getBuiltins(lang) {
      if (lang === "js" || lang === "ts") return ["console","Promise","Object","Array","String","Number","Boolean","Map","Set","Date","Error","JSON","Math"];
      if (lang === "py") return ["print","len","range","str","int","float","list","dict","set","tuple","open","type","isinstance"];
      if (lang === "rust") return ["String","Vec","Option","Result","Some","None","Ok","Err","println","format"];
      if (lang === "sh") return ["echo","cd","ls","cat","grep","awk","sed","export","source"];
      return [];
    }

    function escapeHtml(text) {
      return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
  </script>
</body>
</html>`;
}

function buildSelectionAskPrompt() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !editor.selection || editor.selection.isEmpty) {
    return "";
  }
  const text = editor.document.getText(editor.selection).trim();
  if (!text) {
    return "";
  }
  const workspaceRoot = getWorkspaceRoot();
  const filePath = editor.document.uri.fsPath || "<untitled>";
  const relPath = workspaceRoot && filePath.startsWith(workspaceRoot)
    ? filePath.slice(workspaceRoot.length).replace(/^[\\\\/]/, "")
    : filePath;
  const language = editor.document.languageId || "text";
  return [
    "Please analyze this selected code and answer briefly:",
    "- What it does",
    "- Potential risks or bugs",
    "- Concrete improvement suggestions",
    "",
    `Path: ${relPath}`,
    `Language: ${language}`,
    "",
    `\`\`\`${language}`,
    clampText(text, 6000),
    "```"
  ].join("\n");
}

function createEmptySession(existingId) {
  return { id: existingId || createSessionId(), title: "New Chat", messages: [], updatedAt: Date.now() };
}

function createSessionId() {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function buildSessionTitle(messages, fallback) {
  const firstUser = messages.find((entry) => entry && entry.role === "user" && entry.content);
  if (!firstUser) {
    return fallback || "New Chat";
  }
  return clampText(firstUser.content.replace(/\s+/g, " ").trim() || "New Chat", 48);
}

function sanitizeStoredSessions(sessions) {
  if (!Array.isArray(sessions)) {
    return [];
  }
  return sessions
    .map((session) => sanitizeStoredSession(session))
    .filter((session) => session !== null)
    .slice(0, SESSION_LIMIT);
}

function sanitizeStoredSession(session) {
  if (!session || typeof session !== "object") {
    return null;
  }
  const id = typeof session.id === "string" && session.id.trim() ? session.id.trim() : createSessionId();
  const title = typeof session.title === "string" && session.title.trim() ? clampText(session.title.trim(), 64) : "New Chat";
  const updatedAt = Number.isFinite(Number(session.updatedAt)) ? Number(session.updatedAt) : Date.now();
  return { id, title, updatedAt, messages: sanitizeSessionMessages(session.messages) };
}

function sortSessionsByUpdated(sessions) {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
}

function getActiveSession(store) {
  return store.sessions.find((session) => session.id === store.activeSessionId) || store.sessions[0];
}

function toSessionMetaList(sessions) {
  return sessions.map((session) => ({
    id: session.id,
    title: session.title,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length
  }));
}

function pathExists(targetPath) {
  try {
    require("fs").accessSync(targetPath);
    return true;
  } catch (_) {
    return false;
  }
}

function withHomeEnv(baseEnv) {
  const env = { ...baseEnv };
  if (!env.HOME && env.USERPROFILE) {
    env.HOME = env.USERPROFILE;
  }
  return env;
}

function resolveCargoCommand(workspaceRoot) {
  const parent = path.dirname(workspaceRoot);
  const candidates = [
    path.join(parent, ".cargo", "bin", "cargo.exe"),
    path.join(workspaceRoot, ".cargo", "bin", "cargo.exe")
  ];
  for (const candidate of candidates) {
    if (pathExists(candidate)) {
      return { command: candidate, prefixArgs: [] };
    }
  }
  return { command: "cargo", prefixArgs: [] };
}

function getWorkspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return null;
  }

  for (const folder of folders) {
    const resolved = findClawCodeRoot(folder.uri.fsPath);
    if (resolved) {
      return resolved;
    }
  }

  return folders[0].uri.fsPath;
}

function getRelativePath(workspaceRoot, filePath) {
  return filePath.startsWith(workspaceRoot)
    ? filePath.slice(workspaceRoot.length).replace(/^[\\/]/, "")
    : filePath;
}

function getFileLanguage(filePath) {
  const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
  if (!ext) {
    return "text";
  }
  if (ext === "js" || ext === "cjs" || ext === "mjs") return "javascript";
  if (ext === "ts" || ext === "tsx") return "typescript";
  if (ext === "rs") return "rust";
  if (ext === "ps1") return "powershell";
  if (ext === "md") return "markdown";
  if (ext === "json") return "json";
  if (ext === "yml") return "yaml";
  return ext;
}

function findClawCodeRoot(basePath) {
  const fs = require("fs");
  const candidates = [basePath, path.join(basePath, "claw-code")];
  for (const candidate of candidates) {
    if (pathExists(path.join(candidate, "rust", "run-with-cc-switch.ps1"))) {
      return candidate;
    }
  }

  try {
    const entries = fs.readdirSync(basePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidate = path.join(basePath, entry.name);
      if (pathExists(path.join(candidate, "rust", "run-with-cc-switch.ps1"))) {
        return candidate;
      }
    }
  } catch (_) {
    // best effort only
  }

  return null;
}

function sanitizeProcessText(text) {
  if (!text) return "";
  let out = text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b7/g, "")
    .replace(/\u001b8/g, "")
    .replace(/\r/g, "")
    .replace(/\u0008/g, "")
    .replace(/\u0007/g, "");
  out = out.split("\n").filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    if (trimmed.includes("馃 Thinking...") || trimmed.includes("鉁?鉁?Done")) return false;
    return true;
  }).join("\n");
  return out;
}

function sanitizeSessionMessages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages
    .filter((entry) => entry && (entry.role === "user" || entry.role === "assistant" || entry.role === "system") && typeof entry.content === "string")
    .slice(-120)
    .map((entry) => ({ role: entry.role, content: clampText(entry.content, 12000) }));
}

function clampPositiveInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const intValue = Math.floor(parsed);
  if (intValue < min) return min;
  if (intValue > max) return max;
  return intValue;
}

function buildComposedPrompt(history, latestInput, editorContext) {
  const safeHistory = history
    .filter((entry) => entry && (entry.role === "user" || entry.role === "assistant") && typeof entry.content === "string" && entry.content.trim().length > 0)
    .slice(-10)
    .map((entry) => ({ role: entry.role, content: clampText(entry.content.trim(), 1400) }));
  const lines = [];
  lines.push("You are an in-editor coding assistant. Keep responses practical and concise.");
  if (safeHistory.length > 0) {
    lines.push("Conversation so far:");
    for (const item of safeHistory) {
      lines.push(`${item.role.toUpperCase()}: ${item.content}`);
    }
  }
  if (editorContext) {
    lines.push("Active editor context:");
    lines.push(editorContext);
  }
  lines.push("Latest user request:");
  lines.push(latestInput);
  lines.push("Answer directly.");
  return clampText(lines.join("\n\n"), 16000);
}

function clampText(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...[truncated]`;
}

function buildEditorContext(workspaceRoot) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return "";
  const doc = editor.document;
  const filePath = doc.uri.fsPath || "<untitled>";
  const relPath = filePath.startsWith(workspaceRoot) ? filePath.slice(workspaceRoot.length).replace(/^[\\\\/]/, "") : filePath;
  let excerpt = "";
  if (editor.selection && !editor.selection.isEmpty) {
    excerpt = doc.getText(editor.selection);
  } else {
    const center = editor.selection ? editor.selection.active.line : 0;
    const start = Math.max(0, center - 60);
    const end = Math.min(doc.lineCount - 1, center + 60);
    const range = new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
    excerpt = doc.getText(range);
  }
  excerpt = clampText(excerpt, 6000);
  return [`Path: ${relPath}`, `Language: ${doc.languageId}`, "", excerpt].join("\n");
}

function runCommand(command, args, cwd, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += sanitizeProcessText(chunk.toString()); });
    child.stderr.on("data", (chunk) => { stderr += sanitizeProcessText(chunk.toString()); });
    child.on("error", (err) => resolve({ code: 1, stdout, stderr: `${stderr}\n${err.message}`.trim() }));
    child.on("close", (code) => resolve({ code: code || 0, stdout, stderr }));
  });
}

module.exports = { activate, deactivate };
