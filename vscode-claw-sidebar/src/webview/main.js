"use strict";

(function initClawSidebar(globalThisRef) {
  const vscode = acquireVsCodeApi();
  const state = globalThisRef.ClawWebviewState.createState();
  const renderer = globalThisRef.ClawMessageRenderer.createRenderer();
  const MODEL_SLOTS = ["main", "thinking", "explore", "plan", "verify", "fast"];

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
    statusWorkspace: document.getElementById("statusWorkspace"),
    statusSession: document.getElementById("statusSession"),
    statusModel: document.getElementById("statusModel"),
    statusRunState: document.getElementById("statusRunState"),
    statusStateBadge: document.getElementById("statusStateBadge"),
    modelSlot: document.getElementById("modelSlot"),
    model: document.getElementById("model"),
    maxTokens: document.getElementById("maxTokens"),
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
    vcpHint: document.getElementById("vcpHint"),
    panelSessionBody: document.getElementById("panelSessionBody"),
    panelAdvancedBody: document.getElementById("panelAdvancedBody"),
    panelConnectionBody: document.getElementById("panelConnectionBody"),
    panelSessionChevron: document.getElementById("panelSessionChevron"),
    panelAdvancedChevron: document.getElementById("panelAdvancedChevron"),
    panelConnectionChevron: document.getElementById("panelConnectionChevron")
  };

  let persistTimer = null;

  function post(message) {
    vscode.postMessage(message);
  }

  function textValue(node) {
    return node ? String(node.value || "").trim() : "";
  }

  function numericValue(node, fallback) {
    const value = Number(textValue(node));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  function readModelMappings() {
    return {
      main: textValue(el.mapMain),
      thinking: textValue(el.mapThinking),
      explore: textValue(el.mapExplore),
      plan: textValue(el.mapPlan),
      verify: textValue(el.mapVerify),
      fast: textValue(el.mapFast)
    };
  }

  function commonPayload() {
    return {
      modelSlot: textValue(el.modelSlot) || "auto",
      model: textValue(el.model),
      modelMappings: readModelMappings(),
      maxTokens: numericValue(el.maxTokens, 1024),
      includeEditorContext: Boolean(el.includeEditor && el.includeEditor.checked),
      connectionMode: textValue(el.connectionMode) || "cc-switch",
      provider: textValue(el.provider) || "anthropic",
      baseUrl: textValue(el.baseUrl),
      apiKey: textValue(el.apiKey),
      vcpAgentId: textValue(el.vcpAgent),
      vcpTopicId: textValue(el.vcpTopic)
    };
  }

  function queuePersist() {
    if (!state.activeSessionId) {
      return;
    }
    if (persistTimer) {
      clearTimeout(persistTimer);
    }
    persistTimer = setTimeout(() => {
      persistTimer = null;
      post({
        type: "saveSession",
        payload: {
          sessionId: state.activeSessionId,
          messages: state.messages
        }
      });
    }, 250);
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

  function renderSessionSelect() {
    el.sessionSelect.innerHTML = renderer.renderSessionOptions(state.sessions, state.activeSessionId);
    const vcpMode = state.connectionMode === "vcp-agent";
    el.sessionSelect.disabled = state.running || state.sessions.length === 0 || vcpMode;
    el.sessionNew.disabled = state.running || vcpMode;
    el.sessionDelete.disabled = state.running || state.sessions.length === 0 || vcpMode;
  }

  function renderVcpOptions() {
    const vcpState = state.vcpState || {};
    const agents = Array.isArray(vcpState.agents) ? vcpState.agents : [];
    const topics = Array.isArray(vcpState.topics) ? vcpState.topics : [];

    el.vcpAgent.innerHTML = agents.length
      ? agents.map((item) => {
          const selected = item.id === vcpState.selectedAgentId ? " selected" : "";
          return `<option value="${renderer.escapeHtml(item.id)}"${selected}>${renderer.escapeHtml(item.name || item.id)}</option>`;
        }).join("")
      : '<option value="">No VCP Agents found</option>';

    el.vcpTopic.innerHTML = topics.length
      ? topics.map((item) => {
          const selected = item.id === vcpState.selectedTopicId ? " selected" : "";
          return `<option value="${renderer.escapeHtml(item.id)}"${selected}>${renderer.escapeHtml(item.name || item.id)}</option>`;
        }).join("")
      : '<option value="">No Topics found</option>';
  }

  function updatePanels() {
    const collapsed = state.panelCollapsed || {};
    for (const panelId of ["panelSession", "panelAdvanced", "panelConnection"]) {
      const body = el[`${panelId}Body`];
      const chevron = el[`${panelId}Chevron`];
      if (!body || !chevron) {
        continue;
      }
      const isCollapsed = Boolean(collapsed[panelId]);
      body.classList.toggle("hidden", isCollapsed);
      chevron.classList.toggle("collapsed", isCollapsed);
    }
  }

  function updateHeader() {
    el.statusWorkspace.textContent = state.workspaceLabel || "unknown";
    el.statusSession.textContent = state.activeSessionTitle || "New Chat";
    el.statusModel.textContent = getStatusModelLabel();
    el.statusRunState.textContent = state.runState.label;
    el.statusStateBadge.textContent = state.runState.label;
    el.statusStateBadge.className = `status-badge ${state.runState.className}`;
  }

  function getStatusModelLabel() {
    if (state.runMeta && state.runMeta.model) {
      const role = state.runMeta.resolvedRole || state.modelSlot || "main";
      return `${role} / ${state.runMeta.model}`;
    }
    if (state.modelSlot === "auto") {
      return "auto / routed";
    }
    if (state.modelSlot === "custom") {
      return state.model || "custom / unset";
    }
    return `${state.modelSlot || "main"} / ${state.provider || "anthropic"}`;
  }

  function defaultModelForSlot(provider, slot) {
    if (provider === "openai") {
      if (slot === "thinking" || slot === "plan") return "o4-mini";
      if (slot === "verify") return "gpt-4.1";
      if (slot === "fast") return "gpt-4.1-nano";
      return "gpt-4.1-mini";
    }
    if (provider === "xai") {
      if (slot === "thinking" || slot === "plan" || slot === "verify") return "grok-3";
      return "grok-3-mini";
    }
    if (slot === "thinking") return "claude-opus-4-6";
    if (slot === "fast") return "claude-haiku-4-5-20251213";
    return "claude-sonnet-4-6";
  }

  function resolvedModelLabel() {
    const provider = textValue(el.provider) || "anthropic";
    const slot = textValue(el.modelSlot) || "auto";
    const mappings = readModelMappings();
    if (slot === "auto") {
      return "Auto routes by task shape into main / thinking / explore / plan / verify / fast";
    }
    if (slot === "custom") {
      return el.model.value.trim() || mappings.main || defaultModelForSlot(provider, "main");
    }
    return mappings[slot] || defaultModelForSlot(provider, slot);
  }

  function updateModelUi() {
    const custom = textValue(el.modelSlot) === "custom";
    el.model.disabled = state.running || !custom;
    el.model.placeholder = custom
      ? "Custom model override"
      : "Switch to Custom if you want to type a one-off model";

    const provider = textValue(el.provider) || "anthropic";
    for (const slot of MODEL_SLOTS) {
      const key = `map${slot.charAt(0).toUpperCase()}${slot.slice(1)}`;
      if (el[key]) {
        el[key].disabled = state.running;
        el[key].placeholder = defaultModelForSlot(provider, slot);
      }
    }

    const slot = textValue(el.modelSlot) || "auto";
    el.modelHint.textContent = slot === "auto"
      ? `Current role: auto | ${resolvedModelLabel()}`
      : `Current role: ${slot} | Resolved model: ${resolvedModelLabel()}`;
  }

  function updateConnectionUi() {
    const manual = state.connectionMode === "manual";
    const vcpMode = state.connectionMode === "vcp-agent";
    const vcpState = state.vcpState || {};
    const vcpAvailable = Boolean(vcpState.available);

    el.provider.disabled = state.running || !manual;
    el.baseUrl.disabled = state.running || !manual;
    el.apiKey.disabled = state.running || !manual;
    el.clearKey.disabled = state.running || !manual || !state.hasApiKey;
    el.vcpSection.classList.toggle("hidden", !vcpMode);
    el.vcpAgent.disabled = state.running || !vcpMode || !vcpAvailable;
    el.vcpTopic.disabled = state.running || !vcpMode || !vcpAvailable;
    el.refreshVcp.disabled = state.running || !vcpMode;
    el.newTopic.disabled = state.running || !vcpMode || !textValue(el.vcpAgent);

    if (vcpMode) {
      el.connectionHint.textContent = "VCP Agent mode stores conversation memory inside VCPChat.";
      el.apiKey.placeholder = "VCP uses the key saved in VCPChat";
      const configured = vcpState.configuredRoot ? ` | configured: ${vcpState.configuredRoot}` : "";
      const warning = vcpState.warning ? ` | warning: ${vcpState.warning}` : "";
      const error = !vcpAvailable && vcpState.error ? ` | error: ${vcpState.error}` : "";
      el.vcpHint.textContent =
        `Root: ${vcpState.vcpRoot || "not found"} | Agent: ${vcpState.selectedAgentName || vcpState.selectedAgentId || "none"} | Topic: ${vcpState.selectedTopicName || vcpState.selectedTopicId || "none"}${configured}${warning}${error}`;
      renderSessionSelect();
      return;
    }

    if (!manual) {
      el.connectionHint.textContent = "CC switch mode uses the local Claw runtime and current Claude provider.";
      el.apiKey.placeholder = "API key is managed by CC switch";
      el.vcpHint.textContent = "";
      return;
    }

    const providerText = el.provider.options[el.provider.selectedIndex]
      ? el.provider.options[el.provider.selectedIndex].text
      : "provider";
    el.connectionHint.textContent = `Direct API mode uses a saved key plus an optional custom Base URL for ${providerText}.`;
    el.apiKey.placeholder = state.hasApiKey
      ? "Saved in VS Code Secret Storage. Enter a new key to replace it."
      : "Enter API Key";
    el.vcpHint.textContent = "";
  }

  function renderChat(scroll) {
    el.chat.innerHTML = renderer.renderMessages(state.messages, {
      streamingIndex: state.running ? state.streamingMessageIndex : -1
    });
    hydrateTrustedHtml();
    if (scroll !== false) {
      el.chat.scrollTop = el.chat.scrollHeight;
    }
  }

  function hydrateTrustedHtml() {
    const containers = el.chat.querySelectorAll(".trusted-html");
    containers.forEach((container) => {
      container.querySelectorAll("script, iframe, object, embed, link, meta").forEach((node) => node.remove());

      container.querySelectorAll("*").forEach((node) => {
        for (const attr of Array.from(node.attributes)) {
          const name = attr.name.toLowerCase();
          const value = String(attr.value || "");
          if (name.startsWith("on")) {
            if (node.tagName.toLowerCase() === "button" && name === "onclick") {
              const prompt = extractInputPrompt(value);
              if (prompt) {
                node.setAttribute("data-vcp-input", prompt);
              }
            }
            node.removeAttribute(attr.name);
            continue;
          }
          if ((name === "href" || name === "src") && /^\s*javascript:/i.test(value)) {
            node.removeAttribute(attr.name);
            continue;
          }
          if (name === "style" && /(expression\s*\(|javascript\s*:|vbscript\s*:|behavior\s*:|-moz-binding|@import)/i.test(value)) {
            node.removeAttribute(attr.name);
          }
        }

        if (node.tagName.toLowerCase() === "button") {
          node.setAttribute("type", "button");
        }
        if (node.tagName.toLowerCase() === "a" && node.getAttribute("href")) {
          node.setAttribute("target", "_blank");
          node.setAttribute("rel", "noreferrer noopener");
        }
      });
    });
  }

  function extractInputPrompt(source) {
    const text = String(source || "").trim();
    const match = text.match(/^input\((['"])([\s\S]*)\1\)$/);
    return match ? match[2] : "";
  }

  function syncAll(scroll) {
    renderSessionSelect();
    renderVcpOptions();
    updatePanels();
    updateConnectionUi();
    updateModelUi();
    updateHeader();
    renderChat(scroll);
  }

  function setRunning(running, runStateKey) {
    state.setRunning(running);
    state.setRunState(runStateKey || (running ? "starting" : "idle"));
    el.send.disabled = running;
    el.newBtn.disabled = running;
    el.quickStart.disabled = running;
    el.viewFile.disabled = running;
    el.doctor.disabled = running;
    el.status.disabled = running;
    el.repl.disabled = running;
    el.modelSlot.disabled = running;
    el.maxTokens.disabled = running;
    el.connectionMode.disabled = running;
    el.includeEditor.disabled = running;
    el.stop.disabled = !running;
    updateConnectionUi();
    updateModelUi();
    updateHeader();
    renderSessionSelect();
  }

  function savePrefs() {
    post({
      type: "savePrefs",
      payload: commonPayload()
    });
  }

  function applyInit(payload) {
    state.hydrate(payload || {});
    el.modelSlot.value = state.modelSlot;
    el.model.value = state.model;
    el.maxTokens.value = String(state.maxTokens || 1024);
    el.includeEditor.checked = Boolean(state.includeEditorContext);
    el.connectionMode.value = state.connectionMode;
    el.provider.value = state.provider;
    el.baseUrl.value = state.baseUrl;
    el.apiKey.value = "";
    applyModelMappings(state.modelMappings);
    syncAll();
    if (state.messages.length === 0) {
      state.pushMessage({
        role: "system",
        title: "System",
        content: "Ready. Choose CC switch, Direct API, or VCP Agent Memory above, then start chatting."
      });
      renderChat();
      queuePersist();
    }
  }

  function applyPrefs(payload) {
    state.applyPrefs(payload || {});
    if (payload && Object.prototype.hasOwnProperty.call(payload, "modelSlot")) {
      el.modelSlot.value = state.modelSlot;
    }
    if (payload && Object.prototype.hasOwnProperty.call(payload, "model")) {
      el.model.value = state.model;
    }
    if (payload && payload.modelMappings) {
      applyModelMappings(state.modelMappings);
    }
    if (payload && Object.prototype.hasOwnProperty.call(payload, "connectionMode")) {
      el.connectionMode.value = state.connectionMode;
    }
    if (payload && Object.prototype.hasOwnProperty.call(payload, "provider")) {
      el.provider.value = state.provider;
    }
    if (payload && Object.prototype.hasOwnProperty.call(payload, "baseUrl")) {
      el.baseUrl.value = state.baseUrl;
    }
    el.apiKey.value = "";
    syncAll(false);
  }

  function sendPrompt() {
    if (state.running) {
      return;
    }
    const input = textValue(el.input);
    if (!input) {
      return;
    }
    state.pushMessage({ role: "user", content: input });
    state.beginAssistantTurn();
    renderChat();
    el.input.value = "";
    setRunning(true, "starting");
    savePrefs();
    post({
      type: "ask",
      input,
      history: state.messages.slice(0, -1),
      ...commonPayload()
    });
  }

  function createQuickStartMessage(payload) {
    const stdout = String((payload && payload.stdout) || "");
    const stderr = String((payload && payload.stderr) || "");
    const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

    const lookup = (prefix) => {
      const match = lines.find((line) => line.toLowerCase().startsWith(prefix.toLowerCase()));
      return match ? match.slice(prefix.length).trim() : "";
    };

    const diagnostics = [];
    const workspace = lookup("Workspace:");
    if (workspace) diagnostics.push({ label: "workspace", value: workspace, status: "ok" });

    if (lines.some((line) => line.startsWith("Connection:"))) {
      diagnostics.push({ label: "connection", value: lookup("Connection:"), status: "ok" });
    }

    if (lines.some((line) => line.startsWith("Runner:"))) {
      diagnostics.push({ label: "runner", value: lookup("Runner:"), status: "ok" });
    }

    if (lines.some((line) => line.toLowerCase().includes("claw.exe found"))) {
      diagnostics.push({ label: "claw.exe", value: "present", status: "ok" });
    } else if (lines.some((line) => line.toLowerCase().includes("claw.exe not found"))) {
      diagnostics.push({ label: "claw.exe", value: "building required", status: "warn" });
    }

    if (lines.some((line) => line.startsWith("Provider:"))) {
      diagnostics.push({ label: "provider", value: lookup("Provider:"), status: "ok" });
    }

    if (lines.some((line) => line.startsWith("Base URL:"))) {
      diagnostics.push({ label: "base url", value: lookup("Base URL:"), status: "ok" });
    }

    if (lines.some((line) => line.startsWith("VCP server:"))) {
      const value = lookup("VCP server:");
      diagnostics.push({
        label: "vcp server",
        value,
        status: value && value !== "(missing)" ? "ok" : "fail"
      });
    }

    if (lines.some((line) => line.startsWith("VCP API key:"))) {
      const value = lookup("VCP API key:");
      diagnostics.push({
        label: "vcp api key",
        value,
        status: value === "present" ? "ok" : "fail"
      });
    }

    if (lines.some((line) => line.startsWith("Agent:"))) {
      const value = lookup("Agent:");
      diagnostics.push({
        label: "agent",
        value,
        status: value && value !== "(none)" ? "ok" : "warn"
      });
    }

    if (lines.some((line) => line.startsWith("Topic:"))) {
      const value = lookup("Topic:");
      diagnostics.push({
        label: "topic",
        value,
        status: value && value !== "(none)" ? "ok" : "warn"
      });
    }

    if (stdout.includes("[doctor]")) {
      diagnostics.push({
        label: "doctor",
        value: payload.code === 0 ? "passed" : "check output",
        status: payload.code === 0 ? "ok" : "warn"
      });
    }

    if (stdout.includes("[status]")) {
      diagnostics.push({
        label: "status",
        value: payload.code === 0 ? "healthy" : "attention needed",
        status: payload.code === 0 ? "ok" : "warn"
      });
    }

    if (stderr) {
      diagnostics.push({
        label: "stderr",
        value: stderr.split(/\r?\n/)[0],
        status: payload.code === 0 ? "warn" : "fail"
      });
    }

    return {
      role: payload.code === 0 ? "system" : "error",
      title: "Quick Start",
      content: buildQuickStartNarrative(lines, stderr),
      diagnostics
    };
  }

  function buildQuickStartNarrative(lines, stderr) {
    const important = lines.filter((line) => {
      const lower = line.toLowerCase();
      return (
        lower.startsWith("quick start:") ||
        lower.startsWith("connection:") ||
        lower.startsWith("resolved model:") ||
        lower.startsWith("vcp root:") ||
        lower.startsWith("vcp server:")
      );
    });

    const parts = [];
    if (important.length) {
      parts.push(important.map((line) => `- ${line}`).join("\n"));
    }
    if (stderr) {
      parts.push(`Warning:\n\n${stderr}`);
    }
    return parts.join("\n\n");
  }

  function createUtilityMessage(payload) {
    if (payload.command === "quick-start") {
      return createQuickStartMessage(payload);
    }
    const lines = [];
    if (payload.stdout) {
      lines.push(String(payload.stdout).trim());
    }
    if (payload.stderr) {
      lines.push(String(payload.stderr).trim());
    }
    return {
      role: payload.code === 0 ? "system" : "error",
      title: prettifyCommandLabel(payload.command),
      content: lines.join("\n\n") || `${payload.command} done.`
    };
  }

  function prettifyCommandLabel(command) {
    return String(command || "system")
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  function handleRunEnd(payload) {
    setRunning(false, payload.code === 0 ? "done" : "failed");

    if (payload.code !== 0) {
      state.removeEmptyAssistantTurn();
      state.pushMessage({
        role: "error",
        title: "Request failed",
        content: String(payload.stderr || payload.stdout || "Request failed.").trim()
      });
      renderChat();
      queuePersist();
      return;
    }

    const last = state.messages[state.messages.length - 1];
    if (last && last.role === "assistant" && !String(last.content || "").trim()) {
      last.content = String(payload.stdout || payload.stderr || "(no output)").trim();
    }
    state.completeAssistantTurn();
    renderChat();
    queuePersist();
  }

  function handleCancelled(payload) {
    setRunning(false, "cancelled");
    state.removeEmptyAssistantTurn();
    state.pushMessage({
      role: "system",
      title: "Cancelled",
      content: (payload && payload.message) || "Cancelled."
    });
    renderChat();
    queuePersist();
  }

  function handleFileViewed(payload) {
    const note = payload.truncated ? "\n\nPreview truncated for sidebar readability." : "";
    const fence = String.fromCharCode(96).repeat(3);
    state.pushMessage({
      role: "system",
      title: "View File",
      content: [
        `Viewing file: ${payload.path || "<unknown>"}`,
        "",
        `${fence}${payload.language || "text"}`,
        payload.content || "",
        fence,
        note.trim()
      ].filter(Boolean).join("\n")
    });
    renderChat();
    queuePersist();
  }

  function togglePanel(panelId) {
    const next = {
      ...state.panelCollapsed,
      [panelId]: !state.panelCollapsed[panelId]
    };
    state.applyPrefs({ panelCollapsed: next });
    updatePanels();
    post({
      type: "savePrefs",
      payload: { panelCollapsed: next }
    });
  }

  function refreshVcpState() {
    savePrefs();
    post({
      type: "refreshVcpState",
      payload: {
        connectionMode: textValue(el.connectionMode),
        vcpAgentId: textValue(el.vcpAgent),
        vcpTopicId: textValue(el.vcpTopic)
      }
    });
  }

  document.querySelectorAll(".collapsible-header").forEach((node) => {
    node.addEventListener("click", () => {
      const panelId = node.getAttribute("data-panel");
      if (panelId) {
        togglePanel(panelId);
      }
    });
  });

  el.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendPrompt();
    }
  });

  el.modelSlot.addEventListener("change", () => {
    state.applyPrefs({ modelSlot: textValue(el.modelSlot) });
    updateModelUi();
    updateHeader();
    savePrefs();
  });
  el.model.addEventListener("change", savePrefs);
  el.maxTokens.addEventListener("change", savePrefs);
  el.provider.addEventListener("change", () => {
    state.applyPrefs({ provider: textValue(el.provider) });
    updateConnectionUi();
    updateModelUi();
    updateHeader();
    savePrefs();
  });
  el.baseUrl.addEventListener("change", savePrefs);
  el.apiKey.addEventListener("change", savePrefs);
  el.includeEditor.addEventListener("change", savePrefs);

  [el.mapMain, el.mapThinking, el.mapExplore, el.mapPlan, el.mapVerify, el.mapFast].forEach((node) => {
    node.addEventListener("change", () => {
      updateModelUi();
      savePrefs();
    });
  });

  el.connectionMode.addEventListener("change", () => {
    state.applyPrefs({ connectionMode: textValue(el.connectionMode) });
    updateConnectionUi();
    updateHeader();
    savePrefs();
    if (textValue(el.connectionMode) === "vcp-agent") {
      refreshVcpState();
    } else {
      renderSessionSelect();
    }
  });

  el.vcpAgent.addEventListener("change", () => {
    savePrefs();
    post({
      type: "refreshVcpState",
      payload: {
        connectionMode: textValue(el.connectionMode),
        vcpAgentId: textValue(el.vcpAgent),
        vcpTopicId: ""
      }
    });
  });

  el.vcpTopic.addEventListener("change", refreshVcpState);

  el.send.addEventListener("click", sendPrompt);
  el.stop.addEventListener("click", () => post({ type: "stop" }));
  el.newBtn.addEventListener("click", () => {
    if (!state.running) {
      queuePersist();
      post({ type: "newChat" });
    }
  });
  el.quickStart.addEventListener("click", () => {
    if (!state.running) {
      setRunning(true, "checking");
      savePrefs();
      post({ type: "quickStart", payload: commonPayload() });
    }
  });
  el.viewFile.addEventListener("click", () => {
    if (!state.running) {
      setRunning(true, "checking");
      post({ type: "viewFile" });
    }
  });
  el.doctor.addEventListener("click", () => {
    if (!state.running) {
      setRunning(true, "checking");
      post({ type: "runDoctor" });
    }
  });
  el.status.addEventListener("click", () => {
    if (!state.running) {
      setRunning(true, "checking");
      post({ type: "runStatus" });
    }
  });
  el.repl.addEventListener("click", () => {
    if (!state.running) {
      savePrefs();
      setRunning(true, "checking");
      post({ type: "openRepl", payload: commonPayload() });
    }
  });
  el.clearKey.addEventListener("click", () => {
    el.apiKey.value = "";
    state.applyPrefs({ hasApiKey: false });
    updateConnectionUi();
    post({ type: "clearApiKey" });
  });
  el.refreshVcp.addEventListener("click", () => {
    if (!state.running) {
      setRunning(true, "checking");
      refreshVcpState();
    }
  });
  el.newTopic.addEventListener("click", () => {
    if (state.running) {
      return;
    }
    const topicName = globalThisRef.prompt("New VCP topic name", "");
    if (topicName === null) {
      return;
    }
    setRunning(true, "checking");
    savePrefs();
    post({
      type: "createVcpTopic",
      payload: {
        connectionMode: textValue(el.connectionMode),
        vcpAgentId: textValue(el.vcpAgent),
        topicName
      }
    });
  });
  el.sessionNew.addEventListener("click", () => {
    if (!state.running) {
      queuePersist();
      post({ type: "newChat" });
    }
  });
  el.sessionDelete.addEventListener("click", () => {
    if (!state.running && state.activeSessionId) {
      queuePersist();
      post({
        type: "deleteSession",
        payload: { sessionId: state.activeSessionId }
      });
    }
  });
  el.sessionSelect.addEventListener("change", () => {
    if (!state.running && textValue(el.sessionSelect) && textValue(el.sessionSelect) !== state.activeSessionId) {
      queuePersist();
      post({
        type: "switchSession",
        payload: { sessionId: textValue(el.sessionSelect) }
      });
    }
  });

  el.chat.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const codeButton = target.closest(".copy-btn");
    if (codeButton) {
      const block = codeButton.closest(".code");
      const code = block ? block.querySelector("pre code") : null;
      const text = code ? code.textContent || "" : "";
      if (!text) {
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        codeButton.textContent = "Copied";
        globalThisRef.setTimeout(() => {
          codeButton.textContent = "Copy";
        }, 1200);
      } catch (_) {
        state.pushMessage({
          role: "error",
          title: "Clipboard",
          content: "Copy failed: clipboard unavailable."
        });
        renderChat();
      }
      return;
    }

    const messageCopyButton = target.closest("[data-copy-message]");
    if (messageCopyButton) {
      const card = messageCopyButton.closest(".message-card");
      const text = card ? card.innerText || "" : "";
      if (!text) {
        return;
      }
      try {
        await navigator.clipboard.writeText(text.trim());
        messageCopyButton.textContent = "Copied";
        globalThisRef.setTimeout(() => {
          messageCopyButton.textContent = "Copy";
        }, 1200);
      } catch (_) {
        state.pushMessage({
          role: "error",
          title: "Clipboard",
          content: "Copy failed: clipboard unavailable."
        });
        renderChat();
      }
      return;
    }

    const vcpInputButton = target.closest("[data-vcp-input]");
    if (vcpInputButton) {
      const prompt = String(vcpInputButton.getAttribute("data-vcp-input") || "").trim();
      if (!prompt) {
        return;
      }
      el.input.value = prompt;
      el.input.focus();
      const end = el.input.value.length;
      try {
        el.input.setSelectionRange(end, end);
      } catch (_) {
        // best effort
      }
    }
  });

  globalThisRef.addEventListener("message", (event) => {
    const message = event.data || {};
    const payload = message.payload || {};

    switch (message.type) {
      case "init":
        applyInit(payload);
        break;
      case "prefsState":
        applyPrefs(payload);
        break;
      case "vcpState":
        state.applyPrefs({ vcpState: payload || {} });
        setRunning(false, "idle");
        syncAll(false);
        break;
      case "vcpHistoryLoaded":
        state.replaceMessages(payload.session || []);
        renderChat();
        queuePersist();
        break;
      case "sessionState":
        state.applySessionState(payload || {});
        setRunning(false, "idle");
        syncAll(false);
        break;
      case "runStart":
        state.setRunMeta(payload || {});
        setRunning(true, "starting");
        updateHeader();
        break;
      case "runChunk":
        state.appendAssistantChunk(payload.text || "");
        state.setRunState("streaming");
        updateHeader();
        renderChat(false);
        queuePersist();
        break;
      case "runEnd":
        handleRunEnd(payload || {});
        break;
      case "runCancelled":
        handleCancelled(payload || {});
        break;
      case "utilityResult":
        setRunning(false, payload.code === 0 ? "done" : "failed");
        state.pushMessage(createUtilityMessage(payload || {}));
        renderChat();
        queuePersist();
        break;
      case "fileViewed":
        setRunning(false, "done");
        handleFileViewed(payload || {});
        break;
      case "error":
        setRunning(false, "failed");
        state.pushMessage({
          role: "error",
          title: "Error",
          content: payload.message || "Unexpected error."
        });
        renderChat();
        queuePersist();
        break;
      case "invoke":
        handleInvoke(payload || {});
        break;
      default:
        break;
    }
  });

  function handleInvoke(payload) {
    const action = payload.action;
    const data = payload.payload || {};
    if (action === "newChat") el.newBtn.click();
    else if (action === "stop") el.stop.click();
    else if (action === "quickStart") el.quickStart.click();
    else if (action === "viewFile") el.viewFile.click();
    else if (action === "doctor") el.doctor.click();
    else if (action === "status") el.status.click();
    else if (action === "repl") el.repl.click();
    else if (action === "askSelection") {
      const prompt = String(data.prompt || "").trim();
      if (!prompt) {
        return;
      }
      el.input.value = prompt;
      el.input.focus();
      if (data.send) {
        sendPrompt();
      }
    }
  }

  globalThisRef.addEventListener("beforeunload", () => {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    if (state.activeSessionId) {
      post({
        type: "saveSession",
        payload: {
          sessionId: state.activeSessionId,
          messages: state.messages
        }
      });
    }
  });

  setRunning(false, "idle");
  post({ type: "init" });
})(window);
