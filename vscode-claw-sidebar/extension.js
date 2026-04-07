const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const SESSIONS_KEY = "clawSidebar.sessions";
const ACTIVE_SESSION_KEY = "clawSidebar.activeSessionId";
const SESSION_LIMIT = 40;
const PREF_KEYS = {
  model: "clawSidebar.model",
  modelSlot: "clawSidebar.modelSlot",
  modelMappings: "clawSidebar.modelMappings",
  showAdvancedModelSettings: "clawSidebar.showAdvancedModelSettings",
  maxTokens: "clawSidebar.maxTokens",
  includeEditorContext: "clawSidebar.includeEditorContext",
  connectionMode: "clawSidebar.connectionMode",
  provider: "clawSidebar.provider",
  baseUrl: "clawSidebar.baseUrl",
  vcpAgentId: "clawSidebar.vcpAgentId",
  vcpTopicId: "clawSidebar.vcpTopicId"
};
const SECRET_KEYS = {
  apiKey: "clawSidebar.apiKey"
};
const MODEL_SLOTS = ["main", "thinking", "explore", "plan", "verify", "fast"];

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
    this.output = vscode.window.createOutputChannel("Claw Sidebar");
    this.context.subscriptions.push(this.output);
    this.log("Provider created.");
  }

  async reveal() {
    await vscode.commands.executeCommand("workbench.view.extension.clawSidebar");
  }

  invokeClientAction(action, payload = {}) {
    const event = { action, payload };
    if (!this.view) {
      this.log(`Queue invoke action: ${action}`);
      this.pendingClientActions.push(event);
      return;
    }
    this.log(`Invoke action: ${action}`);
    this.post("invoke", event);
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    const nonce = createNonce();
    webviewView.webview.html = buildWebviewHtml(nonce, webviewView.webview.cspSource);
    this.log("Webview resolved and HTML rendered.");

    webviewView.onDidDispose(() => {
      this.log("Webview disposed.");
      this.stopActiveProcess();
    });
    webviewView.webview.onDidReceiveMessage(async (message) => {
      try {
        const messageType = message && typeof message.type === "string" ? message.type : "<unknown>";
        this.log(`Received message: ${messageType}`);
        switch (message.type) {
          case "clientBoot":
            this.log(`Client boot: ${safeJson(message.payload || {})}`);
            break;
          case "clientError":
            this.log(`Client error: ${safeJson(message.payload || {})}`);
            this.post("error", {
              message: `Webview error: ${(message.payload && message.payload.message) || "unknown"}`
            });
            break;
          case "init":
            await this.handleInit();
            break;
          case "savePrefs":
            await this.savePrefs(message.payload || {});
            break;
          case "refreshVcpState":
            await this.refreshVcpState(message.payload || {});
            break;
          case "createVcpTopic":
            await this.createVcpTopic(message.payload || {});
            break;
          case "clearApiKey":
            await this.clearApiKey();
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
            await this.openRepl(message.payload || {});
            break;
          case "quickStart":
            await this.quickStart(message.payload || {});
            break;
          case "viewFile":
            await this.viewFile();
            break;
          default:
            this.log(`Unhandled message: ${messageType}`);
            break;
        }
      } catch (error) {
        this.log(`Message handler failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
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
    const prefs = await this.readConnectionPrefs();
    const modelPrefs = this.readModelPrefs();
    const workspaceRoot = getWorkspaceRoot();
    const vcpState = await this.getVcpState(workspaceRoot, prefs);
    const initialMessages = prefs.connectionMode === "vcp-agent" && Array.isArray(vcpState.history)
      ? vcpState.history
      : active.messages;
    this.post("init", {
      model: modelPrefs.model,
      modelSlot: modelPrefs.modelSlot,
      modelMappings: modelPrefs.modelMappings,
      showAdvancedModelSettings: modelPrefs.showAdvancedModelSettings,
      maxTokens: this.context.workspaceState.get(PREF_KEYS.maxTokens, 1024),
      includeEditorContext: this.context.workspaceState.get(PREF_KEYS.includeEditorContext, true),
      connectionMode: prefs.connectionMode,
      provider: prefs.provider,
      baseUrl: prefs.baseUrl,
      hasApiKey: prefs.hasApiKey,
      vcpAgentId: prefs.vcpAgentId,
      vcpTopicId: prefs.vcpTopicId,
      vcpState,
      sessions: toSessionMetaList(store.sessions),
      activeSessionId: active.id,
      session: initialMessages
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
      await this.context.workspaceState.update(PREF_KEYS.model, String(payload.model || ""));
    }
    if (Object.prototype.hasOwnProperty.call(payload, "modelSlot")) {
      await this.context.workspaceState.update(PREF_KEYS.modelSlot, normalizeModelSlot(payload.modelSlot));
    }
    if (Object.prototype.hasOwnProperty.call(payload, "modelMappings")) {
      await this.context.workspaceState.update(PREF_KEYS.modelMappings, sanitizeModelMappings(payload.modelMappings));
    }
    if (Object.prototype.hasOwnProperty.call(payload, "showAdvancedModelSettings")) {
      await this.context.workspaceState.update(
        PREF_KEYS.showAdvancedModelSettings,
        Boolean(payload.showAdvancedModelSettings)
      );
    }
    if (Object.prototype.hasOwnProperty.call(payload, "maxTokens")) {
      const parsed = Number(payload.maxTokens);
      if (Number.isFinite(parsed) && parsed > 0) {
        await this.context.workspaceState.update(PREF_KEYS.maxTokens, Math.floor(parsed));
      }
    }
    if (Object.prototype.hasOwnProperty.call(payload, "includeEditorContext")) {
      await this.context.workspaceState.update(PREF_KEYS.includeEditorContext, Boolean(payload.includeEditorContext));
    }
    if (Object.prototype.hasOwnProperty.call(payload, "connectionMode")) {
      await this.context.workspaceState.update(
        PREF_KEYS.connectionMode,
        normalizeConnectionMode(payload.connectionMode)
      );
    }
    if (Object.prototype.hasOwnProperty.call(payload, "provider")) {
      await this.context.workspaceState.update(
        PREF_KEYS.provider,
        normalizeProvider(payload.provider)
      );
    }
    if (Object.prototype.hasOwnProperty.call(payload, "baseUrl")) {
      await this.context.workspaceState.update(PREF_KEYS.baseUrl, String(payload.baseUrl || "").trim());
    }
    if (Object.prototype.hasOwnProperty.call(payload, "vcpAgentId")) {
      await this.context.workspaceState.update(PREF_KEYS.vcpAgentId, String(payload.vcpAgentId || "").trim());
    }
    if (Object.prototype.hasOwnProperty.call(payload, "vcpTopicId")) {
      await this.context.workspaceState.update(PREF_KEYS.vcpTopicId, String(payload.vcpTopicId || "").trim());
    }
    if (Object.prototype.hasOwnProperty.call(payload, "apiKey")) {
      const apiKey = String(payload.apiKey || "").trim();
      if (apiKey) {
        await this.context.secrets.store(SECRET_KEYS.apiKey, apiKey);
      }
    }
    const workspaceRoot = getWorkspaceRoot();
    this.post("prefsState", {
      ...(await this.readConnectionPrefs()),
      ...this.readModelPrefs(),
      vcpState: await this.getVcpState(workspaceRoot, await this.readConnectionPrefs())
    });
  }

  async clearApiKey() {
    await this.context.secrets.delete(SECRET_KEYS.apiKey);
    this.post("prefsState", {
      ...(await this.readConnectionPrefs()),
      ...this.readModelPrefs()
    });
  }

  async readConnectionPrefs() {
    const apiKey = await this.context.secrets.get(SECRET_KEYS.apiKey);
    return {
      connectionMode: normalizeConnectionMode(this.context.workspaceState.get(PREF_KEYS.connectionMode, "cc-switch")),
      provider: normalizeProvider(this.context.workspaceState.get(PREF_KEYS.provider, "anthropic")),
      baseUrl: String(this.context.workspaceState.get(PREF_KEYS.baseUrl, "") || "").trim(),
      vcpAgentId: String(this.context.workspaceState.get(PREF_KEYS.vcpAgentId, "") || "").trim(),
      vcpTopicId: String(this.context.workspaceState.get(PREF_KEYS.vcpTopicId, "") || "").trim(),
      apiKey: apiKey || "",
      hasApiKey: Boolean(apiKey)
    };
  }

  readModelPrefs() {
    return {
      model: String(this.context.workspaceState.get(PREF_KEYS.model, "") || "").trim(),
      modelSlot: normalizeModelSlot(this.context.workspaceState.get(PREF_KEYS.modelSlot, "auto")),
      modelMappings: sanitizeModelMappings(this.context.workspaceState.get(PREF_KEYS.modelMappings, {})),
      showAdvancedModelSettings: Boolean(
        this.context.workspaceState.get(PREF_KEYS.showAdvancedModelSettings, false)
      )
    };
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
    const maxTokens = clampPositiveInteger(message.maxTokens, 1024, 128, 8192);
    const connectionPrefs = await this.resolveConnectionPrefs(message);
    if (connectionPrefs.connectionMode === "vcp-agent") {
      await this.runVcpAgentTurn({
        workspaceRoot,
        history,
        input,
        editorContext,
        includeEditorContext,
        connectionPrefs
      });
      return;
    }
    const composedPrompt = buildComposedPrompt(history, input, editorContext);
    const modelPrefs = resolveModelPrefsPayload(message, connectionPrefs.provider);
    const resolvedRole = resolveEffectiveRole(modelPrefs.modelSlot, input, editorContext);
    const model = resolveRequestedModel({ ...modelPrefs, modelSlot: resolvedRole }, connectionPrefs.provider);
    if (connectionPrefs.connectionMode === "manual") {
      await this.runDirectApiTurn(composedPrompt, model, maxTokens, connectionPrefs, {
        ...modelPrefs,
        resolvedRole
      });
      return;
    }

    const scriptPath = path.join(workspaceRoot, "rust", "run-with-cc-switch.ps1");
    if (!pathExists(scriptPath)) {
      throw new Error(`Missing script: ${scriptPath}`);
    }
    const args = [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
      "-Prompt", composedPrompt, "-MaxOutputTokens", String(maxTokens)
    ];
    if (model) {
      args.push("-Model", model);
    }
    appendRunnerConnectionArgs(args, connectionPrefs);

    const child = spawn("powershell.exe", args, {
      cwd: workspaceRoot,
      windowsHide: true,
      env: withHomeEnv(process.env)
    });
    const run = { child, cancelled: false, finished: false };
    this.activeRun = run;
    this.post("runStart", {
      model: model || "(default)",
      maxTokens,
      connectionMode: connectionPrefs.connectionMode,
      provider: connectionPrefs.provider,
      modelSlot: modelPrefs.modelSlot,
      resolvedRole
    });

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

  async quickStart(payload = {}) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error("Open the claw-code workspace first.");
    }
    const rustDir = path.join(workspaceRoot, "rust");
    const scriptPath = path.join(rustDir, "run-with-cc-switch.ps1");

    const logs = [];
    logs.push("Quick Start: checking workspace...");
    logs.push(`Workspace: ${workspaceRoot}`);
    const connectionPrefs = await this.resolveConnectionPrefs(payload);
    if (connectionPrefs.connectionMode === "vcp-agent") {
      const vcpState = await this.getVcpState(workspaceRoot, connectionPrefs);
      if (!vcpState.available) {
        throw new Error(vcpState.error || "VCPChat was not found.");
      }
      logs.push("VCP Agent mode enabled.");
      logs.push(`VCP root: ${vcpState.vcpRoot}`);
      logs.push(`VCP server: ${vcpState.vcpUrl || "(missing)"}`);
      logs.push(`VCP API key: ${vcpState.hasApiKey ? "present" : "missing"}`);
      logs.push(`Agent: ${vcpState.selectedAgentName || vcpState.selectedAgentId || "(none)"}`);
      logs.push(`Topic: ${vcpState.selectedTopicName || vcpState.selectedTopicId || "(none)"}`);
      if (vcpState.agentModel) {
        logs.push(`Agent model: ${vcpState.agentModel}`);
      }
      this.post("utilityResult", {
        command: "quick-start",
        code: vcpState.hasApiKey && vcpState.vcpUrl && vcpState.selectedAgentId ? 0 : 1,
        stdout: logs.join("\n"),
        stderr: vcpState.warning || ""
      });
      return;
    }
    const modelPrefs = resolveModelPrefsPayload(payload, connectionPrefs.provider);
    const resolvedRole = modelPrefs.modelSlot === "auto" ? "main" : modelPrefs.modelSlot;
    const model = resolveRequestedModel({ ...modelPrefs, modelSlot: resolvedRole }, connectionPrefs.provider);
    logs.push(`Connection: ${describeConnection(connectionPrefs)}`);
    logs.push(`Role: ${modelPrefs.modelSlot}`);
    if (modelPrefs.modelSlot === "auto") {
      logs.push(`Auto fallback role preview: ${resolvedRole}`);
    }
    logs.push(`Resolved model: ${model}`);

    if (connectionPrefs.connectionMode === "manual") {
      logs.push("Direct API mode does not require CC switch.");
      logs.push("API key: present");
      logs.push(`Provider: ${connectionPrefs.provider}`);
      logs.push(`Base URL: ${connectionPrefs.baseUrl || "(provider default)"}`);
      this.post("utilityResult", {
        command: "quick-start",
        code: 0,
        stdout: logs.join("\n"),
        stderr: ""
      });
      return;
    }

    if (!pathExists(scriptPath)) {
      throw new Error(`Missing script: ${scriptPath}`);
    }
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

  async openRepl(payload = {}) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error("Open the claw-code workspace first.");
    }
    const connectionPrefs = await this.resolveConnectionPrefs(payload);
    if (connectionPrefs.connectionMode === "manual" || connectionPrefs.connectionMode === "vcp-agent") {
      throw new Error("REPL currently works only with the local Claw runtime / CC switch mode.");
    }
    const scriptPath = path.join(workspaceRoot, "rust", "run-with-cc-switch.ps1");
    if (!pathExists(scriptPath)) {
      throw new Error(`Missing script: ${scriptPath}`);
    }
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Repl"];
    appendRunnerConnectionArgs(args, connectionPrefs);
    const terminal = vscode.window.createTerminal({
      name: `Claw REPL (${describeConnection(connectionPrefs)})`,
      cwd: workspaceRoot
    });
    terminal.show(true);
    terminal.sendText(`powershell ${args.map(quotePowerShellArg).join(" ")}`, true);
    this.post("utilityResult", { command: "repl", code: 0, stdout: "Opened Claw REPL in integrated terminal.", stderr: "" });
  }

  async resolveConnectionPrefs(payload = {}) {
    const stored = await this.readConnectionPrefs();
    const connectionMode = normalizeConnectionMode(
      Object.prototype.hasOwnProperty.call(payload, "connectionMode") ? payload.connectionMode : stored.connectionMode
    );
    const provider = normalizeProvider(
      Object.prototype.hasOwnProperty.call(payload, "provider") ? payload.provider : stored.provider
    );
    const baseUrl = String(
      Object.prototype.hasOwnProperty.call(payload, "baseUrl") ? payload.baseUrl : stored.baseUrl
    ).trim();
    const apiKey = String(
      Object.prototype.hasOwnProperty.call(payload, "apiKey") && String(payload.apiKey || "").trim()
        ? payload.apiKey
        : stored.apiKey
    ).trim();
    if (connectionMode !== "cc-switch" && !apiKey) {
      if (connectionMode === "manual") {
        throw new Error("Manual API mode requires an API Key. Enter one in the sidebar first.");
      }
    }
    return {
      connectionMode,
      provider,
      baseUrl,
      vcpAgentId: String(payload.vcpAgentId || stored.vcpAgentId || "").trim(),
      vcpTopicId: String(payload.vcpTopicId || stored.vcpTopicId || "").trim(),
      apiKey,
      hasApiKey: Boolean(apiKey)
    };
  }

  async refreshVcpState(payload = {}) {
    try {
      const workspaceRoot = getWorkspaceRoot();
      const prefs = await this.resolveConnectionPrefs(payload);
      const vcpState = await this.getVcpState(workspaceRoot, prefs);
      this.post("vcpState", vcpState);
      if (prefs.connectionMode === "vcp-agent" && Array.isArray(vcpState.history)) {
        this.post("vcpHistoryLoaded", {
          session: vcpState.history,
          topicId: vcpState.selectedTopicId,
          topicName: vcpState.selectedTopicName || vcpState.selectedTopicId
        });
      }
    } catch (error) {
      this.post("error", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  async createVcpTopic(payload = {}) {
    try {
      const workspaceRoot = getWorkspaceRoot();
      const prefs = await this.resolveConnectionPrefs(payload);
      const env = getVcpEnvironment(workspaceRoot);
      const topic = await createVcpTopic(env, prefs.vcpAgentId, String(payload.topicName || "").trim());
      await this.context.workspaceState.update(PREF_KEYS.vcpTopicId, topic.id);
      const nextPrefs = { ...prefs, vcpTopicId: topic.id };
      const vcpState = await this.getVcpState(workspaceRoot, nextPrefs);
      this.post("vcpState", vcpState);
      this.post("vcpHistoryLoaded", {
        session: [],
        topicId: topic.id,
        topicName: topic.name
      });
    } catch (error) {
      this.post("error", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  async getVcpState(workspaceRoot, prefs) {
    try {
      const env = getVcpEnvironment(workspaceRoot);
      const state = loadVcpSidebarState(env, prefs);
      return state;
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? error.message : String(error),
        agents: [],
        topics: [],
        history: []
      };
    }
  }

  async runVcpAgentTurn({ workspaceRoot, input, editorContext, connectionPrefs }) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const run = {
      cancelled: false,
      finished: false,
      cancel: () => {
        if (controller) {
          controller.abort();
        }
      }
    };
    this.activeRun = run;

    try {
      const env = getVcpEnvironment(workspaceRoot);
      const state = loadVcpSidebarState(env, connectionPrefs);
      if (!state.available) {
        throw new Error(state.error || "VCPChat is unavailable.");
      }
      if (!state.selectedAgentId) {
        throw new Error("Choose a VCP Agent first.");
      }
      if (!state.selectedTopicId) {
        throw new Error("Choose or create a VCP Topic first.");
      }

      const userContent = composeVcpUserContent(input, editorContext);
      const history = Array.isArray(state.history) ? [...state.history] : [];
      const userMessage = createHistoryEntry("user", userContent);
      history.push(userMessage);
      saveVcpHistory(env, state.selectedAgentId, state.selectedTopicId, history);

      this.post("runStart", {
        model: state.agentModel || "(VCP agent default)",
        maxTokens: state.maxOutputTokens || 0,
        connectionMode: "vcp-agent",
        provider: "vcp",
        modelSlot: "vcp-agent",
        resolvedRole: "memory"
      });

      const assistantText = await executeVcpAgentPrompt({
        state,
        history,
        signal: controller ? controller.signal : undefined
      });
      if (run.cancelled || run.finished) {
        return;
      }
      run.finished = true;
      const assistantMessage = createHistoryEntry("assistant", assistantText);
      history.push(assistantMessage);
      saveVcpHistory(env, state.selectedAgentId, state.selectedTopicId, history);
      this.post("runChunk", { text: assistantText });
      this.post("runEnd", { code: 0, stdout: assistantText, stderr: "" });
      this.post("vcpState", loadVcpSidebarState(env, connectionPrefs));
    } catch (error) {
      if (run.cancelled || run.finished) {
        return;
      }
      run.finished = true;
      const message = error instanceof Error ? error.message : String(error);
      this.post("runEnd", { code: 1, stdout: "", stderr: message });
    } finally {
      if (this.activeRun === run) {
        this.activeRun = null;
      }
    }
  }

  async runDirectApiTurn(prompt, model, maxTokens, connectionPrefs, modelPrefs) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const run = {
      cancelled: false,
      finished: false,
      cancel: () => {
        if (controller) {
          controller.abort();
        }
      }
    };
    this.activeRun = run;
    const activeModel = model || defaultModelForProvider(connectionPrefs.provider);
    this.post("runStart", {
      model: activeModel,
      maxTokens,
      connectionMode: connectionPrefs.connectionMode,
      provider: connectionPrefs.provider,
      modelSlot: modelPrefs.modelSlot,
      resolvedRole: modelPrefs.resolvedRole || modelPrefs.modelSlot
    });

    try {
      const text = await executeDirectApiPrompt({
        provider: connectionPrefs.provider,
        apiKey: connectionPrefs.apiKey,
        baseUrl: connectionPrefs.baseUrl,
        model: activeModel,
        maxTokens,
        prompt,
        signal: controller ? controller.signal : undefined
      });
      if (run.cancelled || run.finished) {
        return;
      }
      run.finished = true;
      this.post("runChunk", { text });
      this.post("runEnd", { code: 0, stdout: text, stderr: "" });
    } catch (error) {
      if (run.cancelled || run.finished) {
        return;
      }
      run.finished = true;
      const message = error instanceof Error ? error.message : String(error);
      this.post("runEnd", { code: 1, stdout: "", stderr: message });
    } finally {
      if (this.activeRun === run) {
        this.activeRun = null;
      }
    }
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
      if (typeof this.activeRun.cancel === "function") {
        this.activeRun.cancel();
      } else if (this.activeRun.child) {
        this.activeRun.child.kill();
      }
    } catch (_) {
      // best effort
    }
    this.post("runCancelled", { message: "Request cancelled." });
  }

  post(type, payload) {
    if (this.view) {
      try {
        this.view.webview.postMessage({ type, payload });
      } catch (error) {
        this.log(`Post failed (${type}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  log(message) {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }
}

function buildWebviewHtml(nonce, cspSource) {
  return String.raw`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https: data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
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
    .controls { display: grid; grid-template-columns: 140px 1fr 88px; gap: 6px; }
    .duo { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .mapping-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .field { display: grid; gap: 4px; }
    .field.full { grid-column: 1 / -1; }
    .field-label { font-size: 11px; color: var(--muted); }
    .section { border: 1px solid var(--border); border-radius: 10px; padding: 8px; display: grid; gap: 8px; background: color-mix(in srgb, var(--panel) 84%, transparent); }
    .section-title { font-weight: 600; }
    .secret-row { display: grid; grid-template-columns: 1fr auto; gap: 6px; }
    .subtle { color: var(--muted); font-size: 11px; }
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
    <div class="title">Claw Code Sidebar v0.1.11</div>
    <div class="session-row">
      <select id="sessionSelect"></select>
      <button id="sessionNew" class="secondary" title="New session">+</button>
      <button id="sessionDelete" class="secondary" title="Delete session">-</button>
    </div>
    <div class="controls">
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
    <label class="mini"><input id="showAdvancedModelSettings" type="checkbox" />Show advanced model settings</label>
    <div id="advancedModelSection" class="section" style="display:none;">
      <div class="section-title">Role Model Mapping</div>
      <div class="subtle">Map each orchestration role to a model. Leave a field empty to use the provider-specific default.</div>
      <div class="mapping-grid">
        <label class="field">
          <span class="field-label">Main</span>
          <input id="mapMain" type="text" placeholder="" />
        </label>
        <label class="field">
          <span class="field-label">Thinking</span>
          <input id="mapThinking" type="text" placeholder="" />
        </label>
        <label class="field">
          <span class="field-label">Explore</span>
          <input id="mapExplore" type="text" placeholder="" />
        </label>
        <label class="field">
          <span class="field-label">Plan</span>
          <input id="mapPlan" type="text" placeholder="" />
        </label>
        <label class="field">
          <span class="field-label">Verify</span>
          <input id="mapVerify" type="text" placeholder="" />
        </label>
        <label class="field">
          <span class="field-label">Fast</span>
          <input id="mapFast" type="text" placeholder="" />
        </label>
      </div>
    </div>
    <div id="modelHint" class="subtle"></div>
    <div class="duo">
      <select id="connectionMode">
        <option value="cc-switch">CC switch</option>
        <option value="manual">Direct API</option>
        <option value="vcp-agent">VCP Agent Memory</option>
      </select>
      <select id="provider">
        <option value="anthropic">Anthropic</option>
        <option value="openai">OpenAI / OpenAI-compatible</option>
        <option value="xai">xAI</option>
      </select>
    </div>
    <input id="baseUrl" type="text" placeholder="Base URL (optional: leave empty for provider default)" />
    <div class="secret-row">
      <input id="apiKey" type="password" placeholder="API Key" />
      <button id="clearKeyBtn" class="secondary" title="Clear saved API key">Clear Key</button>
    </div>
    <div id="connectionHint" class="subtle"></div>
    <div id="vcpSection" class="section" style="display:none;">
      <div class="section-title">VCP Memory Binding</div>
      <div class="subtle">Bind this sidebar to a VCP Agent and Topic so memory lives inside VCPChat.</div>
      <div class="duo">
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
        <button id="refreshVcpBtn" class="secondary">Refresh VCP</button>
        <button id="newTopicBtn" class="secondary">New Topic</button>
      </div>
      <div id="vcpHint" class="subtle"></div>
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
    (function () {
      window.__clawVsCodeApi = window.__clawVsCodeApi || acquireVsCodeApi();
      const vscode = window.__clawVsCodeApi;
      const reportBoot = (phase, extra) => {
        try {
          vscode.postMessage({ type: "clientBoot", payload: { phase, ...(extra || {}) } });
        } catch (_) {
          // best effort
        }
      };
      const get = (id) => document.getElementById(id);
      const text = (id) => {
        const el = get(id);
        return el && typeof el.value === "string" ? el.value.trim() : "";
      };
      const num = (id, fallback) => {
        const n = Number(text(id));
        return Number.isFinite(n) && n > 0 ? n : fallback;
      };
      const bool = (id) => {
        const el = get(id);
        return Boolean(el && el.checked);
      };
      const status = (label, kind) => {
        const state = get("statusRunState");
        const dot = get("statusIndicator");
        if (state) state.textContent = label;
        if (dot) dot.className = "status-dot " + (kind || "idle");
      };
      const commonPayload = () => ({
        modelSlot: text("modelSlot"),
        model: text("model"),
        maxTokens: num("maxTokens", 1024),
        includeEditorContext: bool("includeEditor"),
        connectionMode: text("connectionMode"),
        provider: text("provider"),
        baseUrl: text("baseUrl"),
        apiKey: text("apiKey"),
        vcpAgentId: text("vcpAgent"),
        vcpTopicId: text("vcpTopic")
      });
      const bind = (id, type, payloadBuilder, asPayload = false) => {
        const el = get(id);
        if (!el) return;
        el.addEventListener("click", () => {
          if (window.__clawMainReady) return;
          const payload = payloadBuilder ? payloadBuilder() : undefined;
          if (payload === null) return;
          status("Fallback: " + type, "running");
          if (asPayload && payload && typeof payload === "object" && !Array.isArray(payload)) {
            vscode.postMessage({ type, payload });
            return;
          }
          vscode.postMessage({ type, ...(payload || {}) });
        });
      };

      bind("viewFileBtn", "viewFile");
      bind("quickStartBtn", "quickStart", () => commonPayload(), true);
      bind("doctorBtn", "runDoctor");
      bind("statusBtn", "runStatus");
      bind("stopBtn", "stop");
      bind("sendBtn", "ask", () => {
        const input = text("input");
        if (!input) {
          status("Fallback: input is empty", "error");
          return null;
        }
        return {
          input,
          history: [],
          ...commonPayload()
        };
      });
      status("Booting UI...", "idle");
      reportBoot("fallback-ready");
    })();
  </script>

  <script nonce="${nonce}">
    window.__clawMainReady = false;
    window.__clawVsCodeApi = window.__clawVsCodeApi || acquireVsCodeApi();
    const vscode = window.__clawVsCodeApi;
    const reportBoot = (phase, extra) => {
      try {
        vscode.postMessage({ type: "clientBoot", payload: { phase, ...(extra || {}) } });
      } catch (_) {
        // best effort
      }
    };
    window.addEventListener("error", (event) => {
      const payload = {
        message: String(event.message || event.error || "unknown error"),
        source: String(event.filename || ""),
        line: Number(event.lineno || 0),
        col: Number(event.colno || 0)
      };
      reportBoot("window-error", payload);
      try {
        vscode.postMessage({ type: "clientError", payload });
      } catch (_) {
        // best effort
      }
    });
    window.addEventListener("unhandledrejection", (event) => {
      const reason = event && Object.prototype.hasOwnProperty.call(event, "reason") ? event.reason : "";
      const message = typeof reason === "string"
        ? reason
        : (reason && typeof reason.message === "string" ? reason.message : String(reason || "unhandled rejection"));
      reportBoot("unhandled-rejection", { message });
      try {
        vscode.postMessage({ type: "clientError", payload: { message } });
      } catch (_) {
        // best effort
      }
    });
    reportBoot("main-script-start");
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
      statusIndicator: document.getElementById("statusIndicator"),
      statusRunState: document.getElementById("statusRunState"),
      modelSlot: document.getElementById("modelSlot"),
      model: document.getElementById("model"),
      maxTokens: document.getElementById("maxTokens"),
      showAdvancedModelSettings: document.getElementById("showAdvancedModelSettings"),
      advancedModelSection: document.getElementById("advancedModelSection"),
      mapMain: document.getElementById("mapMain"),
      mapThinking: document.getElementById("mapThinking"),
      mapExplore: document.getElementById("mapExplore"),
      mapPlan: document.getElementById("mapPlan"),
      mapVerify: document.getElementById("mapVerify"),
      mapFast: document.getElementById("mapFast"),
      modelHint: document.getElementById("modelHint"),
      connectionMode: document.getElementById("connectionMode"),
      provider: document.getElementById("provider"),
      baseUrl: document.getElementById("baseUrl"),
      apiKey: document.getElementById("apiKey"),
      clearKey: document.getElementById("clearKeyBtn"),
      connectionHint: document.getElementById("connectionHint"),
      includeEditor: document.getElementById("includeEditor"),
      sessionSelect: document.getElementById("sessionSelect"),
      sessionNew: document.getElementById("sessionNew"),
      sessionDelete: document.getElementById("sessionDelete"),
      vcpSection: document.getElementById("vcpSection"),
      vcpAgent: document.getElementById("vcpAgent"),
      vcpTopic: document.getElementById("vcpTopic"),
      refreshVcp: document.getElementById("refreshVcpBtn"),
      newTopic: document.getElementById("newTopicBtn"),
      vcpHint: document.getElementById("vcpHint")
    };

    const state = {
      sessions: [],
      activeSessionId: "",
      messages: [],
      running: false,
      assistantMessageIndex: -1,
      hasApiKey: false,
      showAdvancedModelSettings: false,
      vcpState: { available: false, agents: [], topics: [], history: [] }
    };
    const MODEL_SLOTS = ["main", "thinking", "explore", "plan", "verify", "fast"];
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
        return '<option value="' + escapeHtml(s.id) + '"' + selected + ">" + escapeHtml(s.title || "New Chat") + "</option>";
      }).join("");
      el.sessionSelect.innerHTML = html;
      const vcpMode = el.connectionMode.value === "vcp-agent";
      el.sessionSelect.disabled = state.running || state.sessions.length === 0 || vcpMode;
      el.sessionNew.disabled = state.running || vcpMode;
      el.sessionDelete.disabled = state.running || state.sessions.length === 0 || vcpMode;
    }

    function setStatusLabel(text, kind) {
      if (el.statusRunState) {
        el.statusRunState.textContent = text;
      }
      if (el.statusIndicator) {
        el.statusIndicator.className = "status-dot " + (kind || "idle");
      }
    }

    function renderVcpOptions() {
      const agents = Array.isArray(state.vcpState.agents) ? state.vcpState.agents : [];
      const topics = Array.isArray(state.vcpState.topics) ? state.vcpState.topics : [];
      el.vcpAgent.innerHTML = agents.length
        ? agents.map((item) => {
            const selected = item.id === state.vcpState.selectedAgentId ? " selected" : "";
            return '<option value="' + escapeHtml(item.id) + '"' + selected + ">" + escapeHtml(item.name || item.id) + "</option>";
          }).join("")
        : '<option value="">No VCP Agents found</option>';
      el.vcpTopic.innerHTML = topics.length
        ? topics.map((item) => {
            const selected = item.id === state.vcpState.selectedTopicId ? " selected" : "";
            return '<option value="' + escapeHtml(item.id) + '"' + selected + ">" + escapeHtml(item.name || item.id) + "</option>";
          }).join("")
        : '<option value="">No Topics found</option>';
    }

    function render(scroll = true) {
      el.chat.innerHTML = state.messages.map((m) => {
        const who = m.role === "user" ? "You" : (m.role === "assistant" ? "Claw" : "System");
        return '<div class="msg ' + m.role + '"><span class="label">' + who + "</span><div>" + renderMessageHtml(m) + "</div></div>";
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
      el.modelSlot.disabled = running;
      el.model.disabled = running;
      el.maxTokens.disabled = running;
      el.showAdvancedModelSettings.disabled = running;
      el.connectionMode.disabled = running;
      el.includeEditor.disabled = running;
      el.stop.disabled = !running;
      setStatusLabel(running ? "Running" : "Idle", running ? "running" : "idle");
      updateConnectionUi();
      updateModelUi();
      updateAdvancedModelUi();
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
      setStatusLabel("Sending request...", "running");
      savePrefs();
      vscode.postMessage({
        type: "ask",
        input,
        history: state.messages.slice(0, -1),
        modelSlot: el.modelSlot.value,
        model: el.model.value.trim(),
        modelMappings: getModelMappings(),
        maxTokens: Number(el.maxTokens.value || 1024),
        includeEditorContext: el.includeEditor.checked,
        connectionMode: el.connectionMode.value,
        provider: el.provider.value,
        baseUrl: el.baseUrl.value.trim(),
        apiKey: el.apiKey.value.trim(),
        vcpAgentId: el.vcpAgent.value,
        vcpTopicId: el.vcpTopic.value
      });
    }

    function savePrefs() {
      vscode.postMessage({
        type: "savePrefs",
        payload: {
          modelSlot: el.modelSlot.value,
          model: el.model.value,
          modelMappings: getModelMappings(),
          showAdvancedModelSettings: el.showAdvancedModelSettings.checked,
          maxTokens: Number(el.maxTokens.value || 1024),
          includeEditorContext: el.includeEditor.checked,
          connectionMode: el.connectionMode.value,
          provider: el.provider.value,
          baseUrl: el.baseUrl.value.trim(),
          apiKey: el.apiKey.value.trim(),
          vcpAgentId: el.vcpAgent.value,
          vcpTopicId: el.vcpTopic.value
        }
      });
    }

    function updateConnectionUi() {
      const manual = el.connectionMode.value === "manual";
      const vcpMode = el.connectionMode.value === "vcp-agent";
      el.provider.disabled = state.running || !manual;
      el.baseUrl.disabled = state.running || !manual;
      el.apiKey.disabled = state.running || !manual;
      el.clearKey.disabled = state.running || !manual || !state.hasApiKey;
      el.vcpSection.style.display = vcpMode ? "grid" : "none";
      el.vcpAgent.disabled = state.running || !vcpMode || !state.vcpState.available;
      el.vcpTopic.disabled = state.running || !vcpMode || !state.vcpState.available;
      el.refreshVcp.disabled = state.running || !vcpMode;
      el.newTopic.disabled = state.running || !vcpMode || !el.vcpAgent.value;
      if (vcpMode) {
        el.connectionHint.textContent = "VCP Agent mode: memory is stored in VCPChat under the selected Agent and Topic.";
        el.apiKey.placeholder = "VCP uses the key saved in VCPChat";
        const warning = state.vcpState.warning ? " " + state.vcpState.warning : "";
        el.vcpHint.textContent =
          "Root: " + (state.vcpState.vcpRoot || "Not found") +
          " | Agent: " + (state.vcpState.selectedAgentName || state.vcpState.selectedAgentId || "None") +
          " | Topic: " + (state.vcpState.selectedTopicName || state.vcpState.selectedTopicId || "None") +
          warning;
        renderSessionSelect();
        return;
      }
      if (!manual) {
        el.connectionHint.textContent = "Using the active Claude provider from CC switch.";
        el.apiKey.placeholder = "API Key is managed by CC switch";
        return;
      }
      const providerLabel = el.provider.options[el.provider.selectedIndex] ? el.provider.options[el.provider.selectedIndex].text : "provider";
      el.connectionHint.textContent = "Direct API mode: use a saved key plus an optional custom Base URL for " + providerLabel + ".";
      el.apiKey.placeholder = state.hasApiKey
        ? "Saved in VS Code Secret Storage. Enter a new key to replace it."
        : "Enter API Key";
    }

    function getDefaultModelForSlot(provider, slot) {
      if (provider === "openai") {
        if (slot === "thinking") return "o4-mini";
        if (slot === "explore") return "gpt-4.1-mini";
        if (slot === "plan") return "o4-mini";
        if (slot === "verify") return "gpt-4.1";
        if (slot === "fast") return "gpt-4.1-nano";
        return "gpt-4.1-mini";
      }
      if (provider === "xai") {
        if (slot === "thinking") return "grok-3";
        if (slot === "explore") return "grok-3-mini";
        if (slot === "plan") return "grok-3";
        if (slot === "verify") return "grok-3";
        if (slot === "fast") return "grok-3-mini";
        return "grok-3-mini";
      }
      if (slot === "thinking") return "claude-opus-4-6";
      if (slot === "fast") return "claude-haiku-4-5-20251213";
      return "claude-sonnet-4-6";
    }

    function getModelMappings() {
      return {
        main: el.mapMain.value.trim(),
        thinking: el.mapThinking.value.trim(),
        explore: el.mapExplore.value.trim(),
        plan: el.mapPlan.value.trim(),
        verify: el.mapVerify.value.trim(),
        fast: el.mapFast.value.trim()
      };
    }

    function applyModelMappings(mappings) {
      const safe = mappings || {};
      el.mapMain.value = safe.main || "";
      el.mapThinking.value = safe.thinking || "";
      el.mapExplore.value = safe.explore || "";
      el.mapPlan.value = safe.plan || "";
      el.mapVerify.value = safe.verify || "";
      el.mapFast.value = safe.fast || "";
    }

    function getResolvedModel() {
      const provider = el.provider.value || "anthropic";
      const slot = el.modelSlot.value || "main";
      const mappings = getModelMappings();
      if (slot === "auto") {
        return "Auto routes to a role-specific model at send time";
      }
      if (slot === "custom") {
        return el.model.value.trim() || mappings.main || getDefaultModelForSlot(provider, "main");
      }
      return mappings[slot] || getDefaultModelForSlot(provider, slot);
    }

    function updateModelUi() {
      const custom = el.modelSlot.value === "custom";
      el.model.disabled = state.running || !custom;
      el.model.placeholder = custom
        ? "Custom model override"
        : "Switch to Custom if you want to type a one-off model";
      const provider = el.provider.value || "anthropic";
      for (const slot of MODEL_SLOTS) {
        const inputId = "map" + slot.charAt(0).toUpperCase() + slot.slice(1);
        if (el[inputId]) {
          el[inputId].disabled = state.running;
          el[inputId].placeholder = getDefaultModelForSlot(provider, slot);
        }
      }
      const resolved = getResolvedModel();
      const slotLabel = custom ? "custom override" : el.modelSlot.options[el.modelSlot.selectedIndex].text;
      el.modelHint.textContent = el.modelSlot.value === "auto"
        ? "Current role: Auto | Auto routes by task shape into main / thinking / explore / plan / verify / fast"
        : "Current role: " + slotLabel + " | Resolved model: " + resolved;
    }

    function updateAdvancedModelUi() {
      state.showAdvancedModelSettings = Boolean(el.showAdvancedModelSettings.checked);
      el.advancedModelSection.style.display = state.showAdvancedModelSettings ? "grid" : "none";
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
    el.modelSlot.addEventListener("change", () => { updateModelUi(); savePrefs(); });
    el.model.addEventListener("change", savePrefs);
    el.maxTokens.addEventListener("change", savePrefs);
    el.showAdvancedModelSettings.addEventListener("change", () => { updateAdvancedModelUi(); savePrefs(); });
    el.mapMain.addEventListener("change", () => { updateModelUi(); savePrefs(); });
    el.mapThinking.addEventListener("change", () => { updateModelUi(); savePrefs(); });
    el.mapExplore.addEventListener("change", () => { updateModelUi(); savePrefs(); });
    el.mapPlan.addEventListener("change", () => { updateModelUi(); savePrefs(); });
    el.mapVerify.addEventListener("change", () => { updateModelUi(); savePrefs(); });
    el.mapFast.addEventListener("change", () => { updateModelUi(); savePrefs(); });
    el.connectionMode.addEventListener("change", () => {
      updateConnectionUi();
      updateModelUi();
      savePrefs();
      if (el.connectionMode.value === "vcp-agent") {
        vscode.postMessage({
          type: "refreshVcpState",
          payload: {
            connectionMode: el.connectionMode.value,
            vcpAgentId: el.vcpAgent.value,
            vcpTopicId: el.vcpTopic.value
          }
        });
      }
    });
    el.provider.addEventListener("change", () => { updateConnectionUi(); updateModelUi(); savePrefs(); });
    el.baseUrl.addEventListener("change", savePrefs);
    el.apiKey.addEventListener("change", savePrefs);
    el.vcpAgent.addEventListener("change", () => {
      savePrefs();
      vscode.postMessage({
        type: "refreshVcpState",
        payload: {
          connectionMode: el.connectionMode.value,
          vcpAgentId: el.vcpAgent.value,
          vcpTopicId: ""
        }
      });
    });
    el.vcpTopic.addEventListener("change", () => {
      savePrefs();
      vscode.postMessage({
        type: "refreshVcpState",
        payload: {
          connectionMode: el.connectionMode.value,
          vcpAgentId: el.vcpAgent.value,
          vcpTopicId: el.vcpTopic.value
        }
      });
    });
    el.includeEditor.addEventListener("change", savePrefs);
    el.send.addEventListener("click", sendPrompt);
    el.stop.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
    el.clearKey.addEventListener("click", () => {
      el.apiKey.value = "";
      state.hasApiKey = false;
      updateConnectionUi();
      vscode.postMessage({ type: "clearApiKey" });
    });
    el.newBtn.addEventListener("click", () => {
      if (!state.running) {
        persistNow();
        vscode.postMessage({ type: "newChat" });
      }
    });
    el.quickStart.addEventListener("click", () => {
      if (!state.running) {
        setRunning(true);
        savePrefs();
        vscode.postMessage({
          type: "quickStart",
          payload: {
            modelSlot: el.modelSlot.value,
            model: el.model.value.trim(),
            modelMappings: getModelMappings(),
            connectionMode: el.connectionMode.value,
            provider: el.provider.value,
            baseUrl: el.baseUrl.value.trim(),
            apiKey: el.apiKey.value.trim(),
            vcpAgentId: el.vcpAgent.value,
            vcpTopicId: el.vcpTopic.value
          }
        });
      }
    });
    el.viewFile.addEventListener("click", () => {
      if (!state.running) {
        setStatusLabel("Opening file picker...", "running");
        vscode.postMessage({ type: "viewFile" });
      }
    });
    el.refreshVcp.addEventListener("click", () => {
      if (!state.running) {
        setStatusLabel("Refreshing VCP...", "running");
        savePrefs();
        vscode.postMessage({
          type: "refreshVcpState",
          payload: {
            connectionMode: el.connectionMode.value,
            vcpAgentId: el.vcpAgent.value,
            vcpTopicId: el.vcpTopic.value
          }
        });
      }
    });
    el.newTopic.addEventListener("click", () => {
      if (!state.running) {
        const topicName = window.prompt("New VCP topic name", "");
        if (topicName === null) return;
        setStatusLabel("Creating VCP topic...", "running");
        savePrefs();
        vscode.postMessage({
          type: "createVcpTopic",
          payload: {
            connectionMode: el.connectionMode.value,
            vcpAgentId: el.vcpAgent.value,
            topicName
          }
        });
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
    el.doctor.addEventListener("click", () => { if (!state.running) { setStatusLabel("Running doctor...", "running"); setRunning(true); vscode.postMessage({ type: "runDoctor" }); } });
    el.status.addEventListener("click", () => { if (!state.running) { setStatusLabel("Running status...", "running"); setRunning(true); vscode.postMessage({ type: "runStatus" }); } });
    el.repl.addEventListener("click", () => {
      savePrefs();
      setStatusLabel("Opening REPL...", "running");
      vscode.postMessage({
      type: "openRepl",
      payload: {
        modelSlot: el.modelSlot.value,
        model: el.model.value.trim(),
        modelMappings: getModelMappings(),
        connectionMode: el.connectionMode.value,
        provider: el.provider.value,
        baseUrl: el.baseUrl.value.trim(),
        apiKey: el.apiKey.value.trim(),
        vcpAgentId: el.vcpAgent.value,
        vcpTopicId: el.vcpTopic.value
      }
      });
    });

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
        el.modelSlot.value = payload.modelSlot || "auto";
        el.model.value = payload.model || "";
        applyModelMappings(payload.modelMappings);
        el.showAdvancedModelSettings.checked = Boolean(payload.showAdvancedModelSettings);
        state.showAdvancedModelSettings = Boolean(payload.showAdvancedModelSettings);
        el.maxTokens.value = payload.maxTokens || 1024;
        el.includeEditor.checked = Boolean(payload.includeEditorContext);
        el.connectionMode.value = payload.connectionMode || "cc-switch";
        el.provider.value = payload.provider || "anthropic";
        el.baseUrl.value = payload.baseUrl || "";
        state.vcpState = payload.vcpState || state.vcpState;
        renderVcpOptions();
        el.apiKey.value = "";
        state.hasApiKey = Boolean(payload.hasApiKey);
        applySessionState(payload, { skipPersist: true });
        if (state.messages.length === 0) addMessage("system", "Ready. Choose CC switch, Direct API, or VCP Agent Memory above, then start chatting.");
        updateConnectionUi();
        updateModelUi();
        updateAdvancedModelUi();
        setStatusLabel("Ready", "idle");
        setRunning(false);
        return;
      }
      if (msg.type === "prefsState") {
        state.hasApiKey = Boolean(payload.hasApiKey);
        if (payload.modelSlot) el.modelSlot.value = payload.modelSlot;
        if (typeof payload.model === "string") el.model.value = payload.model;
        if (payload.modelMappings) applyModelMappings(payload.modelMappings);
        if (Object.prototype.hasOwnProperty.call(payload, "showAdvancedModelSettings")) {
          el.showAdvancedModelSettings.checked = Boolean(payload.showAdvancedModelSettings);
          state.showAdvancedModelSettings = Boolean(payload.showAdvancedModelSettings);
        }
        if (payload.connectionMode) el.connectionMode.value = payload.connectionMode;
        if (payload.provider) el.provider.value = payload.provider;
        if (typeof payload.baseUrl === "string") el.baseUrl.value = payload.baseUrl;
        if (payload.vcpState) {
          state.vcpState = payload.vcpState;
          renderVcpOptions();
        }
        el.apiKey.value = "";
        updateConnectionUi();
        updateModelUi();
        updateAdvancedModelUi();
        setStatusLabel("Prefs saved", "idle");
        return;
      }
      if (msg.type === "vcpState") {
        state.vcpState = payload || { available: false, agents: [], topics: [], history: [] };
        renderVcpOptions();
        updateConnectionUi();
        setStatusLabel("VCP refreshed", "idle");
        return;
      }
      if (msg.type === "vcpHistoryLoaded") {
        state.messages = normalizeMessages(payload.session);
        state.assistantMessageIndex = -1;
        render();
        schedulePersist();
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
        setStatusLabel("Idle", "idle");
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
        setStatusLabel("Idle", "idle");
        return;
      }
      if (msg.type === "utilityResult") {
        setRunning(false);
        const lines = [];
        if (payload.stdout) lines.push(payload.stdout.trim());
        if (payload.stderr) lines.push(payload.stderr.trim());
        addMessage("system", lines.join("\\n\\n") || (payload.command + " done."));
        setStatusLabel("Idle", "idle");
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
        setStatusLabel("Idle", "idle");
        return;
      }
      if (msg.type === "error") {
        setRunning(false);
        addMessage("system", payload.message || "Unexpected error.");
        setStatusLabel("Error", "error");
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
    window.__clawMainReady = true;
    reportBoot("main-ready");
    vscode.postMessage({ type: "init" });
    setRunning(false);

    function renderMessageHtml(message) {
      const content = String((message && message.content) || "");
      if (message.role === "assistant" || message.role === "system") return '<div class="md">' + renderMarkdown(content) + "</div>";
      return '<div class="plain">' + escapeHtml(content).replace(/\n/g, "<br />") + "</div>";
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
        parts.push('<div class="code"><div class="code-head"><span>' + lang + '</span><button class="copy-btn">Copy</button></div><pre><code>' + code + "</code></pre></div>");
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
        out += '<code class="inline">' + escapeHtml(source.slice(start + 1, end)) + "</code>";
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
          const idx = frozen.push('<span class="' + cls + '">' + s + "</span>") - 1;
          return "@@HL" + idx + "@@";
        });
      };
      freeze(/"(?:[^"\\n\\\\]|\\\\.)*"|'(?:[^'\\n\\\\]|\\\\.)*'/g, "tok-str");
      if (lang === "js" || lang === "ts" || lang === "rust" || lang === "c" || lang === "cpp") {
        freeze(/\/\*[\s\S]*?\*\//g, "tok-com");
        freeze(/\/\/[^\n]*/g, "tok-com");
      } else if (lang === "py" || lang === "sh") {
        freeze(/#[^\\n]*/g, "tok-com");
      }
      text = text.replace(/\b\d+(?:\.\d+)?\b/g, '<span class="tok-num">$&</span>');
      const kw = getKeywords(lang);
      if (kw.length) {
        text = text.replace(new RegExp("\\b(" + kw.join("|") + ")\\b", "g"), '<span class="tok-kw">$1</span>');
      }
      const bi = getBuiltins(lang);
      if (bi.length) {
        text = text.replace(new RegExp("\\b(" + bi.join("|") + ")\\b", "g"), '<span class="tok-bi">$1</span>');
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

function normalizeConnectionMode(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "vcp" || raw === "vcp-agent") {
    return "vcp-agent";
  }
  return raw === "direct" || raw === "manual" ? "manual" : "cc-switch";
}

function normalizeModelSlot(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "haiku") return "fast";
  if (raw === "sonnet") return "main";
  if (raw === "opus") return "thinking";
  return raw === "auto" || raw === "thinking" || raw === "explore" || raw === "plan" || raw === "verify" || raw === "fast" || raw === "custom"
    ? raw
    : "main";
}

function normalizeProvider(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "openai" || raw === "xai") {
    return raw;
  }
  return "anthropic";
}

function sanitizeModelMappings(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    main: String(source.main || source.sonnet || "").trim(),
    thinking: String(source.thinking || source.opus || "").trim(),
    explore: String(source.explore || source.sonnet || source.main || "").trim(),
    plan: String(source.plan || source.sonnet || source.main || "").trim(),
    verify: String(source.verify || source.sonnet || source.main || "").trim(),
    fast: String(source.fast || source.haiku || "").trim()
  };
}

function resolveModelPrefsPayload(payload, provider) {
  const modelSlot = normalizeModelSlot(payload.modelSlot);
  return {
    customModel: String(payload.model || "").trim(),
    modelSlot,
    modelMappings: sanitizeModelMappings(payload.modelMappings || {}),
    provider: normalizeProvider(provider)
  };
}

function resolveRequestedModel(modelPrefs, provider) {
  const normalizedProvider = normalizeProvider(provider);
  if (modelPrefs.modelSlot === "custom") {
    return modelPrefs.customModel || defaultModelForSlot(normalizedProvider, "main");
  }
  return modelPrefs.modelMappings[modelPrefs.modelSlot] || defaultModelForSlot(normalizedProvider, modelPrefs.modelSlot);
}

function resolveEffectiveRole(selectedRole, prompt, editorContext) {
  if (selectedRole !== "auto") {
    return selectedRole;
  }
  const lowered = `${prompt || ""}\n${editorContext || ""}`.toLowerCase();
  if (
    lowered.includes("测试") ||
    lowered.includes("test") ||
    lowered.includes("verify") ||
    lowered.includes("校验") ||
    lowered.includes("review") ||
    lowered.includes("回归")
  ) {
    return "verify";
  }
  if (
    lowered.includes("计划") ||
    lowered.includes("方案") ||
    lowered.includes("设计") ||
    lowered.includes("plan") ||
    lowered.includes("architecture") ||
    lowered.includes("roadmap")
  ) {
    return "plan";
  }
  if (
    lowered.includes("找") ||
    lowered.includes("搜索") ||
    lowered.includes("grep") ||
    lowered.includes("where") ||
    lowered.includes("locate") ||
    lowered.includes("trace") ||
    lowered.includes("explore")
  ) {
    return "explore";
  }
  if (
    lowered.includes("think") ||
    lowered.includes("reason") ||
    lowered.includes("分析") ||
    lowered.includes("推理") ||
    lowered.includes("deep")
  ) {
    return "thinking";
  }
  if (
    lowered.includes("rename") ||
    lowered.includes("format") ||
    lowered.includes("总结") ||
    lowered.includes("summarize") ||
    lowered.includes("quick")
  ) {
    return "fast";
  }
  return "main";
}

function appendRunnerConnectionArgs(args, connectionPrefs) {
  if (!connectionPrefs || connectionPrefs.connectionMode === "cc-switch") {
    return;
  }
  args.push("-ConnectionMode", "manual");
  args.push("-Provider", connectionPrefs.provider);
  if (connectionPrefs.apiKey) {
    args.push("-ApiKey", connectionPrefs.apiKey);
  }
  if (connectionPrefs.baseUrl) {
    args.push("-BaseUrl", connectionPrefs.baseUrl);
  }
}

function describeConnection(connectionPrefs) {
  if (!connectionPrefs || connectionPrefs.connectionMode === "cc-switch") {
    return "cc-switch";
  }
  if (connectionPrefs.connectionMode === "vcp-agent") {
    return "vcp-agent";
  }
  const provider = connectionPrefs.provider || "manual";
  return connectionPrefs.baseUrl ? `${provider} via custom base URL` : provider;
}

function getVcpEnvironment(workspaceRoot) {
  const vcpRoot = findVcpChatRoot(workspaceRoot);
  if (!vcpRoot) {
    throw new Error("VCPChat was not found next to the current workspace.");
  }
  const appDataRoot = path.join(vcpRoot, "AppData");
  return {
    vcpRoot,
    appDataRoot,
    settingsPath: path.join(appDataRoot, "settings.json"),
    agentsDir: path.join(appDataRoot, "Agents"),
    userDataDir: path.join(appDataRoot, "UserData")
  };
}

function findVcpChatRoot(basePath) {
  if (!basePath) {
    return null;
  }

  let current = path.resolve(basePath);
  for (let depth = 0; depth < 8; depth += 1) {
    const direct = path.join(current, "VCPChat");
    if (pathExists(path.join(direct, "AppData", "settings.json"))) {
      return direct;
    }

    if (path.basename(current).toLowerCase() === "vcpchat" && pathExists(path.join(current, "AppData", "settings.json"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return null;
}

function loadVcpSidebarState(env, prefs = {}) {
  if (!pathExists(env.settingsPath)) {
    throw new Error(`Missing VCP settings: ${env.settingsPath}`);
  }
  const settings = readJsonFile(env.settingsPath, {});
  const agents = listVcpAgents(env.agentsDir);
  const selectedAgentId = chooseExistingId(prefs.vcpAgentId, agents.map((item) => item.id));
  const agentConfig = selectedAgentId ? readVcpAgentConfig(env.agentsDir, selectedAgentId) : null;
  const topics = Array.isArray(agentConfig?.topics) ? agentConfig.topics : [];
  const selectedTopicId = chooseExistingId(prefs.vcpTopicId, topics.map((item) => item.id));
  const selectedAgent = agents.find((item) => item.id === selectedAgentId) || null;
  const selectedTopic = topics.find((item) => item.id === selectedTopicId) || null;
  const history = selectedAgentId && selectedTopicId
    ? sanitizeSessionMessages(loadVcpHistory(env, selectedAgentId, selectedTopicId))
    : [];
  return {
    available: true,
    vcpRoot: env.vcpRoot,
    vcpUrl: String(settings.vcpServerUrl || "").trim(),
    hasApiKey: Boolean(String(settings.vcpApiKey || "").trim()),
    selectedAgentId: selectedAgentId || "",
    selectedAgentName: selectedAgent ? selectedAgent.name : "",
    selectedTopicId: selectedTopicId || "",
    selectedTopicName: selectedTopic ? selectedTopic.name : "",
    agentModel: agentConfig && agentConfig.model ? String(agentConfig.model).trim() : "",
    maxOutputTokens: agentConfig && agentConfig.maxOutputTokens ? Number(agentConfig.maxOutputTokens) || 0 : 0,
    agents,
    topics: topics.map((topic) => ({
      id: String(topic.id || ""),
      name: String(topic.name || topic.id || "Untitled Topic")
    })),
    history,
    warning: buildVcpStateWarning(settings, selectedAgentId)
  };
}

function buildVcpStateWarning(settings, selectedAgentId) {
  const warnings = [];
  if (!String(settings.vcpServerUrl || "").trim()) {
    warnings.push("VCP server URL is missing in VCPChat/AppData/settings.json.");
  }
  if (!String(settings.vcpApiKey || "").trim()) {
    warnings.push("VCP API key is missing in VCPChat/AppData/settings.json.");
  }
  if (!selectedAgentId) {
    warnings.push("No VCP Agent is selected.");
  }
  return warnings.join(" ");
}

function listVcpAgents(agentsDir) {
  if (!pathExists(agentsDir)) {
    return [];
  }
  return fs.readdirSync(agentsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const config = readJsonFile(path.join(agentsDir, entry.name, "config.json"), {});
      return {
        id: entry.name,
        name: String(config.name || entry.name)
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function readVcpAgentConfig(agentsDir, agentId) {
  const configPath = path.join(agentsDir, agentId, "config.json");
  if (!pathExists(configPath)) {
    throw new Error(`Missing VCP Agent config: ${configPath}`);
  }
  return readJsonFile(configPath, {});
}

function loadVcpHistory(env, agentId, topicId) {
  const historyPath = path.join(env.userDataDir, agentId, "topics", topicId, "history.json");
  return readJsonFile(historyPath, []);
}

function saveVcpHistory(env, agentId, topicId, history) {
  const historyPath = path.join(env.userDataDir, agentId, "topics", topicId, "history.json");
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.writeFileSync(historyPath, JSON.stringify(sanitizeHistoryEntries(history), null, 2), "utf8");
}

function sanitizeHistoryEntries(history) {
  if (!Array.isArray(history)) {
    return [];
  }
  return history
    .filter((item) => item && typeof item === "object" && (item.role === "user" || item.role === "assistant" || item.role === "system"))
    .map((item) => ({
      role: item.role,
      content: String(item.content || ""),
      timestamp: Number(item.timestamp) || Date.now(),
      id: typeof item.id === "string" && item.id ? item.id : createHistoryId(item.role)
    }));
}

function createHistoryEntry(role, content) {
  return {
    role,
    content: String(content || ""),
    timestamp: Date.now(),
    id: createHistoryId(role)
  };
}

function createHistoryId(role) {
  return `msg_${Date.now()}_${role}_${Math.random().toString(36).slice(2, 8)}`;
}

function chooseExistingId(candidate, values) {
  const list = Array.isArray(values) ? values.filter(Boolean) : [];
  if (candidate && list.includes(candidate)) {
    return candidate;
  }
  return list[0] || "";
}

function composeVcpUserContent(input, editorContext) {
  const parts = [String(input || "").trim()];
  if (editorContext && String(editorContext).trim()) {
    parts.push(["[Editor Context]", editorContext.trim()].join("\n"));
  }
  return parts.filter(Boolean).join("\n\n");
}

async function executeVcpAgentPrompt(options) {
  if (typeof fetch !== "function") {
    throw new Error("This VS Code runtime does not expose fetch(), so VCP Agent mode is unavailable.");
  }
  const { state, history, signal } = options;
  const env = {
    vcpRoot: state.vcpRoot,
    settingsPath: path.join(state.vcpRoot, "AppData", "settings.json"),
    agentsDir: path.join(state.vcpRoot, "AppData", "Agents"),
    userDataDir: path.join(state.vcpRoot, "AppData", "UserData")
  };
  const settings = readJsonFile(env.settingsPath, {});
  const apiKey = String(settings.vcpApiKey || "").trim();
  const baseUrl = String(settings.vcpServerUrl || "").trim();
  if (!baseUrl) {
    throw new Error("VCP server URL is missing in VCPChat/AppData/settings.json.");
  }
  if (!apiKey) {
    throw new Error("VCP API key is missing in VCPChat/AppData/settings.json.");
  }
  const agentConfig = readVcpAgentConfig(env.agentsDir, state.selectedAgentId);
  const systemPrompt = resolveVcpSystemPrompt(agentConfig);
  const modelConfig = buildVcpModelConfig(agentConfig);
  const endpoint = buildVcpEndpoint(baseUrl, settings.enableVcpToolInjection === true);
  const messages = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  for (const item of sanitizeHistoryEntries(history)) {
    messages.push({ role: item.role, content: item.content });
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      messages,
      ...modelConfig,
      stream: false,
      requestId: createHistoryId("vcp")
    }),
    signal
  });

  const raw = await response.text();
  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch (_) {
    payload = null;
  }
  if (!response.ok) {
    const message =
      readNestedString(payload, ["message"]) ||
      readNestedString(payload, ["error", "message"]) ||
      readNestedString(payload, ["error"]) ||
      clampText(raw || "", 400) ||
      `HTTP ${response.status}`;
    throw new Error(`VCP request failed (${response.status}): ${message}`);
  }

  const text = extractVcpResponseText(payload);
  if (!text.trim()) {
    throw new Error("VCP returned an empty response.");
  }
  return text.trim();
}

function buildVcpEndpoint(baseUrl, useToolInjection) {
  const trimmed = String(baseUrl || "").trim();
  const pathname = useToolInjection ? "/v1/chatvcp/completions" : "/v1/chat/completions";
  return normalizeEndpoint(trimmed, pathname);
}

function buildVcpModelConfig(agentConfig) {
  return {
    model: String(agentConfig?.model || "").trim() || "gemini-pro",
    temperature: agentConfig?.temperature !== undefined ? Number(agentConfig.temperature) : 0.7,
    ...(agentConfig?.maxOutputTokens ? { max_tokens: Number(agentConfig.maxOutputTokens) || undefined } : {}),
    ...(agentConfig?.contextTokenLimit !== undefined ? { contextTokenLimit: Number(agentConfig.contextTokenLimit) || undefined } : {}),
    ...(agentConfig?.top_p !== undefined ? { top_p: Number(agentConfig.top_p) || undefined } : {}),
    ...(agentConfig?.top_k !== undefined ? { top_k: Number(agentConfig.top_k) || undefined } : {})
  };
}

function resolveVcpSystemPrompt(agentConfig) {
  const config = agentConfig && typeof agentConfig === "object" ? agentConfig : {};
  const promptMode = String(config.promptMode || "original");
  if (promptMode === "preset") {
    return String(config.presetSystemPrompt || "").trim();
  }
  if (promptMode === "modular") {
    const advanced = config.advancedSystemPrompt;
    if (advanced && typeof advanced === "object" && Array.isArray(advanced.blocks)) {
      return advanced.blocks
        .filter((block) => block && block.disabled !== true)
        .map((block) => {
          if (block.type === "newline") {
            return "\n";
          }
          if (Array.isArray(block.variants) && block.variants.length > 0) {
            const idx = Number.isInteger(block.selectedVariant) ? block.selectedVariant : 0;
            return String(block.variants[idx] || block.content || "");
          }
          return String(block.content || "");
        })
        .join("")
        .trim();
    }
    if (typeof advanced === "string") {
      return advanced.trim();
    }
  }
  return String(config.originalSystemPrompt || config.systemPrompt || "").trim();
}

function extractVcpResponseText(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  const content = choice?.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item.text === "string") return item.text;
      return "";
    }).join("");
  }
  if (typeof payload.content === "string") {
    return payload.content;
  }
  return "";
}

function createVcpTopic(env, agentId, topicName) {
  if (!agentId) {
    throw new Error("Choose a VCP Agent before creating a topic.");
  }
  const configPath = path.join(env.agentsDir, agentId, "config.json");
  const config = readJsonFile(configPath, {});
  const topics = Array.isArray(config.topics) ? [...config.topics] : [];
  const topic = {
    id: `topic_${Date.now()}`,
    name: topicName || `New Topic ${new Date().toLocaleTimeString("en-GB", { hour12: false })}`,
    createdAt: Date.now(),
    locked: true,
    unread: false,
    creatorSource: "claw-sidebar"
  };
  topics.unshift(topic);
  config.topics = topics;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  saveVcpHistory(env, agentId, topic.id, []);
  return topic;
}

function readJsonFile(filePath, fallback) {
  try {
    if (!pathExists(filePath)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function quotePowerShellArg(value) {
  const text = String(value ?? "");
  if (/^[A-Za-z0-9_./:\\-]+$/.test(text)) {
    return text;
  }
  return `'${text.replace(/'/g, "''")}'`;
}

function defaultModelForProvider(provider) {
  return defaultModelForSlot(provider, "main");
}

function defaultModelForSlot(provider, slot) {
  switch (provider) {
    case "openai":
      if (slot === "thinking") return "o4-mini";
      if (slot === "explore") return "gpt-4.1-mini";
      if (slot === "plan") return "o4-mini";
      if (slot === "verify") return "gpt-4.1";
      if (slot === "fast") return "gpt-4.1-nano";
      return "gpt-4.1-mini";
    case "xai":
      if (slot === "thinking") return "grok-3";
      if (slot === "explore") return "grok-3-mini";
      if (slot === "plan") return "grok-3";
      if (slot === "verify") return "grok-3";
      if (slot === "fast") return "grok-3-mini";
      return "grok-3-mini";
    default:
      if (slot === "thinking") return "claude-opus-4-6";
      if (slot === "fast") return "claude-haiku-4-5-20251213";
      return "claude-sonnet-4-6";
  }
}

async function executeDirectApiPrompt(options) {
  if (typeof fetch !== "function") {
    throw new Error("This VS Code runtime does not expose fetch(), so direct API mode is unavailable.");
  }

  const provider = normalizeProvider(options.provider);
  const endpoint = buildDirectApiEndpoint(provider, options.baseUrl);
  const body = buildDirectApiRequestBody(provider, options.model, options.maxTokens, options.prompt);
  const headers = buildDirectApiHeaders(provider, options.apiKey);

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: options.signal
  });

  const raw = await response.text();
  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch (_) {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(formatDirectApiError(provider, response.status, payload, raw));
  }

  const text = extractDirectApiText(provider, payload);
  if (!text.trim()) {
    throw new Error("The provider returned an empty response.");
  }
  return text.trim();
}

function buildDirectApiEndpoint(provider, baseUrl) {
  const trimmed = String(baseUrl || "").trim();
  if (provider === "anthropic") {
    return normalizeEndpoint(trimmed || "https://api.anthropic.com", "/v1/messages");
  }
  if (provider === "xai") {
    return normalizeEndpoint(trimmed || "https://api.x.ai/v1", "/chat/completions");
  }
  return normalizeEndpoint(trimmed || "https://api.openai.com/v1", "/chat/completions");
}

function normalizeEndpoint(baseOrEndpoint, suffix) {
  const trimmed = String(baseOrEndpoint || "").trim().replace(/\/+$/, "");
  if (!trimmed) {
    return suffix;
  }
  const lowered = trimmed.toLowerCase();
  if (lowered.endsWith(suffix.toLowerCase())) {
    return trimmed;
  }
  if (suffix.startsWith("/v1/") && lowered.endsWith("/v1")) {
    return `${trimmed}${suffix.slice(3)}`;
  }
  return `${trimmed}${suffix}`;
}

function buildDirectApiHeaders(provider, apiKey) {
  if (provider === "anthropic") {
    return {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    };
  }
  return {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`
  };
}

function buildDirectApiRequestBody(provider, model, maxTokens, prompt) {
  if (provider === "anthropic") {
    return {
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }]
    };
  }
  return {
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
    stream: false
  };
}

function extractDirectApiText(provider, payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  if (provider === "anthropic") {
    if (!Array.isArray(payload.content)) {
      return "";
    }
    return payload.content
      .filter((item) => item && item.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("");
  }
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  const content = choice && choice.message ? choice.message.content : "";
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item.text === "string") return item.text;
        return "";
      })
      .join("");
  }
  return "";
}

function formatDirectApiError(provider, status, payload, raw) {
  const providerLabel = provider === "xai" ? "xAI" : provider === "openai" ? "OpenAI-compatible" : "Anthropic";
  const message =
    readNestedString(payload, ["error", "message"]) ||
    readNestedString(payload, ["message"]) ||
    clampText(String(raw || "").trim(), 500) ||
    `HTTP ${status}`;
  return `${providerLabel} request failed (${status}): ${message}`;
}

function readNestedString(value, pathParts) {
  let current = value;
  for (const part of pathParts) {
    if (!current || typeof current !== "object" || !(part in current)) {
      return "";
    }
    current = current[part];
  }
  return typeof current === "string" ? current : "";
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

function createNonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
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
  let current = path.resolve(basePath);
  for (let depth = 0; depth < 8; depth += 1) {
    const direct = current;
    const child = path.join(current, "claw-code");

    if (pathExists(path.join(direct, "rust", "run-with-cc-switch.ps1"))) {
      return direct;
    }
    if (pathExists(path.join(child, "rust", "run-with-cc-switch.ps1"))) {
      return child;
    }

    try {
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const candidate = path.join(current, entry.name);
        if (pathExists(path.join(candidate, "rust", "run-with-cc-switch.ps1"))) {
          return candidate;
        }
      }
    } catch (_) {
      // best effort only
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
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
