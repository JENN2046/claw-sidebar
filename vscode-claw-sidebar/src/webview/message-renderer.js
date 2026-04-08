"use strict";

(function initMessageRenderer(globalThisRef) {
  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderSessionOptions(sessions, activeSessionId) {
    if (!Array.isArray(sessions) || sessions.length === 0) {
      return '<option value="">No sessions</option>';
    }
    return sessions.map((session) => {
      const selected = session.id === activeSessionId ? " selected" : "";
      return `<option value="${escapeHtml(session.id)}"${selected}>${escapeHtml(session.title || "New Chat")}</option>`;
    }).join("");
  }

  function renderMessages(messages, options) {
    const safeOptions = options || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return `
        <article class="message-card system-card">
          <div class="message-head">
            <span class="message-role">System</span>
          </div>
          <div class="message-body"><p>Ready. Choose a connection mode, run Quick Start, or send a prompt.</p></div>
        </article>
      `;
    }
    return messages.map((message, index) => renderMessage(message, {
      isStreaming: safeOptions.streamingIndex === index
    })).join("");
  }

  function renderMessage(message, options) {
    const safeOptions = options || {};
    const role = String((message && message.role) || "assistant");
    const htmlMessage = isTrustedHtmlMessage(message);
    const roleLabel = {
      user: "You",
      assistant: "Claw",
      system: message.title || "System",
      error: message.title || "Error"
    }[role] || "Message";

    const className = {
      user: "user-card",
      assistant: "assistant-card",
      system: "system-card",
      error: "error-card"
    }[role] || "assistant-card";

    const streaming = safeOptions.isStreaming ? " is-streaming" : "";
    const htmlClass = htmlMessage ? " html-message" : "";
    const diagnostics = Array.isArray(message.diagnostics) && message.diagnostics.length
      ? `<div class="diagnostic-list">${message.diagnostics.map(renderDiagnosticRow).join("")}</div>`
      : "";
    const body = renderMessageHtml(message);
    const meta = message.meta
      ? `<div class="message-meta">${escapeHtml(message.meta)}</div>`
      : "";
    const actions = role === "assistant"
      ? `
        <div class="message-actions">
          <button class="text-link" type="button" data-copy-message="${messageIndexToken(message)}">Copy</button>
        </div>
      `
      : "";

    return `
      <article class="message-card ${className}${streaming}${htmlClass}">
        <div class="message-head">
          <span class="message-role">${escapeHtml(roleLabel)}</span>
        </div>
        ${diagnostics}
        <div class="message-body">${body}</div>
        ${meta}
        ${actions}
      </article>
    `;
  }

  function renderDiagnosticRow(item) {
    const status = normalizeDiagnosticStatus(item.status);
    return `
      <div class="diagnostic-row ${status}">
        <span class="diagnostic-label">${escapeHtml(item.label)}</span>
        <span class="diagnostic-value">${escapeHtml(item.value || "")}</span>
        <span class="diagnostic-status">${escapeHtml(status.toUpperCase())}</span>
      </div>
    `;
  }

  function messageIndexToken(message) {
    return escapeHtml(String((message && message.content) || "").slice(0, 64));
  }

  function normalizeDiagnosticStatus(status) {
    const value = String(status || "").trim().toLowerCase();
    return value === "warn" || value === "fail" ? value : "ok";
  }

  function renderMessageHtml(message) {
    const content = String((message && message.content) || "");
    if (message && (message.role === "assistant" || message.role === "system" || message.role === "error")) {
      if (isProbablyHtml(content)) {
        return `<div class="trusted-html">${sanitizeTrustedHtmlString(content)}</div>`;
      }
      return renderMarkdown(content);
    }
    return `<div class="plain">${escapeHtml(content).replace(/\n/g, "<br />")}</div>`;
  }

  function isTrustedHtmlMessage(message) {
    return isProbablyHtml(String((message && message.content) || ""));
  }

  function isProbablyHtml(text) {
    const source = String(text || "").trim();
    return /^<([a-z][a-z0-9-]*)\b[^>]*>/i.test(source) && /<\/[a-z][a-z0-9-]*>\s*$/i.test(source);
  }

  function sanitizeTrustedHtmlString(source) {
    let html = String(source || "");
    html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
    html = html.replace(/<(iframe|object|embed|link|meta)[^>]*>/gi, "");
    html = html.replace(/\s(on[a-z-]+)\s*=\s*(['"]).*?\2/gi, "");
    html = html.replace(/\s(on[a-z-]+)\s*=\s*[^\s>]+/gi, "");
    html = html.replace(/\s(href|src)\s*=\s*(['"])\s*javascript:[\s\S]*?\2/gi, "");
    html = html.replace(/\sstyle\s*=\s*(['"])([\s\S]*?)\1/gi, (_, quote, styleValue) => {
      const blocked = /(expression\s*\(|javascript\s*:|vbscript\s*:|behavior\s*:|-moz-binding|@import)/i;
      return blocked.test(styleValue) ? "" : ` style=${quote}${styleValue}${quote}`;
    });
    return html;
  }

  function renderMarkdown(text) {
    const source = String(text || "");
    const fence = String.fromCharCode(96).repeat(3);
    const parts = [];
    let cursor = 0;

    while (cursor < source.length) {
      const start = source.indexOf(fence, cursor);
      if (start < 0) {
        parts.push(renderMarkdownText(source.slice(cursor)));
        break;
      }

      const before = source.slice(cursor, start);
      if (before) {
        parts.push(renderMarkdownText(before));
      }

      const lineEnd = source.indexOf("\n", start + fence.length);
      if (lineEnd < 0) {
        parts.push(renderMarkdownText(source.slice(start)));
        break;
      }

      const end = source.indexOf(fence, lineEnd + 1);
      if (end < 0) {
        parts.push(renderMarkdownText(source.slice(start)));
        break;
      }

      const languageRaw = source.slice(start + fence.length, lineEnd).trim();
      const language = escapeHtml(languageRaw || "code");
      const codeRaw = source.slice(lineEnd + 1, end);
      const code = highlightCode(codeRaw, languageRaw);
      parts.push(
        `<div class="code"><div class="code-head"><span>${language}</span><button class="copy-btn" type="button">Copy</button></div><pre><code>${code}</code></pre></div>`
      );
      cursor = end + fence.length;
    }

    return parts.join("") || "<p></p>";
  }

  function renderMarkdownText(raw) {
    const lines = String(raw || "").split("\n");
    const parts = [];
    let paragraph = [];
    let list = [];

    const flushParagraph = () => {
      if (paragraph.length === 0) {
        return;
      }
      parts.push(`<p>${renderInline(paragraph.join("\n")).replace(/\n/g, "<br />")}</p>`);
      paragraph = [];
    };

    const flushList = () => {
      if (list.length === 0) {
        return;
      }
      parts.push(`<ul>${list.map((item) => `<li>${item}</li>`).join("")}</ul>`);
      list = [];
    };

    for (const line of lines) {
      const match = line.match(/^\s*[-*]\s+(.*)$/);
      if (match) {
        flushParagraph();
        list.push(renderInline(match[1]));
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        flushList();
        continue;
      }
      flushList();
      paragraph.push(line);
    }

    flushParagraph();
    flushList();
    return parts.join("");
  }

  function renderInline(text) {
    const marker = String.fromCharCode(96);
    let source = String(text || "");
    let output = "";

    while (source.length > 0) {
      const start = source.indexOf(marker);
      if (start < 0) {
        output += escapeHtml(source);
        break;
      }
      const end = source.indexOf(marker, start + 1);
      if (end < 0) {
        output += escapeHtml(source);
        break;
      }
      output += escapeHtml(source.slice(0, start));
      output += `<code class="inline">${escapeHtml(source.slice(start + 1, end))}</code>`;
      source = source.slice(end + 1);
    }

    return output;
  }

  function highlightCode(codeRaw, languageRaw) {
    const lang = normalizeLang(languageRaw);
    let text = escapeHtml(String(codeRaw || ""));
    const frozen = [];

    const freeze = (regex, cls) => {
      text = text.replace(regex, (segment) => {
        const token = `<span class="${cls}">${segment}</span>`;
        const index = frozen.push(token) - 1;
        return `@@HL${index}@@`;
      });
    };

    freeze(/"(?:[^"\n\\]|\\.)*"|'(?:[^'\n\\]|\\.)*'/g, "tok-str");
    if (lang === "js" || lang === "ts" || lang === "rust" || lang === "c" || lang === "cpp") {
      freeze(/\/\*[\s\S]*?\*\//g, "tok-com");
      freeze(/\/\/[^\n]*/g, "tok-com");
    } else if (lang === "py" || lang === "sh") {
      freeze(/#[^\n]*/g, "tok-com");
    }

    text = text.replace(/\b\d+(?:\.\d+)?\b/g, '<span class="tok-num">$&</span>');

    const keywords = getKeywords(lang);
    if (keywords.length) {
      text = text.replace(new RegExp(`\\b(${keywords.join("|")})\\b`, "g"), '<span class="tok-kw">$1</span>');
    }

    const builtins = getBuiltins(lang);
    if (builtins.length) {
      text = text.replace(new RegExp(`\\b(${builtins.join("|")})\\b`, "g"), '<span class="tok-bi">$1</span>');
    }

    return text.replace(/@@HL(\d+)@@/g, (_, index) => frozen[Number(index)] || "");
  }

  function normalizeLang(raw) {
    const lang = String(raw || "").trim().toLowerCase();
    if (!lang) return "plain";
    if (lang === "javascript" || lang === "jsx") return "js";
    if (lang === "typescript" || lang === "tsx") return "ts";
    if (lang === "python") return "py";
    if (lang === "powershell" || lang === "ps1" || lang === "bash" || lang === "shell" || lang === "zsh") return "sh";
    if (lang === "rs") return "rust";
    if (lang === "c++") return "cpp";
    return lang;
  }

  function getKeywords(lang) {
    if (lang === "js" || lang === "ts") return ["const", "let", "var", "function", "return", "if", "else", "for", "while", "switch", "case", "break", "continue", "try", "catch", "finally", "throw", "class", "extends", "new", "import", "from", "export", "default", "async", "await", "typeof", "instanceof", "in", "of", "this"];
    if (lang === "json") return ["true", "false", "null"];
    if (lang === "py") return ["def", "class", "return", "if", "elif", "else", "for", "while", "break", "continue", "try", "except", "finally", "raise", "with", "as", "import", "from", "lambda", "yield", "async", "await", "pass"];
    if (lang === "rust") return ["fn", "let", "mut", "pub", "struct", "enum", "impl", "trait", "match", "if", "else", "loop", "while", "for", "in", "return", "break", "continue", "use", "mod", "crate", "self", "super", "where", "async", "await", "move"];
    if (lang === "sh") return ["if", "then", "else", "fi", "for", "in", "do", "done", "case", "esac", "while", "until", "function"];
    if (lang === "c" || lang === "cpp") return ["int", "char", "float", "double", "void", "if", "else", "for", "while", "switch", "case", "break", "continue", "return", "struct", "class", "public", "private", "protected", "template", "typename", "using", "namespace", "new", "delete", "const", "static", "auto"];
    return [];
  }

  function getBuiltins(lang) {
    if (lang === "js" || lang === "ts") return ["console", "Promise", "Object", "Array", "String", "Number", "Boolean", "Map", "Set", "Date", "Error", "JSON", "Math"];
    if (lang === "py") return ["print", "len", "range", "str", "int", "float", "list", "dict", "set", "tuple", "open", "type", "isinstance"];
    if (lang === "rust") return ["String", "Vec", "Option", "Result", "Some", "None", "Ok", "Err", "println", "format"];
    if (lang === "sh") return ["echo", "cd", "ls", "cat", "grep", "awk", "sed", "export", "source"];
    return [];
  }

  function createRenderer() {
    return {
      escapeHtml,
      renderSessionOptions,
      renderMessages
    };
  }

  globalThisRef.ClawMessageRenderer = {
    createRenderer
  };
})(window);
