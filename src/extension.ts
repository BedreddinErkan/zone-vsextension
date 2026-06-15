import * as vscode from 'vscode';
import { randomUUID } from "crypto";
import { runOneShotInner } from "zone/dispatch";
import { loadCliConfig, applyDiskKeyFallbacks } from "zone/config";
import type { CliConfig } from "zone/config";
import { eventToActions, type EventCtx, type ResolverIntent } from "zone/events";
import { reducer, buildInitialState } from "zone/store-core";
import { resolveCommandApproval } from "zone/approvals";
import type { StoreState, StoreAction } from "zone/store-core";
import type { LlmPatchProgressUpdate, ZoneStructuredProgressEvent } from "zone/lifecycle";
import { USER_FACING_MODELS, effortLevelsFor, getProviderForModel, type EffortLevel } from "zone/model-registry";

let currentPanel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand('zone.openPanel', () => {
    if (currentPanel) {
      currentPanel.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'zonePanel',
      'Zone',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    currentPanel = panel;
    panel.webview.html = getHtml(panel.webview, context.extensionUri, getNonce());

    panel.webview.onDidReceiveMessage(
      async (message: { type?: string; text?: string; model?: string; effort?: string; provider?: string }) => {
        if (message.type === "prompt" && typeof message.text === "string") {
          const text = message.text.trim();
          if (text) void runPrompt(panel, text, context);
        } else if (message.type === "setKey" && message.provider) {
          const provName = message.provider === "openai" ? "OpenAI" : "Anthropic";
          const v = await vscode.window.showInputBox({
            password: true,
            ignoreFocusOut: true,
            prompt: `Enter ${provName} API key`,
          });
          if (v) await context.secrets.store(`zone.key.${message.provider}`, v);
          void postControls(panel, context);
        } else if (message.type === "setModel" && message.model) {
          await context.workspaceState.update("zone.model", message.model);
          void postControls(panel, context);
        } else if (message.type === "setEffort" && message.effort) {
          await context.workspaceState.update("zone.effort", message.effort);
          void postControls(panel, context);
        }
      },
      undefined,
      context.subscriptions,
    );

    panel.onDidDispose(
      () => { currentPanel = undefined; },
      undefined,
      context.subscriptions,
    );

    void postControls(panel, context);
  });

  context.subscriptions.push(disposable);
}

async function buildRunConfig(
  context: vscode.ExtensionContext,
): Promise<{ config: CliConfig; repoPath: string } | null> {
  const repoPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!repoPath) return null;

  const config = loadCliConfig({});
  await applyDiskKeyFallbacks(config);
  config.repoPath = repoPath;
  config.trust = true;

  const model = context.workspaceState.get<string>("zone.model", "gpt-5.5");
  config.model = model;
  config.provider = getProviderForModel(model) as typeof config.provider;

  const effort = context.workspaceState.get<EffortLevel>("zone.effort");
  if (effort) config.effort = effort;

  if (config.provider === "openai") {
    const secret = await context.secrets.get("zone.key.openai");
    const fallback = vscode.workspace.getConfiguration("zone").get<string>("openaiApiKey", "");
    if (secret || fallback) config.openaiApiKey = secret || fallback;
  } else {
    const secret = await context.secrets.get("zone.key.anthropic");
    if (secret) config.anthropicApiKey = secret;
  }

  return { config, repoPath };
}

async function postControls(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
): Promise<void> {
  const model = context.workspaceState.get<string>("zone.model", "gpt-5.5");
  const effort = context.workspaceState.get<string>("zone.effort") ?? null;
  const provider = getProviderForModel(model);
  const efforts = effortLevelsFor(model);

  let keySet = false;
  if (provider === "openai") {
    const secret = await context.secrets.get("zone.key.openai");
    keySet = !!(secret) || !!(vscode.workspace.getConfiguration("zone").get<string>("openaiApiKey", ""));
  } else {
    keySet = !!(await context.secrets.get("zone.key.anthropic"));
  }

  void panel.webview.postMessage({
    type: "controls",
    controls: {
      model,
      effort,
      provider,
      keySet,
      models: USER_FACING_MODELS.map((m) => ({ id: m.id, displayName: m.displayName, provider: m.provider })),
      efforts,
    },
  });
}

