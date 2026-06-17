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
  planReadyProposal: {
    planId: string;
    runId: string;
    objective: string;
    steps: Array<{ title: string; description: string; filesLikely: string[]; subagentEligible?: boolean }>;
    scopeNotes?: string;
  } | null;
  liveTail?: { currentToolCall?: { patch?: string } | null } | null;
};

type Controls = {
  mode: "default" | "auto" | "plan";
  webSearchEnabled: boolean;
  model: string;
  effort: string | null;
  provider: "openai" | "anthropic";
  keySet: boolean;
  models: { id: string; displayName: string; provider: "openai" | "anthropic" }[];
  efforts: string[];
  undoable: boolean;
  dailyCap: number;
};

type StateMessage = { type: "state"; state: StoreState };
type ControlsMessage = { type: "controls"; controls: Controls };

type VsCodeApi = {
  postMessage(message:
    | { type: "prompt"; text: string; images?: { mediaType: string; base64: string }[] }
    | { type: "setKey"; provider: string }
    | { type: "setModel"; model: string }
    | { type: "setEffort"; effort: string }
    | { type: "approveCommand"; approvalId: string; runId: string; approved: boolean; kind?: string }
    | { type: "setMode"; mode: "default" | "auto" | "plan" }
    | { type: "toggleWebSearch" }
    | { type: "planDecision"; planId: string; runId: string; decision: string; feedback?: string }
    | { type: "abort" }
    | { type: "slashCommand"; command: string; args: string }
    | { type: "undo" }
    | { type: "setDailyCap" }
  ): void;
};

declare const acquireVsCodeApi: () => VsCodeApi;

const DIFF_TOOLS = new Set(["apply_patch", "write_file", "multi_edit"]);
const WRITE_FILE_PREVIEW_LINES = 7;

// Slash-command registry — name → description (description is for the future
// autocomplete dropdown; not rendered this increment). Append future commands here.
const SLASH_COMMANDS: Record<string, string> = {
  memory: "Show .zone/memory.md",
  init: "Scaffold .zone/memory.md by analyzing the repo",
  feedback: "Send a bug report / feedback to the maintainer",
  undo: "Undo the last run (restore files to pre-run state)",
  limits: "Set a daily USD spending cap",
  metrics: "Show run + session usage (cost, tokens, iterations)",
};

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
const stopBar      = document.querySelector<HTMLDivElement>("#stop-bar")       as HTMLDivElement;
const stopBtn      = document.querySelector<HTMLButtonElement>("#stop-btn")    as HTMLButtonElement;
const undoBtn      = document.querySelector<HTMLButtonElement>("#undo-btn")    as HTMLButtonElement;
const attachBtn    = document.querySelector<HTMLButtonElement>("#attach-btn")  as HTMLButtonElement;
const attachInput  = document.querySelector<HTMLInputElement>("#attach-input") as HTMLInputElement;
const stageChips   = document.querySelector<HTMLDivElement>("#stage-chips")    as HTMLDivElement;
const statusText   = document.querySelector<HTMLSpanElement>("#status-text")   as HTMLSpanElement;
const approvalPrompt     = document.querySelector<HTMLDivElement>("#approval-prompt")      as HTMLDivElement;
const approvalCommandEl  = document.querySelector<HTMLElement>("#approval-command")        as HTMLElement;
const approvalApproveBtn = document.querySelector<HTMLButtonElement>("#approval-approve") as HTMLButtonElement;
const approvalDenyBtn    = document.querySelector<HTMLButtonElement>("#approval-deny")    as HTMLButtonElement;
const approvalLabel      = document.querySelector<HTMLSpanElement>("#approval-label")     as HTMLSpanElement;
const approvalDiffEl     = document.querySelector<HTMLDivElement>("#approval-diff")       as HTMLDivElement;
const modeBtn        = document.querySelector<HTMLButtonElement>("#mode-btn")          as HTMLButtonElement;
const modeLabel      = document.querySelector<HTMLSpanElement>("#mode-label")          as HTMLSpanElement;
const websearchBtn   = document.querySelector<HTMLButtonElement>("#websearch-btn")     as HTMLButtonElement;
const websearchLabel = document.querySelector<HTMLSpanElement>("#websearch-label")     as HTMLSpanElement;
const capBtn         = document.querySelector<HTMLButtonElement>("#cap-btn")           as HTMLButtonElement;
const capLabel       = document.querySelector<HTMLSpanElement>("#cap-label")           as HTMLSpanElement;
const planReadyEl    = document.querySelector<HTMLDivElement>("#plan-ready")           as HTMLDivElement;
const planObjEl      = document.querySelector<HTMLDivElement>("#plan-ready-objective") as HTMLDivElement;
const planStepsEl    = document.querySelector<HTMLOListElement>("#plan-ready-steps")   as HTMLOListElement;
const planScopeEl    = document.querySelector<HTMLDivElement>("#plan-ready-scope")     as HTMLDivElement;
const planFeedbackEl = document.querySelector<HTMLTextAreaElement>("#plan-feedback")   as HTMLTextAreaElement;
const planBtnAccept    = document.querySelector<HTMLButtonElement>("#plan-btn-accept")       as HTMLButtonElement;
const planBtnManual    = document.querySelector<HTMLButtonElement>("#plan-btn-manual")       as HTMLButtonElement;
const planBtnFeedback  = document.querySelector<HTMLButtonElement>("#plan-btn-feedback")     as HTMLButtonElement;
const planBtnFbRun     = document.querySelector<HTMLButtonElement>("#plan-btn-feedback-run") as HTMLButtonElement;
const planBtnReject    = document.querySelector<HTMLButtonElement>("#plan-btn-reject")       as HTMLButtonElement;

