type TranscriptRole = 'user' | 'system';

type AppendTranscriptMessage = {
  type: 'appendTranscript';
  role: TranscriptRole;
  text: string;
};

type NarrationMessage = {
  type: 'narration';
  text: string;
};

type VsCodeApi = {
  postMessage(message: { type: 'prompt'; text: string }): void;
};

declare const acquireVsCodeApi: () => VsCodeApi;

const vscode = acquireVsCodeApi();
const transcriptElement = document.querySelector<HTMLDivElement>('#transcript') as HTMLDivElement;
const form = document.querySelector<HTMLFormElement>('#prompt-bar');
const promptInput = document.querySelector<HTMLTextAreaElement>('#prompt') as HTMLTextAreaElement;

if (!transcriptElement || !form || !promptInput) {
  throw new Error('Zone webview failed to initialize');
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  sendPrompt();
});

promptInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendPrompt();
  }
});

window.addEventListener('message', (event: MessageEvent<AppendTranscriptMessage | NarrationMessage>) => {
  const message = event.data;
  if (message.type === 'appendTranscript') {
    appendTranscript(message.role, message.text);
    return;
  }

  if (message.type === 'narration') {
    appendTranscript('system', message.text);
  }
});

appendTranscript('system', 'Zone shell ready.');

function sendPrompt(): void {
  const text = promptInput.value.trim();
  if (!text) {
    return;
  }

  vscode.postMessage({ type: 'prompt', text });
  promptInput.value = '';
}

function appendTranscript(role: TranscriptRole, text: string): void {
  const entry = document.createElement('div');
  entry.className = 'entry';

  const roleNode = document.createElement('span');
  roleNode.className = 'role';
  roleNode.textContent = `${role}> `;

  const textNode = document.createElement('span');
  textNode.textContent = text;

  entry.append(roleNode, textNode);
  transcriptElement.append(entry);
  transcriptElement.scrollTop = transcriptElement.scrollHeight;
}
