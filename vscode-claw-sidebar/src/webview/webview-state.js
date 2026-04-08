"use strict";

(function initWebviewState(globalThisRef) {
  const RUN_STATES = {
    idle: { label: "Idle", className: "status-idle" },
    checking: { label: "Checking", className: "status-checking" },
    starting: { label: "Starting", className: "status-starting" },
    waiting: { label: "Waiting", className: "status-waiting" },
    streaming: { label: "Streaming", className: "status-streaming" },
    done: { label: "Done", className: "status-done" },
    cancelled: { label: "Cancelled", className: "status-cancelled" },
    failed: { label: "Failed", className: "status-failed" }
  };

  const DEFAULT_PANELS = {
    panelSession: false,
    panelAdvanced: true,
    panelConnection: true
  };

  function normalizeMessages(messages) {
    if (!Array.isArray(messages)) {
      return [];
    }
    return messages
      .filter((message) => message && typeof message.role === "string")
      .slice(-120)
      .map((message) => ({
        role: message.role,
        title: typeof message.title === "string" ? message.title : "",
        content: typeof message.content === "string" ? message.content : "",
        meta: typeof message.meta === "string" ? message.meta : "",
        diagnostics: normalizeDiagnostics(message.diagnostics)
      }));
  }

  function normalizeDiagnostics(diagnostics) {
    if (!Array.isArray(diagnostics)) {
      return [];
    }
    return diagnostics
      .filter((item) => item && typeof item.label === "string")
      .map((item) => ({
        label: item.label,
        value: typeof item.value === "string" ? item.value : "",
        status: normalizeDiagnosticStatus(item.status)
      }));
  }

  function normalizeDiagnosticStatus(status) {
    const value = String(status || "").trim().toLowerCase();
    if (value === "ok" || value === "warn" || value === "fail") {
      return value;
    }
    return "ok";
  }

  function normalizeSessions(sessions) {
    if (!Array.isArray(sessions)) {
      return [];
    }
    return sessions
      .filter((session) => session && typeof session.id === "string")
      .map((session) => ({
        id: session.id,
        title: typeof session.title === "string" && session.title.trim() ? session.title : "New Chat",
        updatedAt: Number(session.updatedAt) || Date.now()
      }));
  }

  function createState() {
    const state = {
      sessions: [],
      activeSessionId: "",
      messages: [],
      runStateKey: "idle",
      assistantMessageIndex: -1,
      running: false,
      hasApiKey: false,
      workspaceLabel: "unknown",
      connectionMode: "cc-switch",
      provider: "anthropic",
      baseUrl: "",
      modelSlot: "auto",
      model: "",
      modelMappings: {},
      maxTokens: 1024,
      includeEditorContext: true,
      panelCollapsed: { ...DEFAULT_PANELS },
      vcpState: {
        available: false,
        agents: [],
        topics: [],
        history: []
      },
      runMeta: {
        model: "",
        resolvedRole: "",
        provider: ""
      }
    };

    return {
      get sessions() {
        return state.sessions;
      },
      get activeSessionId() {
        return state.activeSessionId;
      },
      get messages() {
        return state.messages;
      },
      get hasApiKey() {
        return state.hasApiKey;
      },
      get workspaceLabel() {
        return state.workspaceLabel;
      },
      get connectionMode() {
        return state.connectionMode;
      },
      get provider() {
        return state.provider;
      },
      get baseUrl() {
        return state.baseUrl;
      },
      get modelSlot() {
        return state.modelSlot;
      },
      get model() {
        return state.model;
      },
      get modelMappings() {
        return state.modelMappings;
      },
      get maxTokens() {
        return state.maxTokens;
      },
      get includeEditorContext() {
        return state.includeEditorContext;
      },
      get panelCollapsed() {
        return state.panelCollapsed;
      },
      get vcpState() {
        return state.vcpState;
      },
      get running() {
        return state.running;
      },
      get runMeta() {
        return state.runMeta;
      },
      get streamingMessageIndex() {
        return state.assistantMessageIndex;
      },
      get runState() {
        return RUN_STATES[state.runStateKey] || RUN_STATES.idle;
      },
      get activeSessionTitle() {
        const active = state.sessions.find((session) => session.id === state.activeSessionId);
        return active ? active.title : "New Chat";
      },
      hydrate(payload) {
        state.sessions = normalizeSessions(payload.sessions);
        state.activeSessionId =
          payload.activeSessionId ||
          (state.sessions[0] && state.sessions[0].id) ||
          "";
        state.messages = normalizeMessages(payload.session);
        state.hasApiKey = Boolean(payload.hasApiKey);
        state.workspaceLabel = String(payload.workspaceLabel || state.workspaceLabel || "unknown");
        state.connectionMode = String(payload.connectionMode || "cc-switch");
        state.provider = String(payload.provider || "anthropic");
        state.baseUrl = String(payload.baseUrl || "");
        state.modelSlot = String(payload.modelSlot || "auto");
        state.model = String(payload.model || "");
        state.modelMappings = payload.modelMappings && typeof payload.modelMappings === "object"
          ? payload.modelMappings
          : {};
        state.maxTokens = Number(payload.maxTokens) || 1024;
        state.includeEditorContext = payload.includeEditorContext !== false;
        state.panelCollapsed = {
          ...DEFAULT_PANELS,
          ...(payload.panelCollapsed && typeof payload.panelCollapsed === "object" ? payload.panelCollapsed : {})
        };
        state.vcpState = payload.vcpState && typeof payload.vcpState === "object"
          ? payload.vcpState
          : { available: false, agents: [], topics: [], history: [] };
        state.runMeta = { model: "", resolvedRole: "", provider: "" };
        state.running = false;
        state.runStateKey = "idle";
        state.assistantMessageIndex = -1;
      },
      applyPrefs(payload) {
        if (!payload || typeof payload !== "object") {
          return;
        }
        if (Object.prototype.hasOwnProperty.call(payload, "hasApiKey")) {
          state.hasApiKey = Boolean(payload.hasApiKey);
        }
        if (Object.prototype.hasOwnProperty.call(payload, "connectionMode")) {
          state.connectionMode = String(payload.connectionMode || "cc-switch");
        }
        if (Object.prototype.hasOwnProperty.call(payload, "provider")) {
          state.provider = String(payload.provider || "anthropic");
        }
        if (Object.prototype.hasOwnProperty.call(payload, "baseUrl")) {
          state.baseUrl = String(payload.baseUrl || "");
        }
        if (Object.prototype.hasOwnProperty.call(payload, "modelSlot")) {
          state.modelSlot = String(payload.modelSlot || "auto");
        }
        if (Object.prototype.hasOwnProperty.call(payload, "model")) {
          state.model = String(payload.model || "");
        }
        if (Object.prototype.hasOwnProperty.call(payload, "modelMappings") && payload.modelMappings) {
          state.modelMappings = payload.modelMappings;
        }
        if (Object.prototype.hasOwnProperty.call(payload, "panelCollapsed") && payload.panelCollapsed) {
          state.panelCollapsed = {
            ...DEFAULT_PANELS,
            ...payload.panelCollapsed
          };
        }
        if (Object.prototype.hasOwnProperty.call(payload, "vcpState") && payload.vcpState) {
          state.vcpState = payload.vcpState;
        }
      },
      applySessionState(payload) {
        state.sessions = normalizeSessions(payload.sessions);
        state.activeSessionId =
          payload.activeSessionId ||
          (state.sessions[0] && state.sessions[0].id) ||
          "";
        state.messages = normalizeMessages(payload.session);
        state.assistantMessageIndex = -1;
      },
      replaceMessages(messages) {
        state.messages = normalizeMessages(messages);
        state.assistantMessageIndex = -1;
      },
      pushMessage(message) {
        state.messages.push({
          role: String(message.role || "system"),
          title: String(message.title || ""),
          content: String(message.content || ""),
          meta: String(message.meta || ""),
          diagnostics: normalizeDiagnostics(message.diagnostics)
        });
      },
      beginAssistantTurn() {
        state.assistantMessageIndex = state.messages.length;
        state.messages.push({
          role: "assistant",
          title: "",
          content: "",
          meta: "",
          diagnostics: []
        });
      },
      appendAssistantChunk(chunk) {
        const target = state.messages[state.assistantMessageIndex];
        if (!target) {
          return;
        }
        target.content += String(chunk || "");
      },
      removeEmptyAssistantTurn() {
        const target = state.messages[state.assistantMessageIndex];
        if (target && !String(target.content || "").trim()) {
          state.messages.splice(state.assistantMessageIndex, 1);
        }
        state.assistantMessageIndex = -1;
      },
      completeAssistantTurn() {
        state.assistantMessageIndex = -1;
      },
      setRunState(key) {
        state.runStateKey = Object.prototype.hasOwnProperty.call(RUN_STATES, key) ? key : "idle";
      },
      setRunning(running) {
        state.running = Boolean(running);
      },
      setRunMeta(meta) {
        state.runMeta = {
          model: String((meta && meta.model) || ""),
          resolvedRole: String((meta && meta.resolvedRole) || ""),
          provider: String((meta && meta.provider) || "")
        };
      }
    };
  }

  globalThisRef.ClawWebviewState = {
    createState
  };
})(window);
