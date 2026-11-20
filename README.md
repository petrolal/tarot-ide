# Tarot IDE

[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)
[![Upstream: Code - OSS 1.148.0](https://img.shields.io/badge/upstream-Code%20--%20OSS%201.148.0-informational.svg)](https://github.com/microsoft/vscode)
[![Marketplace: Open VSX](https://img.shields.io/badge/marketplace-Open%20VSX-purple.svg)](https://open-vsx.org)

**Arcana Code Environment** — a spec-driven, agent-first IDE built as a fork of [Code - OSS](https://github.com/microsoft/vscode).

Tarot IDE keeps the editor you already know and rebuilds the workflow around it: you describe intent in a spec, the IDE decomposes it into tasks, and a local AI agent CLI of your choice executes them — under your review, with checkpoints you can roll back.

> **Status:** early development. Phases 1–2 are complete, Phase 3 (agentic core, Kiro parity) is in progress. See [Roadmap](#roadmap).

---

## Why another agentic IDE?

Most AI IDEs want to own your model, your tokens and your telemetry. Tarot IDE takes the opposite position:

- **BYOA — Bring Your Own Agents.** Tarot IDE does not ship a model and does not proxy your prompts. It orchestrates the CLI agents already installed on your machine — `claude`, `codex`, `agy` (Antigravity) — plus any custom CLI you declare. You keep your subscriptions, your keys and your local configuration.
- **Spec-Driven Development.** Features start as a spec (`requirements.md`, `design.md`, `tasks.md`) written in [EARS notation](https://en.wikipedia.org/wiki/Ears_(requirements)), not as a chat log. Tasks carry acceptance criteria, appear as CodeLens actions in the editor, and run one by one.
- **Local-first, zero telemetry.** `enableTelemetry: false`, no Microsoft endpoints, no `defaultChatAgent`. The marketplace is [Open VSX](https://open-vsx.org). Nothing about your work leaves the machine unless the agent CLI you chose sends it.
- **Safe by construction.** Every agent CLI is launched with `spawn(bin, args, { shell: false })`; workspace artifacts under `.tarot/` only load in a **trusted workspace**; webviews use a strict CSP with `nonce` and never render model output through `innerHTML`.
- **Upstream-compatible.** No global find-and-replace across the codebase. The fork stays mergeable with `microsoft/vscode` releases, and every core change is tracked in a conflict matrix.

## Features

### Specs (Spec-Driven Development)

Author a spec in `.tarot/specs/<slug>/` and Tarot IDE drives the rest: an approval gate after requirements, automatic task-list generation, task parsing with acceptance criteria, and CodeLens actions in `tasks.md` to run a single task or a task with its dependencies.

### Steering

Persistent project conventions in `.tarot/steering/` — your coding standards, architecture rules and review expectations — scoped as `always`, `fileMatch` (glob), `auto` or `manual`, and injected into every agent prompt that matches. The Steering view can generate a starter document with an agent or hand you a blank one to edit.

### Agent Hooks (`v1` schema)

Automate the work around the work. `tarot.hooks.create` scaffolds a `v1` hook file: several hooks per file, each with a path `matcher` regex, a timeout, and either a `command` or an `agent` action, on triggers spanning file create/save/delete, tool use, prompt submit and session lifecycle. Command actions receive the event as JSON on STDIN, where exit code `0` injects output as context and `2` blocks the operation. Authoring and the Hooks view are available today; the execution engine is part of the in-progress Phase 3 work.

### Context providers

Attach repo context to a prompt with `#` references: `#file`, `#folder`, `#spec`, `#steering`, `#problems`, `#gitDiff`, `#terminal` and `#codebase`.

### Agent panel

A dedicated Agent panel in the Secondary Side Bar ("Agent First" layout) with streaming output, a context-usage ring, tool-call summaries, elapsed time, an autonomy selector (`vibe` / `spec`), a **Focus Mode** that hides everything but the conversation, and session persistence so a run survives an editor restart.

### Review Queue, Checkpoints & Commit Messages

Review the agent's file changes in bulk before they land, open per-file diffs, revert individual files, restore whole checkpoints, and generate a commit message from the staged diff with `tarot.git.generateCommitMessage`.

### Themes

Ships **Tarot Arcana Dark** and **Tarot Arcana Light** color themes plus the **Tarot Arcana** file icon theme, tuned for long agent sessions.

## Requirements

- **Node.js 24.22.1** — the version pinned in [`.nvmrc`](.nvmrc).
- **pnpm 12.16.0** — pinned via `packageManager`. This repository uses pnpm exclusively; `npm install` is actively blocked by `build/npm/preinstall.ts`.
- Platform toolchains for building Electron (see the [upstream prerequisites](https://github.com/microsoft/vscode/wiki/How-to-Contribute#prerequisites) for your OS), plus `git`.
- Optional: one or more agent CLIs on your `PATH` — `claude`, `codex`, `agy`. Tarot IDE starts and reports missing ones instead of failing.

## Getting Started

```bash
git clone https://github.com/petrolal/tarot-ide.git
cd tarot-ide
pnpm install
```

Then build and launch the desktop app:

```bash
# Terminal 1 — build everything once
pnpm run compile-tarot

# Terminal 2 — launch
./scripts/code.sh
```

For day-to-day work, prefer the watch task so rebuilds are incremental (keep it running, launch in another terminal):

```bash
pnpm run watch-tarot
```

If you are only touching the Tarot extension, the fast loop is:

```bash
pnpm run watch-tarot-core          # gulp watch for extensions/tarot-core
# or, one-shot:
pnpm exec gulp compile-extension:tarot-core
```

Inside the repository, use the **Launch VS Code** Run and Debug configuration for the full debugger experience.

### Troubleshooting

- **Electron fails to start on Linux** — install the shared-library prerequisites listed in the [upstream prerequisites](https://github.com/microsoft/vscode/wiki/How-to-Contribute#prerequisites) for your distribution; missing `libnss3`/`libasound2`-class packages are the usual cause.
- **`npm install` refuses to run** — expected. Use `pnpm install`.
- **`./scripts/code.sh` starts but nothing loads** — the client output is stale or missing; run `pnpm run compile-tarot` (or start `pnpm run watch-tarot`) first.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `tarot.ui.openAgentPanelOnStartup` | `true` | Open the Tarot Agent panel in the right Secondary Side Bar on startup. |
| `tarot.agents.default` | `"auto"` | Default local agent CLI; `auto` picks the first available installed CLI. |
| `tarot.agents.paths.claude` | `""` | Custom executable path for the Claude Code CLI. |
| `tarot.agents.paths.agy` | `""` | Custom executable path for the Antigravity CLI. |
| `tarot.agents.paths.codex` | `""` | Custom executable path for the OpenAI Codex CLI. |
| `tarot.agents.timeoutMs` | `300000` | Maximum execution timeout for a single agent run, in milliseconds. |
| `tarot.agents.custom` | `[]` | Additional custom local agent CLIs to expose. |

### Commands

`tarot.welcome` · `tarot.agentPanel.open` · `tarot.agent.sendSelection` (`Ctrl+L` / `Cmd+L`) · `tarot.agent.openInEditorTab` · `tarot.agent.toggleFocusMode` · `tarot.git.generateCommitMessage` · `tarot.agents.select` · `tarot.agents.refresh` · `tarot.agents.selectById` · `tarot.specs.create` · `tarot.specs.runTask` · `tarot.specs.runTaskWith` · `tarot.steering.create` · `tarot.steering.generate` · `tarot.hooks.create`

## Architecture

Tarot IDE follows an **Extension-First** rule: everything the product adds lives in [`extensions/tarot-core/`](extensions/tarot-core/) as a built-in extension, and `src/vs/` is touched only when a feature is technically impossible through the Extension API — always with the smallest possible diff, recorded in the project docs.

```
extensions/tarot-core/src/
├── agents/         # CLI adapters (claude, codex, agy, custom), runtime, sessions, process runner
├── specs/          # spec storage, task parsing, CodeLens
├── steering/       # steering documents and scoping
├── context/        # '#provider' context resolution
├── checkpoints/    # workspace checkpoints and restore
├── git/            # review queue and diff-based commit messages
├── views/          # sidebar trees, webview panel and its string catalog
├── config/         # settings access
└── extension.ts    # activation, command registration
```

Per-workspace artifacts live in `.tarot/` (specs, steering, hooks, sessions, checkpoints, `settings/mcp.json`), while permission files stay outside the repository, under `~/.tarot/` and the IDE's own data directory.

## Roadmap

| Phase | Scope | Status |
| --- | --- | --- |
| 1–2 | Fork identity, branding, themes, agent runtime, agent panel | ✅ Done |
| 3 | Agentic core: Specs, Steering, Hooks, permissions, workflows, review queue, checkpoints (Kiro parity) | 🚧 In progress |
| 4 | Packaging and distribution (installers, Open VSX publishing) | 📋 Planned |
| 5 | Optional task-crew orchestration | 💭 Optional |

Phase 3 milestones are tracked individually in [`docs/MIGRATION_PLAN.md`](docs/MIGRATION_PLAN.md), which is the source of truth for scope and acceptance criteria. Upstream sync rules and the conflict matrix live in the same document.

## Documentation

| Document | Contents |
| --- | --- |
| [`AGENTS.md`](AGENTS.md) | Entry point for AI agents working in this repository: invariants, precedence, workflow. |
| [`docs/PROJECT_CONTEXT.md`](docs/PROJECT_CONTEXT.md) | Product vision, stack, guardrails, use cases, `src/vs/` change map, module structure. |
| [`docs/MIGRATION_PLAN.md`](docs/MIGRATION_PLAN.md) | Per-milestone specs and definitions of done, phases, upstream conflict matrix. |
| [`docs/KIRO_ARCHITECTURE_REFERENCE.md`](docs/KIRO_ARCHITECTURE_REFERENCE.md) | Validated reference for the Kiro-parity surfaces (Specs, Steering, Hooks, permissions, workflows). |

> The project documentation is written in **Portuguese (pt-BR)**. The product UI, code, identifiers and commit messages are in **English**.

## Contributing

Contributions are welcome. Before opening a pull request:

1. Read [`AGENTS.md`](AGENTS.md) — it defines the non-negotiable invariants (Extension-First, pnpm only, Workspace Trust before loading `.tarot/`, no `shell: true`, no `innerHTML` with model output, never commit on `main`).
2. Work on a branch created from `tarot-main`, not `main`. `main` mirrors `upstream/main` and exists only for syncing.
3. Keep `docs/` in sync with behavioral changes in the same pull request.
4. Validate what you changed: `pnpm exec gulp compile-extension:tarot-core`, plus `pnpm run typecheck-client` if you touched `src/vs/`.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full workflow. Security issues should follow [`SECURITY.md`](SECURITY.md) rather than the public issue tracker.

Because this fork preserves the complete upstream Git history — deliberately, so `git log`/`git blame` stay meaningful and upstream attribution survives — this repository's contributor graph also lists the authors of Visual Studio Code. That is expected and not something we can or wish to remove.

## License & Attribution

**Tarot IDE** is Copyright (c) 2026 **Lucas Petrola**, licensed under the **GNU General Public License v3.0** — see [`LICENSE`](LICENSE).

It is a derivative work of **Visual Studio Code (Code - OSS)**:

- Copyright (c) 2015–present **Microsoft Corporation**, originally released under the **MIT License**.
- The verbatim upstream MIT license text is preserved in [`LICENSE-VSCODE-MIT.txt`](LICENSE-VSCODE-MIT.txt); additional third-party notices are in [`ThirdPartyNotices.txt`](ThirdPartyNotices.txt).

If you fork or redistribute Tarot IDE, GPL-3.0 §§ 4, 5 and 7(b) require you to keep the copyright and author attribution, state prominent notices of your changes with dates, ship the complete corresponding source under the same license, and preserve the upstream third-party notices. The full terms are in [`NOTICE.md`](NOTICE.md).

Tarot IDE is an independent project. It is **not affiliated with, endorsed by or sponsored by Microsoft**, and it is **not affiliated with Kiro or Amazon Web Services**; those names are used only to describe interoperability and design inspiration.