if (!transcriptEl || !promptInput) {
  throw new Error("Zone webview failed to initialize");
}

stopBtn.addEventListener("click", () => {
  if (stopBtn.disabled) return;
  stopBtn.disabled = true;
  stopBtn.textContent = "stopping…";
  vscode.postMessage({ type: "abort" });
});

undoBtn.addEventListener("click", () => {
  vscode.postMessage({ type: "undo" });
});

// ── Image staging helpers ─────────────────────────────────────────────────────

const ALLOWED_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

function showAttachError(msg: string): void {
  const el = document.createElement("span");
  el.className = "attach-error";
  el.textContent = msg;
  stageChips.append(el);
  setTimeout(() => el.remove(), 3000);
}

function renderChips(): void {
  stageChips.textContent = "";
  stagedImages.forEach((img, i) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = img.label;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "chip-remove";
    rm.textContent = "×";
    rm.addEventListener("click", () => { stagedImages.splice(i, 1); renderChips(); });
    chip.append(rm);
    stageChips.append(chip);
  });
}

function addImage(base64: string, mediaType: string, label: string, thumb: string): void {
  if (!ALLOWED_MEDIA_TYPES.includes(mediaType)) { showAttachError("Unsupported image type"); return; }
  if (stagedImages.length >= 4) { showAttachError("Too many images (max 4)"); return; }
  const byteLen = Math.ceil(base64.length * 3 / 4);
  if (byteLen > 5 * 1024 * 1024) { showAttachError("Image exceeds 5 MB limit"); return; }
  const totalBytes = stagedImages.reduce((sum, img) => sum + Math.ceil(img.base64.length * 3 / 4), 0);
  if (totalBytes + byteLen > 16 * 1024 * 1024) { showAttachError("Total images exceed 16 MB limit"); return; }
  stagedImages.push({ mediaType, base64, label, thumb });
  renderChips();
}

