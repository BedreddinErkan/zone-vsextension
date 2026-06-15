import * as vscode from 'vscode';
// @ts-ignore zone's local file dependency does not publish declaration files yet.
import { runLlmPatchFlow } from 'zone/flow';

type FlowProgressUpdate = string | {
  stage?: string;
  [key: string]: unknown;
};

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

        void panel.webview.postMessage({ type: 'appendTranscript', role: 'user', text });
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
    void panel.webview.postMessage({ type: 'narration', text: 'Open a folder in this window first' });
    return;
  }

  const config = vscode.workspace.getConfiguration('zone');
  const apiKey = config.get<string>('openaiApiKey', '');
  const provider = config.get<string>('provider', 'openai');
  const controller = new AbortController();

  try {
    await runLlmPatchFlow({
      task: text,
      repoPath,
      provider,
      userApiKey: apiKey,
      onProgress: (update: FlowProgressUpdate) => {
        void panel.webview.postMessage({
          type: 'narration',
          text: typeof update === 'string' ? update : (update.stage ?? JSON.stringify(update)),
        });
      },
      abortSignal: controller.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void panel.webview.postMessage({ type: 'narration', text: `Error: ${message}` });
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

    .role {
      opacity: 0.7;
      text-transform: uppercase;
      letter-spacing: 0.04em;
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
