# Zone

AI coding agent for VS Code — BYOK, atomic file edits with instant undo.

![Zone — patch applied, Undo ready](https://raw.githubusercontent.com/BedreddinErkan/zone-vsextension/master/images/patch-and-undo.png)

## Features

- **Direct file editing** — runs tasks that edit your codebase, not just suggest patches
- **Instant undo** — every run snapshots affected files; click Undo or type `/undo` to restore
- **Plan mode** — review Zone's proposed plan before any files are touched

![Plan-ready approval gate](https://raw.githubusercontent.com/BedreddinErkan/zone-vsextension/master/images/plan-mode.png)

- **BYOK** — bring your own OpenAI (GPT-4.x) or Anthropic (Claude) API key; no Zone account needed
- **Daily cost cap** — set a USD spending limit via `/limits` or the cap chip in the header
- **Slash commands** — `/init`, `/memory`, `/undo`, `/limits`, `/feedback`

## Getting Started

1. Open a project folder in VS Code
2. Run **Zone: Open Panel** from the Command Palette (`Ctrl+Shift+P`)
3. Click **set key** in the header to enter your API key
4. Type a task and press Enter

No Zone account needed — bring your own OpenAI or Anthropic API key.

## License

AGPL-3.0-or-later — see [LICENSE](https://github.com/BedreddinErkan/zone-vsextension/blob/master/LICENSE)