function readFileAsImage(file: File, label: string): void {
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    const dataUrl = reader.result as string;
    const commaIdx = dataUrl.indexOf(",");
    const base64 = dataUrl.slice(commaIdx + 1);
    const mediaType = dataUrl.slice(5, commaIdx).split(";")[0];
    const img = new Image();
    img.onload = () => {
      const MAX = 128;
      const scale = Math.min(1, MAX / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round((img.naturalWidth || 1) * scale);
      canvas.height = Math.round((img.naturalHeight || 1) * scale);
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      addImage(base64, mediaType, label, canvas.toDataURL("image/jpeg", 0.7));
    };
    img.onerror = () => {
      // Canvas decode failed — fall back to the full data URL as the thumbnail
      addImage(base64, mediaType, label, dataUrl);
    };
    img.src = dataUrl;
  });
  reader.readAsDataURL(file);
}

attachBtn.addEventListener("click", () => { attachInput.value = ""; attachInput.click(); });

attachInput.addEventListener("change", () => {
  for (const file of Array.from(attachInput.files ?? [])) {
    readFileAsImage(file, file.name);
  }
  attachInput.value = "";
});

promptInput.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of Array.from(items)) {
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) readFileAsImage(file, "pasted image");
    }
  }
});

// ── Dropdown state ────────────────────────────────────────────────────────────

let activeDropdown: HTMLDivElement | null = null;
let stagedImages: { mediaType: string; base64: string; label: string; thumb: string }[] = [];
let lastTranscriptLen = 0;
const thumbnailsByTranscriptIdx = new Map<number, string[]>();
let currentControls: Controls | null = null;
let currentPending: { approvalId: string; runId: string; command: string; kind?: string } | null = null;
let currentMode: "default" | "auto" | "plan" = "default";
let currentPlanReady: { planId: string; runId: string } | null = null;
let spinnerActive = false;

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
  vscode.postMessage({ type: "approveCommand", approvalId: currentPending.approvalId, runId: currentPending.runId, approved: true, kind: currentPending.kind });
});
approvalDenyBtn.addEventListener("click", () => {
  if (!currentPending) return;
  vscode.postMessage({ type: "approveCommand", approvalId: currentPending.approvalId, runId: currentPending.runId, approved: false, kind: currentPending.kind });
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (currentPending) {
      vscode.postMessage({ type: "approveCommand", approvalId: currentPending.approvalId, runId: currentPending.runId, approved: false, kind: currentPending.kind });
    } else if (currentPlanReady) {
      sendPlanDecision("reject");
    }
  } else if (e.key === "Enter" && !e.shiftKey && document.activeElement !== promptInput) {
    if (currentPending) {
      e.preventDefault();
      vscode.postMessage({ type: "approveCommand", approvalId: currentPending.approvalId, runId: currentPending.runId, approved: true, kind: currentPending.kind });
    }
  }
});

function sendPlanDecision(decision: string): void {
  if (!currentPlanReady) return;
  const feedback = planFeedbackEl.value.trim() || undefined;
  vscode.postMessage({
    type: "planDecision",
    planId: currentPlanReady.planId,
    runId: currentPlanReady.runId,
    decision,
    ...(feedback ? { feedback } : {}),
  });
}
planBtnAccept.addEventListener("click", () => sendPlanDecision("accept_all"));
planBtnManual.addEventListener("click", () => sendPlanDecision("manual"));
planBtnFeedback.addEventListener("click", () => sendPlanDecision("feedback"));
planBtnFbRun.addEventListener("click", () => sendPlanDecision("approve_with_feedback"));
planBtnReject.addEventListener("click", () => sendPlanDecision("reject"));

modeBtn.addEventListener("click", () => {
  const next: "default" | "auto" | "plan" =
    currentMode === "default" ? "auto" : currentMode === "auto" ? "plan" : "default";
  currentMode = next;
  modeLabel.textContent = next;
  modeBtn.dataset["mode"] = next;
  vscode.postMessage({ type: "setMode", mode: next });
});

websearchBtn.addEventListener("click", () => {
  vscode.postMessage({ type: "toggleWebSearch" });
});

capBtn.addEventListener("click", () => {
  vscode.postMessage({ type: "setDailyCap" });
});

