type TranscriptEntry =
  | { kind: "narration"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "assistant_final"; text: string }
  | { kind: "tool_call"; toolName: string; args: string; patch?: string; results: { ok: boolean; detail: string }[] }
  | { kind: "error"; text: string }
  | { kind: "phase_marker"; phase: string }
  | { kind: "user_prompt"; text: string }
  | { kind: "post_execute_diffs"; files: unknown[] };

type StoreState = {
  transcript: TranscriptEntry[];
};

type StateMessage = { type: "state"; state: StoreState };

type VsCodeApi = {
  postMessage(message: { type: "prompt"; text: string }): void;
};

declare const acquireVsCodeApi: () => VsCodeApi;

const vscode = acquireVsCodeApi();
const transcriptEl = document.querySelector<HTMLDivElement>("#transcript") as HTMLDivElement;
const promptInput = document.querySelector<HTMLTextAreaElement>("#prompt") as HTMLTextAreaElement;

if (!transcriptEl || !promptInput) {
  throw new Error("Zone webview failed to initialize");
}

promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    const text = promptInput.value.trim();
    if (!text) return;
    vscode.postMessage({ type: "prompt", text });
    promptInput.value = "";
  }
});

window.addEventListener("message", (event: MessageEvent<StateMessage>) => {
  const msg = event.data;
  if (msg.type !== "state") return;
  renderState(msg.state);
});

function renderState(state: StoreState): void {
  transcriptEl.textContent = "";
  for (const entry of state.transcript) {
    renderEntry(entry);
  }
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function appendDiv(text: string): void {
  const div = document.createElement("div");
  div.className = "entry";
  div.textContent = text;
  transcriptEl.append(div);
}

function renderEntry(entry: TranscriptEntry): void {
  switch (entry.kind) {
    case "narration":
    case "thinking":
    case "assistant_final":
      appendDiv(entry.text);
      break;
    case "tool_call":
      appendDiv(`[tool: ${entry.toolName}] ${entry.args}`);
      for (const result of entry.results) {
        appendDiv(result.detail);
      }
      break;
    case "error":
      appendDiv(`[error] ${entry.text}`);
      break;
    case "phase_marker":
      appendDiv(`[phase] ${entry.phase}`);
      break;
    case "user_prompt":
      appendDiv(`> ${entry.text}`);
      break;
    case "post_execute_diffs":
      // Phase 1b
      break;
  }
}
