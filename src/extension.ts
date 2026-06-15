import * as vscode from 'vscode';
import { randomUUID } from "crypto";
import { runOneShotInner } from "zone/dispatch";
import { loadCliConfig, applyDiskKeyFallbacks } from "zone/config";
import type { CliConfig } from "zone/config";
import { eventToActions, type EventCtx, type ResolverIntent } from "zone/events";
import { reducer, buildInitialState } from "zone/store-core";
import { resolveCommandApproval, resolveEditApproval, resolvePlanApproval, type PlanDecision } from "zone/approvals";
import type { StoreState, StoreAction } from "zone/store-core";
import type { LlmPatchProgressUpdate, ZoneStructuredProgressEvent } from "zone/lifecycle";
import { USER_FACING_MODELS, effortLevelsFor, getProviderForModel, type EffortLevel } from "zone/model-registry";

let currentPanel: vscode.WebviewPanel | undefined;
let currentApply: ((action: StoreAction) => void) | null = null;
let currentState: StoreState | null = null;

type Mode = "default" | "auto" | "plan";
let currentMode: Mode = "default";

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
      async (message: { type?: string; text?: string; model?: string; effort?: string; provider?: string; approvalId?: string; runId?: string; approved?: boolean; kind?: string; mode?: string; planId?: string; decision?: string; feedback?: string }) => {
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
        } else if (message.type === "approveCommand" && message.approvalId && message.runId) {
          if (message.kind === "edit") {
            resolveEditApproval({ approvalId: message.approvalId, runId: message.runId, approved: !!message.approved });
          } else {
            resolveCommandApproval({ approvalId: message.approvalId, runId: message.runId, approved: !!message.approved });
          }
          currentApply?.({ type: "PENDING_APPROVAL_RESOLVED" });
        } else if (message.type === "setMode" && message.mode) {
          currentMode = message.mode as Mode;
          void postControls(panel, context);
        } else if (message.type === "planDecision" && message.planId && message.runId && message.decision) {
          resolvePlanApproval({
            planId: message.planId,
            runId: message.runId,
            decision: message.decision as PlanDecision,
            ...(message.feedback ? { feedback: message.feedback } : {}),
          });
          currentApply?.({ type: "PLAN_READY_RESOLVED" });
        }
      },
      undefined,
      context.subscriptions,
    );

    panel.onDidDispose(
      () => { currentPanel = undefined; currentState = null; },
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
      mode: currentMode,
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

  if (!currentState) {
    currentState = buildInitialState({ model: config.model, capUsd: 100 });
  }

  const apply = (action: StoreAction) => {
    currentState = reducer(currentState!, action);
    void panel.webview.postMessage({ type: "state", state: currentState });
  };
  currentApply = apply;
  const applyAll = (actions: StoreAction[]) => { for (const a of actions) apply(a); };

  // Clear lingering transients from a prior aborted run (no-ops if run ended cleanly)
  if (currentState.spinner) apply({ type: "SPINNER_STOP" });
  if (currentState.pendingApproval) apply({ type: "PENDING_APPROVAL_RESOLVED" });
  if (currentState.planReadyProposal) apply({ type: "PLAN_READY_RESOLVED" });

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
      t === "edit_approval_required" || t === "trust_approval_required" ||
      t === "plan_ready_for_approval"
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
  apply({ type: "SPINNER_START", label: "Starting…" });

  const ac = new AbortController();
  const runId = randomUUID();
  try {
    await runOneShotInner(text, config, runId, {
      externalAc: ac,
      onProgress,
      mode: currentMode === "plan" ? "plan" : currentMode === "auto" ? "autoAccept" : "normal",
      editApprovalMode: currentMode === "default" ? "manual" : "auto",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    route({ runId, ts: Date.now(), type: "narration", title: "run error",
            text: `[zone] run error: ${msg}` } as ZoneStructuredProgressEvent);
  } finally {
    flushBuffer();
    currentApply = null;
    apply({ type: "SPINNER_STOP" });
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

    .entry { margin: 0 0 6px; }

    /* User prompt */
    .entry-user {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin: 14px 0 8px;
      padding-left: 10px;
      border-left: 3px solid #a855f7;
    }
    .entry-user-marker { color: #a855f7; flex-shrink: 0; font-size: 11px; }
    .entry-user-text   { color: #e5e7eb; font-weight: 500; }

    /* Narration */
    .entry-narration { display: flex; gap: 8px; }
    .entry-narration-dot { color: var(--muted); font-size: 8px; flex-shrink: 0; padding-top: 4px; }

    /* Thinking */
    .entry-thinking { color: var(--muted); font-style: italic; }

    /* Assistant final */
    .entry-assistant-final {
      padding-top: 8px;
      margin-top: 2px;
      border-top: 1px solid var(--border);
    }

    /* Tool call block */
    .entry-tool {
      background: #12121a;
      border: 1px solid var(--border);
      border-radius: 3px;
      overflow: hidden;
      margin-bottom: 8px;
    }
    .entry-tool-header {
      display: flex;
      align-items: baseline;
      gap: 6px;
      padding: 5px 10px;
      font-size: 12px;
      border-bottom: 1px solid var(--border);
      overflow: hidden;
    }
    .entry-tool-glyph { color: #a855f7; flex-shrink: 0; }
    .entry-tool-name  { color: var(--text); flex-shrink: 0; }
    .entry-tool-args  {
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .entry-tool-result {
      display: flex;
      gap: 6px;
      padding: 3px 10px;
      font-size: 12px;
      color: var(--muted);
      white-space: pre-wrap;
    }
    .result-icon { flex-shrink: 0; }
    .entry-tool-result.ok   .result-icon { color: #22d3ee; }
    .entry-tool-result.fail .result-icon { color: #f87171; }
    .entry-tool-more {
      padding: 2px 10px 5px;
      font-size: 11px;
      color: var(--muted);
      font-style: italic;
    }

    /* Error */
    .entry-error { color: #f87171; }

    /* Phase marker */
    .entry-phase {
      color: var(--muted);
      font-size: 11px;
      letter-spacing: 0.05em;
      margin: 8px 0 4px;
      opacity: 0.7;
    }

    /* ── Mode pill ───────────────────────────────────── */
    #mode-btn[data-mode="plan"] {
      border-color: #6366f1;
      color: #818cf8;
    }

    #mode-btn[data-mode="auto"] {
      border-color: #22d3ee;
      color: #22d3ee;
    }

    /* ── Diff view (edit approval) ───────────────────── */
    #approval-diff {
      display: none;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 3px;
      padding: 4px 0;
      margin-bottom: 8px;
      max-height: 180px;
      overflow-y: auto;
    }
    .diff-line {
      font: 11px/1.5 var(--font);
      padding: 0 10px;
      white-space: pre;
    }
    .diff-removed { color: #f87171; }
    .diff-added   { color: #4ade80; }
    .diff-sep     { font: 11px/1.5 var(--font); padding: 0 10px; color: var(--muted); }
    .diff-overflow { font: 11px/1.4 var(--font); padding: 0 10px; color: var(--muted); font-style: italic; }

    /* ── Plan-ready panel ────────────────────────────── */
    #plan-ready {
      flex-shrink: 0;
      border-top: 1px solid var(--border);
      background: #12121a;
      padding: 12px;
      display: none;
      max-height: 50vh;
      overflow-y: auto;
    }

    #plan-ready-header {
      font-size: 11px;
      font-weight: 600;
      color: #818cf8;
      letter-spacing: 0.08em;
      margin-bottom: 6px;
    }

    #plan-ready-objective {
      color: var(--text);
      margin-bottom: 8px;
      font-weight: 500;
    }

    #plan-ready-steps {
      list-style: none;
      padding: 0;
      margin: 0 0 8px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .plan-step {
      display: flex;
      gap: 8px;
      font-size: 12px;
    }

    .plan-step-num   { color: #6366f1; flex-shrink: 0; }
    .plan-step-title { color: var(--text); }
    .plan-step-desc  { color: var(--muted); }

    #plan-ready-scope {
      font-size: 11px;
      color: var(--muted);
      font-style: italic;
      margin-bottom: 8px;
    }

    #plan-feedback {
      display: block;
      width: 100%;
      min-height: 40px;
      max-height: 80px;
      resize: vertical;
      border: 1px solid var(--border);
      outline: none;
      padding: 6px 8px;
      background: var(--bg);
      color: var(--text);
      font: 12px/1.4 var(--font);
      border-radius: 2px;
      margin-bottom: 8px;
    }

    #plan-feedback::placeholder { color: var(--muted); }
    #plan-feedback:focus { border-color: var(--muted); }

    #plan-ready-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .plan-btn {
      font: 11px/1 var(--font);
      padding: 5px 10px;
      border-radius: 3px;
      cursor: pointer;
      border: 1px solid var(--border);
      background: none;
      color: var(--text);
    }
    .plan-btn:hover { border-color: var(--muted); }
    .plan-btn.primary {
      background: linear-gradient(90deg,#6366f1,#a855f7);
      border-color: transparent;
      color: #fff;
      font-weight: 600;
    }
    .plan-btn.primary:hover { filter: brightness(1.12); }
    .plan-btn.danger { color: var(--muted); }
    .plan-btn.danger:hover { color: #f87171; border-color: #f87171; }

    /* ── Status strip ────────────────────────────────── */
    #status-strip {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 12px;
      height: 24px;
      flex-shrink: 0;
      border-top: 1px solid var(--border);
      background: var(--bg);
      font-size: 12px;
      color: var(--muted);
    }

    #spinner-area {
      display: none;
      align-items: center;
      gap: 6px;
    }

    #spinner-area.active { display: flex; }

    #spinner-label { color: #e5e7eb; }

    #spinner-glyph {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: conic-gradient(from 0deg, #ec4899, #a855f7, #6366f1, #22d3ee, #ec4899);
      -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 0);
      mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 0);
      animation: spin 0.7s linear infinite;
      flex-shrink: 0;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

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

    /* ── Approval prompt ─────────────────────────────────── */
    #approval-prompt {
      flex-shrink: 0;
      border-top: 1px solid var(--border);
      background: #12121a;
      padding: 10px 12px;
      display: none;
    }

    #approval-label {
      font-size: 11px;
      color: #f59e0b;
      font-weight: 600;
      letter-spacing: 0.05em;
      margin-bottom: 6px;
      display: block;
    }

    #approval-command {
      display: block;
      background: var(--bg);
      border: 1px solid var(--border);
      padding: 8px 10px;
      font: 12px/1.4 var(--font);
      color: var(--text);
      border-radius: 3px;
      white-space: pre-wrap;
      word-break: break-all;
      margin-bottom: 8px;
    }

    #approval-actions { display: flex; gap: 8px; }

    #approval-approve {
      background: linear-gradient(90deg,#6366f1,#a855f7);
      border: none;
      color: #fff;
      font: 11px/1 var(--font);
      font-weight: 600;
      padding: 5px 14px;
      border-radius: 3px;
      cursor: pointer;
    }
    #approval-approve:hover { filter: brightness(1.15); }

    #approval-deny {
      background: none;
      border: 1px solid var(--border);
      color: var(--muted);
      font: 11px/1 var(--font);
      padding: 5px 14px;
      border-radius: 3px;
      cursor: pointer;
    }
    #approval-deny:hover { border-color: var(--muted); color: var(--text); }
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
        <div class="ctrl" id="mode-ctrl">
          <button class="ctrl-btn" id="mode-btn" type="button" data-mode="auto">
            <span id="mode-label">auto</span>
          </button>
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
    <div id="status-strip">
      <span id="spinner-area">
        <span id="spinner-glyph"></span>
        <span id="spinner-label"></span>
      </span>
      <span id="status-text"></span>
    </div>
    <div id="plan-ready">
      <div id="plan-ready-header">⬡ Plan ready</div>
      <div id="plan-ready-objective"></div>
      <ol id="plan-ready-steps"></ol>
      <div id="plan-ready-scope" hidden></div>
      <textarea id="plan-feedback" placeholder="Feedback (for options 3 + 4)…"></textarea>
      <div id="plan-ready-actions">
        <button type="button" class="plan-btn primary" id="plan-btn-accept">auto-accept all</button>
        <button type="button" class="plan-btn" id="plan-btn-manual">manually approve</button>
        <button type="button" class="plan-btn" id="plan-btn-feedback">give feedback</button>
        <button type="button" class="plan-btn" id="plan-btn-feedback-run">feedback+run</button>
        <button type="button" class="plan-btn danger" id="plan-btn-reject">cancel [Esc]</button>
      </div>
    </div>
    <div id="approval-prompt">
      <span id="approval-label">⚠ Approve command?</span>
      <code id="approval-command"></code>
      <div id="approval-diff"></div>
      <div id="approval-actions">
        <button type="button" id="approval-approve">Approve  [Enter]</button>
        <button type="button" id="approval-deny">Deny  [Esc]</button>
      </div>
    </div>
    <form id="prompt-bar">
      <textarea id="prompt" rows="2" placeholder="Type a prompt · Enter to send · Shift+Enter newline"></textarea>
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