// ── Slash-command autocomplete palette ────────────────────────────────────────
const slashPalette = document.querySelector<HTMLDivElement>("#slash-palette") as HTMLDivElement;
let slashItems: { name: string; desc: string }[] = [];
let slashIndex = 0;

// Single dispatch point — used by both the palette and the Enter handler.
function runSlashCommand(command: string, args: string): void {
  vscode.postMessage({ type: "slashCommand", command, args });
  promptInput.value = "";          // clear composer; leave staged images intact
  closeSlashPalette();
}

function closeSlashPalette(): void {
  slashPalette.hidden = true;
  slashItems = [];
  slashIndex = 0;
}

function renderSlashPalette(): void {
  slashPalette.textContent = "";
  slashItems.forEach((item, i) => {
    const row = mkEl("div", "slash-row" + (i === slashIndex ? " active" : ""));
    row.append(mkEl("span", "slash-cmd", "/" + item.name));
    row.append(mkEl("span", "slash-desc", item.desc));
    row.addEventListener("click", () => runSlashCommand(item.name, ""));
    slashPalette.append(row);
  });
}

function updateSlashPalette(): void {
  // Match "/" + command token only (no space) → hides once args are typed or text isn't a leading-slash token.
  const m = /^\/(\S*)$/.exec(promptInput.value);
  if (!m) { closeSlashPalette(); return; }
  const q = m[1].toLowerCase();
  slashItems = Object.entries(SLASH_COMMANDS)
    .filter(([name]) => name.startsWith(q))
    .map(([name, desc]) => ({ name, desc }));
  if (slashItems.length === 0) { closeSlashPalette(); return; }   // e.g. "/foo" → no palette → Enter sends normally
  slashIndex = 0;
  slashPalette.hidden = false;
  renderSlashPalette();
}

function moveSlashHighlight(delta: number): void {
  if (slashItems.length === 0) return;
  slashIndex = (slashIndex + delta + slashItems.length) % slashItems.length;
  renderSlashPalette();
}

promptInput.addEventListener("input", updateSlashPalette);

promptInput.addEventListener("keydown", (event) => {
  if (!slashPalette.hidden) {
    if (event.key === "ArrowDown") { event.preventDefault(); moveSlashHighlight(1); return; }
    if (event.key === "ArrowUp")   { event.preventDefault(); moveSlashHighlight(-1); return; }
    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      event.preventDefault();
      const it = slashItems[slashIndex];
      if (it) runSlashCommand(it.name, "");
      return;
    }
    if (event.key === "Escape") { event.preventDefault(); closeSlashPalette(); return; }
    // other keys fall through → typed → input event re-filters
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    const text = promptInput.value.trim();
    if (!text) return;
    // Slash-command interception: known command → dispatch (not a prompt).
    // Unknown "/x" or a non-leading slash falls through to the normal prompt.
    if (text.startsWith("/")) {
      const firstToken = text.slice(1).split(/\s+/)[0];
      if (Object.hasOwn(SLASH_COMMANDS, firstToken)) {
        const args = text.slice(1 + firstToken.length).trim();
        runSlashCommand(firstToken, args);   // shared dispatch point
        return;
      }
    }
    if (spinnerArea.classList.contains("active")) return;
    const images = stagedImages.length > 0
      ? stagedImages.map(({ mediaType, base64 }) => ({ mediaType, base64 }))
      : undefined;
    if (stagedImages.length > 0) {
      thumbnailsByTranscriptIdx.set(lastTranscriptLen, stagedImages.map(img => img.thumb));
    }
    vscode.postMessage({ type: "prompt", text, ...(images ? { images } : {}) });
    promptInput.value = "";
    stagedImages = [];
    renderChips();
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

  currentMode = c.mode;
  modeLabel.textContent = c.mode;
  modeBtn.dataset["mode"] = c.mode;

  websearchLabel.textContent = c.webSearchEnabled ? "web: on" : "web: off";
  websearchBtn.dataset["enabled"] = String(c.webSearchEnabled);

  capLabel.textContent = c.dailyCap > 0 ? `cap: $${c.dailyCap}` : "no cap";

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

  syncActionBar();
}

// ── Transcript renderer ───────────────────────────────────────────────────────

function mkEl<K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ── Summary card renderer ─────────────────────────────────────────────────────

type InlineSegment =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold"; text: string };

type BlockToken =
  | { kind: "heading"; text: string }
  | { kind: "bullet"; segments: InlineSegment[] }
  | { kind: "paragraph"; segments: InlineSegment[] };

function parseInline(raw: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  const re = /`([^`]*)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) {
      segments.push({ kind: "text", text: raw.slice(last, m.index) });
    }
    if (m[1] !== undefined) {
      segments.push({ kind: "code", text: m[1] });
    } else {
      segments.push({ kind: "bold", text: m[2] });
    }
    last = re.lastIndex;
  }
  if (last < raw.length) {
    segments.push({ kind: "text", text: raw.slice(last) });
  }
  return segments;
}