async function runPrompt(
  panel: vscode.WebviewPanel,
  text: string,
  context: vscode.ExtensionContext,
): Promise<void> {
  const built = await buildRunConfig(context);
  if (!built) {
    void panel.webview.postMessage({ type: "error", text: "Open a folder first" });
    return;
  }
  const { config } = built;

  let state: StoreState = buildInitialState({ model: config.model, capUsd: 100 });

  const apply = (action: StoreAction) => {
    state = reducer(state, action);
    void panel.webview.postMessage({ type: "state", state });
  };
  const applyAll = (actions: StoreAction[]) => { for (const a of actions) apply(a); };

  // Narration debounce — ported from useAgentEvents.handleTextEvent
  let localBuffer = "";
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const flushBuffer = () => {
    if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (localBuffer) {
      apply({ type: "TRANSCRIPT_APPEND_NARRATION", text: localBuffer });
      localBuffer = "";
    }
  };

  const handleTextEvent = (evt: ZoneStructuredProgressEvent) => {
    const text = evt.text ?? evt.delta ?? evt.title ?? "";
    if (!text) return;
    localBuffer += text;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      apply({ type: "TRANSCRIPT_APPEND_NARRATION", text: localBuffer });
      localBuffer = "";
      debounceTimer = null;
    }, 200);
  };

  const ctx: EventCtx = { trustedPrefixes: [], mode: "normal" };

  const applyIntents = (intents: ResolverIntent[]) => {
    for (const intent of intents) {
      if (intent.kind === "resolveCommand") {
        resolveCommandApproval({ approvalId: intent.approvalId, runId: intent.runId, approved: intent.approved });
      }
      // resolveRevision is Phase 2 — ignore
    }
  };

  const route = (evt: ZoneStructuredProgressEvent) => {
    const t = evt.type;
    if (t === "narration" || t === "chat_chunk" || t === "chat_response") {
      handleTextEvent(evt);
      return;
    }
    if (
      t === "run_failed" || t === "agent_loop_complete" || t === "run_summary" ||
      t === "tool_call" || t === "phase_changed" ||
      t === "edit_approval_required" || t === "trust_approval_required"
    ) {
      flushBuffer();
      const { actions, intents } = eventToActions(evt, ctx);
      applyIntents(intents);
      applyAll(actions);
      return;
    }
    if (t === "command_approval_required") {
      const { actions, intents } = eventToActions(evt, ctx);
      applyIntents(intents);
      if (actions.length > 0) { flushBuffer(); applyAll(actions); }
      return;
    }
    const { actions, intents } = eventToActions(evt, ctx);
    applyIntents(intents);
    applyAll(actions);
  };

  const onProgress = (update: LlmPatchProgressUpdate) => {
    if (typeof update === "string") return;
    const evt = update.progress;
    if (evt) route(evt);
  };

  apply({ type: "USER_PROMPT", text });

  const ac = new AbortController();
  const runId = randomUUID();
  try {
    await runOneShotInner(text, config, runId, { externalAc: ac, onProgress, mode: "autoAccept" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    route({ runId, ts: Date.now(), type: "narration", title: "run error",
            text: `[zone] run error: ${msg}` } as ZoneStructuredProgressEvent);
  } finally {
    flushBuffer();
    if (!ac.signal.aborted) {
      route({ runId, ts: Date.now(), type: "agent_loop_complete",
              title: "Run ended" } as ZoneStructuredProgressEvent);
    }
  }
}

export function deactivate(): void {
  // noop
}

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri, nonce: string): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'webview.js'));

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <title>Zone</title>
  <style>
    :root {
      --bg: #0c0c10;
      --text: #e5e7eb;
      --muted: #6b7280;
      --border: #1e1e28;
      --font: ui-monospace, "SF Mono", Menlo, monospace;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      height: 100vh;
      overflow: hidden;
      background: var(--bg);
      color: var(--text);
      font-family: var(--font);
      font-size: 13px;
    }

    #app {
      display: flex;
      flex-direction: column;
      height: 100vh;
      min-height: 0;
    }

    /* ── Control bar ─────────────────────────────────── */
    #control-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 12px;
      height: 40px;
      flex-shrink: 0;
      border-bottom: 1px solid var(--border);
    }

    #wordmark {
      background: linear-gradient(90deg,#ec4899,#a855f7,#6366f1,#22d3ee);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.12em;
      user-select: none;
    }

    #controls {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .ctrl { position: relative; }

    .ctrl-btn {
      background: none;
      border: 1px solid var(--border);
      color: var(--text);
      font: 11px/1 var(--font);
      padding: 4px 8px;
      cursor: pointer;
      border-radius: 3px;
      display: flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
    }

    .ctrl-btn:hover { border-color: var(--muted); }

    .ctrl-sub {
      color: var(--muted);
      font-size: 9px;
    }

    /* gradient border on key control when key not set */
    #key-ctrl[data-unset] .ctrl-btn {
      border-color: transparent;
      background:
        linear-gradient(#0c0c10, #0c0c10) padding-box,
        linear-gradient(90deg,#ec4899,#a855f7,#6366f1,#22d3ee) border-box;
    }

    .key-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      border: 1px solid var(--muted);
      flex-shrink: 0;
    }

    .key-dot.is-set {
      background: #a855f7;
      border-color: transparent;
    }

    /* ── Dropdowns ───────────────────────────────────── */
    .dropdown {
      position: absolute;
      top: calc(100% + 4px);
      right: 0;
      background: #12121a;
      border: 1px solid var(--border);
      border-radius: 4px;
      min-width: 160px;
      z-index: 100;
      display: none;
    }

    .dropdown.open { display: block; }

    .dropdown-item {
      padding: 6px 10px;
      font: 11px/1.4 var(--font);
      color: var(--text);
      cursor: pointer;
    }

    .dropdown-item:hover { background: #1e1e28; }

    .dropdown-item.active { color: #a855f7; }

    .dropdown-sep {
      height: 1px;
      background: var(--border);
      margin: 4px 0;
    }

    /* ── Transcript ──────────────────────────────────── */
    #transcript {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 16px;
      white-space: pre-wrap;
      line-height: 1.45;
    }

    .entry { margin: 0 0 10px; }

    /* ── Prompt bar ──────────────────────────────────── */
    #prompt-bar {
      border-top: 1px solid var(--border);
      padding: 10px;
      background: var(--bg);
    }

    #prompt {
      display: block;
      width: 100%;
      min-height: 44px;
      max-height: 160px;
      resize: vertical;
      border: 1px solid var(--border);
      outline: none;
      padding: 10px;
      background: #12121a;
      color: var(--text);
      font: 13px/1.4 var(--font);
    }

    #prompt::placeholder { color: var(--muted); }

    #prompt:focus { border-color: var(--muted); }
  </style>
</head>
<body>
  <main id="app">
    <header id="control-bar">
      <span id="wordmark">zone</span>
      <div id="controls">
        <div class="ctrl" id="model-ctrl">
          <button class="ctrl-btn" id="model-btn" type="button">
            <span id="model-label">…</span>
            <span class="ctrl-sub" id="provider-label"></span>
          </button>
          <div class="dropdown" id="model-dropdown"></div>
        </div>
        <div class="ctrl" id="effort-ctrl" hidden>
          <button class="ctrl-btn" id="effort-btn" type="button">
            <span id="effort-label">effort</span>
          </button>
          <div class="dropdown" id="effort-dropdown"></div>
        </div>
        <div class="ctrl" id="key-ctrl" data-unset="">
          <button class="ctrl-btn" id="key-btn" type="button">
            <span class="key-dot" id="key-dot"></span>
            <span id="key-label">set key</span>
          </button>
        </div>
      </div>
    </header>
    <div id="transcript" aria-live="polite"></div>
    <form id="prompt-bar">
      <textarea id="prompt" rows="2" placeholder="Type a prompt, Enter to send, Shift+Enter for newline"></textarea>
    </form>
  </main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
