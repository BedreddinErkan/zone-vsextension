type TranscriptEntry =
  | { kind: "narration"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "assistant_final"; text: string }
  | { kind: "tool_call"; toolName: string; args: string; patch?: string; results: { ok: boolean; detail: string }[] }
  | { kind: "error"; text: string }
  | { kind: "phase_marker"; phase: string }
  | { kind: "user_prompt"; text: string }
  | { kind: "post_execute_diffs"; files: unknown[] };

type StatusBar = {
  costUsd: number;
  cumulativeTokens: number;
};

type StoreState = {
  transcript: TranscriptEntry[];
  statusBar: StatusBar;
  spinner: { active: boolean; label: string } | null;
  pendingApproval: { approvalId: string; runId: string; command: string; kind?: string } | null;
};

type Controls = {
  model: string;
  effort: string | null;
  provider: "openai" | "anthropic";
  keySet: boolean;
  models: { id: string; displayName: string; provider: "openai" | "anthropic" }[];
  efforts: string[];
};

type StateMessage = { type: "state"; state: StoreState };
type ControlsMessage = { type: "controls"; controls: Controls };

type VsCodeApi = {
  postMessage(message:
    | { type: "prompt"; text: string }
    | { type: "setKey"; provider: string }
    | { type: "setModel"; model: string }
    | { type: "setEffort"; effort: string }
    | { type: "approveCommand"; approvalId: string; runId: string; approved: boolean }
  ): void;
};

declare const acquireVsCodeApi: () => VsCodeApi;

const vscode = acquireVsCodeApi();
const transcriptEl = document.querySelector<HTMLDivElement>("#transcript") as HTMLDivElement;
const promptInput = document.querySelector<HTMLTextAreaElement>("#prompt") as HTMLTextAreaElement;
const modelBtn = document.querySelector<HTMLButtonElement>("#model-btn") as HTMLButtonElement;
const modelLabel = document.querySelector<HTMLSpanElement>("#model-label") as HTMLSpanElement;
const providerLabel = document.querySelector<HTMLSpanElement>("#provider-label") as HTMLSpanElement;
const effortCtrl = document.querySelector<HTMLDivElement>("#effort-ctrl") as HTMLDivElement;
const effortBtn = document.querySelector<HTMLButtonElement>("#effort-btn") as HTMLButtonElement;
const effortLabel = document.querySelector<HTMLSpanElement>("#effort-label") as HTMLSpanElement;
const keyCtrl = document.querySelector<HTMLDivElement>("#key-ctrl") as HTMLDivElement;
const keyBtn = document.querySelector<HTMLButtonElement>("#key-btn") as HTMLButtonElement;
const keyDot = document.querySelector<HTMLSpanElement>("#key-dot") as HTMLSpanElement;
const keyLabel = document.querySelector<HTMLSpanElement>("#key-label") as HTMLSpanElement;
const modelDropdown = document.querySelector<HTMLDivElement>("#model-dropdown") as HTMLDivElement;
const effortDropdown = document.querySelector<HTMLDivElement>("#effort-dropdown") as HTMLDivElement;
const spinnerArea  = document.querySelector<HTMLSpanElement>("#spinner-area")  as HTMLSpanElement;
const spinnerLabel = document.querySelector<HTMLSpanElement>("#spinner-label") as HTMLSpanElement;
const statusText   = document.querySelector<HTMLSpanElement>("#status-text")   as HTMLSpanElement;
const approvalPrompt     = document.querySelector<HTMLDivElement>("#approval-prompt")      as HTMLDivElement;
const approvalCommandEl  = document.querySelector<HTMLElement>("#approval-command")        as HTMLElement;
const approvalApproveBtn = document.querySelector<HTMLButtonElement>("#approval-approve") as HTMLButtonElement;
const approvalDenyBtn    = document.querySelector<HTMLButtonElement>("#approval-deny")    as HTMLButtonElement;

if (!transcriptEl || !promptInput) {
  throw new Error("Zone webview failed to initialize");
}

// ── Dropdown state ────────────────────────────────────────────────────────────

let activeDropdown: HTMLDivElement | null = null;
let currentControls: Controls | null = null;
let currentPending: { approvalId: string; runId: string; command: string } | null = null;

function toggleDropdown(dd: HTMLDivElement): void {
  if (activeDropdown && activeDropdown !== dd) activeDropdown.classList.remove("open");
  dd.classList.toggle("open");
  activeDropdown = dd.classList.contains("open") ? dd : null;
}

document.addEventListener("click", (e) => {
  if (!activeDropdown) return;
  if (!activeDropdown.parentElement?.contains(e.target as Node)) {
    activeDropdown.classList.remove("open");
    activeDropdown = null;
  }
});

// ── Button wiring ─────────────────────────────────────────────────────────────

modelBtn.addEventListener("click", () => toggleDropdown(modelDropdown));
effortBtn.addEventListener("click", () => toggleDropdown(effortDropdown));
keyBtn.addEventListener("click", () => {
  if (activeDropdown) { activeDropdown.classList.remove("open"); activeDropdown = null; }
  vscode.postMessage({ type: "setKey", provider: currentControls?.provider ?? "openai" });
});