function tokenizeMarkdown(text: string): BlockToken[] {
  const tokens: BlockToken[] = [];
  const lines = text.split("\n");
  let paraLines: string[] = [];

  function flushParagraph() {
    if (paraLines.length === 0) { return; }
    tokens.push({ kind: "paragraph", segments: parseInline(paraLines.join("\n")) });
    paraLines = [];
  }

  for (const line of lines) {
    if (/^#{1,3} /.test(line)) {
      flushParagraph();
      tokens.push({ kind: "heading", text: line.replace(/^#{1,3} /, "") });
    } else if (/^[-*] /.test(line)) {
      flushParagraph();
      tokens.push({ kind: "bullet", segments: parseInline(line.slice(2)) });
    } else if (line.trim() === "") {
      flushParagraph();
    } else {
      paraLines.push(line);
    }
  }
  flushParagraph();
  return tokens;
}

function appendInlineSegments(container: HTMLElement, segments: InlineSegment[]) {
  for (const seg of segments) {
    if (seg.kind === "code") {
      const span = document.createElement("span");
      span.className = "summary-inline-code";
      span.textContent = seg.text;
      container.appendChild(span);
    } else if (seg.kind === "bold") {
      const strong = document.createElement("strong");
      strong.className = "summary-inline-bold";
      strong.textContent = seg.text;
      container.appendChild(strong);
    } else {
      container.appendChild(document.createTextNode(seg.text));
    }
  }
}

function buildSummaryCard(text: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "entry entry-assistant-final summary-card";
  for (const token of tokenizeMarkdown(text)) {
    if (token.kind === "heading") {
      const h = document.createElement("div");
      h.className = "summary-heading";
      h.textContent = token.text;
      card.appendChild(h);
    } else if (token.kind === "bullet") {
      const row = document.createElement("div");
      row.className = "summary-bullet";
      const marker = document.createElement("span");
      marker.className = "summary-bullet-marker";
      marker.textContent = "›";
      const body = document.createElement("span");
      body.className = "summary-bullet-body";
      appendInlineSegments(body, token.segments);
      row.appendChild(marker);
      row.appendChild(body);
      card.appendChild(row);
    } else {
      const p = document.createElement("div");
      p.className = "summary-paragraph";
      appendInlineSegments(p, token.segments);
      card.appendChild(p);
    }
  }
  return card;
}

function syncActionBar(): void {
  if (spinnerActive) {
    stopBar.hidden = false;
    stopBtn.hidden = false;
    undoBtn.hidden = true;
  } else if (currentControls?.undoable) {
    stopBar.hidden = false;
    stopBtn.hidden = true;
    undoBtn.hidden = false;
  } else {
    stopBar.hidden = true;
  }
}

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
  state.transcript.forEach((entry, i) => renderEntry(entry, i));
  lastTranscriptLen = state.transcript.length;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;

  spinnerActive = !!state.spinner;
  if (state.spinner) {
    spinnerArea.classList.add("active");
    spinnerLabel.textContent = state.spinner.label;
  } else {
    spinnerArea.classList.remove("active");
    stopBtn.disabled = false;
    stopBtn.textContent = "Stop";
  }
  syncActionBar();

  statusText.innerHTML = formatStatus(state.statusBar);

  currentPending = state.pendingApproval ?? null;
  if (state.pendingApproval) {
    const isEdit = state.pendingApproval.kind === "edit";
    approvalLabel.textContent = isEdit ? "⚠ Approve edit?" : "⚠ Approve command?";
    approvalCommandEl.textContent = state.pendingApproval.command;
    const patch = isEdit ? state.liveTail?.currentToolCall?.patch : undefined;
    if (patch) {
      renderDiff(patch, approvalDiffEl);
      approvalDiffEl.style.display = "block";
    } else {
      approvalDiffEl.innerHTML = "";
      approvalDiffEl.style.display = "none";
    }
    approvalPrompt.style.display = "block";
  } else {
    approvalDiffEl.innerHTML = "";
    approvalDiffEl.style.display = "none";
    approvalPrompt.style.display = "none";
  }

  currentPlanReady = state.planReadyProposal
    ? { planId: state.planReadyProposal.planId, runId: state.planReadyProposal.runId }
    : null;
  if (state.planReadyProposal) {
    const p = state.planReadyProposal;
    planObjEl.textContent = p.objective;
    planStepsEl.innerHTML = "";
    p.steps.forEach((s, i) => {
      const li = mkEl("li", "plan-step");
      li.append(mkEl("span", "plan-step-num", `${i + 1}.`));
      const body = mkEl("span");
      body.append(mkEl("span", "plan-step-title", s.title));
      if (s.description) body.append(mkEl("span", "plan-step-desc", ` — ${s.description}`));
      li.append(body);
      planStepsEl.append(li);
    });
    if (p.scopeNotes) {
      planScopeEl.textContent = p.scopeNotes;
      planScopeEl.hidden = false;
    } else {
      planScopeEl.hidden = true;
    }
    planReadyEl.style.display = "block";
  } else {
    planReadyEl.style.display = "none";
  }
}

function renderDiff(patch: string, container: HTMLElement, maxLines = 20): void {
  container.innerHTML = "";
  const FIND_M = "--- FIND ---";
  const REPL_M = "--- REPLACE ---";
  type DL = { kind: "remove" | "add"; text: string } | { kind: "sep" };
  const allLines: DL[] = [];
  let first = true;
  patch.split(FIND_M).slice(1).forEach((part) => {
    const ri = part.indexOf(REPL_M);
    if (ri === -1) return;
    const trim = (s: string) => s.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
    const findTrimmed = trim(part.slice(0, ri));
    const replTrimmed = trim(part.slice(ri + REPL_M.length));
    const findLines = findTrimmed ? findTrimmed.split("\n") : [];
    const replLines = replTrimmed ? replTrimmed.split("\n") : [];
    if (!first) allLines.push({ kind: "sep" });
    first = false;
    findLines.forEach((l) => allLines.push({ kind: "remove", text: l }));
    replLines.forEach((l) => allLines.push({ kind: "add", text: l }));
  });
  if (allLines.length === 0) return;
  const MAX = maxLines;
  let contentCount = 0, cutIdx = allLines.length;
  for (let i = 0; i < allLines.length; i++) {
    if (allLines[i].kind !== "sep" && ++contentCount > MAX) { cutIdx = i; break; }
  }
  const shown = allLines.slice(0, cutIdx);
  const remaining = allLines.slice(cutIdx).filter((l) => l.kind !== "sep").length;
  for (const l of shown) {
    if (l.kind === "sep") {
      container.append(mkEl("div", "diff-sep", "···"));
    } else {
      const el = mkEl("div", `diff-line ${l.kind === "remove" ? "diff-removed" : "diff-added"}`);
      el.textContent = `${l.kind === "remove" ? "−" : "+"} ${l.text}`;
      container.append(el);
    }
  }
  if (remaining > 0)
    container.append(mkEl("div", "diff-overflow", `… +${remaining} more line${remaining === 1 ? "" : "s"}`));
}

function renderEntry(entry: TranscriptEntry, idx = -1): void {
  switch (entry.kind) {
    case "user_prompt": {
      const wrap = mkEl("div", "entry entry-user");
      wrap.append(mkEl("span", "entry-user-marker", "›"));
      const body = mkEl("div", "entry-user-body");
      body.append(mkEl("span", "entry-user-text", entry.text));
      const thumbs = thumbnailsByTranscriptIdx.get(idx) ?? [];
      if (thumbs.length > 0) {
        const row = mkEl("div", "entry-user-thumbs");
        thumbs.slice(0, 4).forEach(src => {
          const el = document.createElement("img");
          el.src = src;
          el.className = "entry-user-thumb";
          row.append(el);
        });
        if (thumbs.length > 4) {
          row.append(mkEl("span", "entry-user-thumb-more", `+${thumbs.length - 4} more`));
        }
        body.append(row);
      }
      wrap.append(body);
      transcriptEl.append(wrap);
      break;
    }
    case "narration": {
      const wrap = mkEl("div", "entry entry-narration");
      wrap.append(mkEl("span", "entry-narration-dot", "◆"));
      wrap.append(mkEl("span", undefined, entry.text));
      transcriptEl.append(wrap);
      break;
    }
    case "thinking":
      transcriptEl.append(mkEl("div", "entry entry-thinking", entry.text));
      break;
    case "assistant_final":
      transcriptEl.append(buildSummaryCard(entry.text));
      break;
    case "tool_call": {
      const wrap = mkEl("div", "entry entry-tool");

      const header = mkEl("div", "entry-tool-header");
      header.append(mkEl("span", "entry-tool-glyph", "▸"));
      header.append(mkEl("span", "entry-tool-name", entry.toolName));
      if (entry.args) header.append(mkEl("span", "entry-tool-args", entry.args));
      wrap.append(header);

      for (const result of entry.results) {
        const row = mkEl("div", `entry-tool-result ${result.ok ? "ok" : "fail"}`);
        row.append(mkEl("span", "result-icon", result.ok ? "✓" : "✗"));

        // Strip leading boilerplate line [exit_code=…]
        let detail = result.detail;
        const firstNl = detail.indexOf("\n");
        const firstLine = firstNl >= 0 ? detail.slice(0, firstNl) : detail;
        if (firstLine.startsWith("[exit_code=")) {
          detail = (firstNl >= 0 ? detail.slice(firstNl + 1) : "").trimStart();
        }

        // Truncate to 10 lines
        const lines = detail.split("\n");
        const MAX_LINES = 10;
        const shown = lines.slice(0, MAX_LINES).join("\n");
        const overflow = lines.length - MAX_LINES;

        row.append(mkEl("span", undefined, shown));
        wrap.append(row);
        if (overflow > 0) {
          wrap.append(mkEl("div", "entry-tool-more",
            `… (${overflow} more line${overflow === 1 ? "" : "s"})`));
        }
      }

      if (entry.patch && DIFF_TOOLS.has(entry.toolName)) {
        const lastResult = entry.results[entry.results.length - 1];
        if (lastResult?.ok) {
          const diffWrap = mkEl("div", "entry-tool-diff");
          renderDiff(entry.patch, diffWrap, entry.toolName === "write_file" ? WRITE_FILE_PREVIEW_LINES : undefined);
          if (diffWrap.hasChildNodes()) wrap.append(diffWrap);
        }
      }

      transcriptEl.append(wrap);
      break;
    }
    case "error":
      transcriptEl.append(mkEl("div", "entry entry-error", `✗ ${entry.text}`));
      break;
    case "phase_marker":
      transcriptEl.append(mkEl("div", "entry entry-phase", `── ${entry.phase} ──`));
      break;
    case "post_execute_diffs":
      break;
  }
}
