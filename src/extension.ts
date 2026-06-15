import * as vscode from 'vscode';
import { randomUUID } from "crypto";
import { runOneShotInner } from "zone/dispatch";
import { loadCliConfig, applyDiskKeyFallbacks } from "zone/config";
import { eventToActions, type EventCtx, type ResolverIntent } from "zone/events";
import { reducer, buildInitialState } from "zone/store-core";
import { resolveCommandApproval } from "zone/approvals";
import type { StoreState, StoreAction } from "zone/store-core";
import type { LlmPatchProgressUpdate, ZoneStructuredProgressEvent } from "zone/lifecycle";

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
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    currentPanel = panel;
    const nonce = getNonce();
    panel.webview.html = getHtml(panel.webview, context.extensionUri, nonce);

    panel.webview.onDidReceiveMessage(
      (message: { type?: string; text?: string }) => {
        if (message.type !== 'prompt' || typeof message.text !== 'string') {
          return;
        }

        const text = message.text.trim();
        if (!text) {
          return;
        }

        void runPrompt(panel, text);
      },
      undefined,
      context.subscriptions,
    );

    panel.onDidDispose(
      () => {
        currentPanel = undefined;
      },
      undefined,
      context.subscriptions,
    );
  });

  context.subscriptions.push(disposable);
}

async function runPrompt(panel: vscode.WebviewPanel, text: string): Promise<void> {
  const repoPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!repoPath) {
    void panel.webview.postMessage({ type: "error", text: "Open a folder first" });
    return;
  }

  const config = loadCliConfig({});
  await applyDiskKeyFallbacks(config);
  config.repoPath = repoPath;
  config.trust = true;

  const settings = vscode.workspace.getConfiguration("zone");
  const apiKey = settings.get<string>("openaiApiKey", "");
  if (apiKey) {
    config.openaiApiKey = apiKey;
    const prov = settings.get<string>("provider", "");
    if (prov) config.provider = prov as typeof config.provider;
    const mdl = settings.get<string>("model", "");
    if (mdl) config.model = mdl;
  }

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
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      height: 100vh;
      overflow: hidden;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
    }

    #app {
      display: flex;
      flex-direction: column;
      height: 100vh;
      min-height: 0;
    }

    #transcript {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 16px;
      white-space: pre-wrap;
      font-family: var(--vscode-font-family);
      font-size: 13px;
      line-height: 1.45;
    }

    .entry {
      margin: 0 0 10px;
    }

    #prompt-bar {
      border-top: 1px solid color-mix(in srgb, var(--vscode-editor-foreground) 18%, transparent);
      padding: 10px;
      background: var(--vscode-editor-background);
    }

    #prompt {
      display: block;
      width: 100%;
      min-height: 44px;
      max-height: 160px;
      resize: vertical;
      border: 1px solid color-mix(in srgb, var(--vscode-editor-foreground) 24%, transparent);
      outline: none;
      padding: 10px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font: 13px/1.4 var(--vscode-font-family);
    }

    #prompt:focus {
      border-color: var(--vscode-focusBorder);
    }
  </style>
</head>
<body>
  <main id="app">
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