approvalApproveBtn.addEventListener("click", () => {
  if (!currentPending) return;
  vscode.postMessage({ type: "approveCommand", approvalId: currentPending.approvalId, runId: currentPending.runId, approved: true });
});
approvalDenyBtn.addEventListener("click", () => {
  if (!currentPending) return;
  vscode.postMessage({ type: "approveCommand", approvalId: currentPending.approvalId, runId: currentPending.runId, approved: false });
});
document.addEventListener("keydown", (e) => {
  if (!currentPending) return;
  if (e.key === "Escape") {
    vscode.postMessage({ type: "approveCommand", approvalId: currentPending.approvalId, runId: currentPending.runId, approved: false });
  } else if (e.key === "Enter" && !e.shiftKey && document.activeElement !== promptInput) {
    e.preventDefault();
    vscode.postMessage({ type: "approveCommand", approvalId: currentPending.approvalId, runId: currentPending.runId, approved: true });
  }
});

promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    const text = promptInput.value.trim();
    if (!text) return;
    vscode.postMessage({ type: "prompt", text });
    promptInput.value = "";
  }
});

// ── Message handler ───────────────────────────────────────────────────────────

window.addEventListener("message", (event: MessageEvent<StateMessage | ControlsMessage>) => {
  const msg = event.data;
  if (msg.type === "state") { renderState(msg.state); return; }
  if (msg.type === "controls") { renderControls(msg.controls); }
});

// ── Controls renderer ─────────────────────────────────────────────────────────

function renderControls(c: Controls): void {
  currentControls = c;
  if (activeDropdown) { activeDropdown.classList.remove("open"); activeDropdown = null; }

  modelLabel.textContent = c.model;
  providerLabel.textContent = c.provider;

  effortCtrl.hidden = c.efforts.length === 0;
  effortLabel.textContent = `effort: ${c.effort ?? c.efforts[0] ?? "—"}`;

  if (!c.keySet) {
    keyCtrl.setAttribute("data-unset", "");
  } else {
    keyCtrl.removeAttribute("data-unset");
  }
  keyDot.className = c.keySet ? "key-dot is-set" : "key-dot";
  keyLabel.textContent = c.keySet ? "key set" : "set key";

  // Rebuild model dropdown grouped by provider
  modelDropdown.innerHTML = "";
  let firstGroup = true;
  for (const prov of ["openai", "anthropic"] as const) {
    const group = c.models.filter((m) => m.provider === prov);
    if (!group.length) continue;
    if (!firstGroup) {
      const sep = document.createElement("div");
      sep.className = "dropdown-sep";
      modelDropdown.append(sep);
    }
    firstGroup = false;
    for (const m of group) {
      const item = document.createElement("div");
      item.className = `dropdown-item${m.id === c.model ? " active" : ""}`;
      item.textContent = m.displayName;
      item.addEventListener("click", () => {
        modelDropdown.classList.remove("open");
        activeDropdown = null;
        vscode.postMessage({ type: "setModel", model: m.id });
      });
      modelDropdown.append(item);
    }
  }

  // Rebuild effort dropdown
  effortDropdown.innerHTML = "";
  const activeEffort = c.effort ?? c.efforts[0];
  for (const lvl of c.efforts) {
    const item = document.createElement("div");
    item.className = `dropdown-item${lvl === activeEffort ? " active" : ""}`;
    item.textContent = lvl;
    item.addEventListener("click", () => {
      effortDropdown.classList.remove("open");
      activeDropdown = null;
      vscode.postMessage({ type: "setEffort", effort: lvl });
    });
    effortDropdown.append(item);
  }
}

// ── Transcript renderer ───────────────────────────────────────────────────────

function formatStatus(sb: StatusBar): string {
  const parts: string[] = [];
  if (sb.costUsd > 0)
    parts.push(`<span style="color:#22d3ee">$${sb.costUsd.toFixed(4)}</span>`);
  if (sb.cumulativeTokens > 0)
    parts.push(`<span style="color:#a855f7">${(sb.cumulativeTokens / 1000).toFixed(1)}k</span> tok`);
  return parts.join(" · ");
}

function renderState(state: StoreState): void {
  transcriptEl.textContent = "";
  for (const entry of state.transcript) {
    renderEntry(entry);
  }
  transcriptEl.scrollTop = transcriptEl.scrollHeight;

  if (state.spinner) {
    spinnerArea.classList.add("active");
    spinnerLabel.textContent = state.spinner.label;
  } else {
    spinnerArea.classList.remove("active");
  }

  statusText.innerHTML = formatStatus(state.statusBar);

  currentPending = state.pendingApproval ?? null;
  if (state.pendingApproval) {
    approvalCommandEl.textContent = state.pendingApproval.command;
    approvalPrompt.style.display = "block";
  } else {
    approvalPrompt.style.display = "none";
  }
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
