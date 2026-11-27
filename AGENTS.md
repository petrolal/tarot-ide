# Tarot IDE — AGENTS.md

Ponto de entrada para qualquer agente de IA (`agy`, `claude`, `codex`, Copilot, etc.) que atue neste repositório.
O **Tarot IDE** é um fork do `microsoft/vscode` (Code - OSS `1.148.0`, branch de trabalho `tarot-main`): uma IDE 100% agêntica inspirada no Kiro IDE, com **BYOA** (*Bring Your Own Agents*: orquestra os CLIs `claude`, `codex` e `agy` já instalados na máquina).

## 1. Precedência

1. `AGENTS.md` (este arquivo) e `docs/PROJECT_CONTEXT.md` **vencem** as instruções padrão da Microsoft quando houver conflito.
2. Em tudo que **não** conflita (camadas `common/` · `browser/` · `node/`, injeção de dependência, estilo, testes, cancelamento) valem as instruções originais em `.github/copilot-instructions.md` e `.github/instructions/*.instructions.md`. **Não apague nem reescreva** esses arquivos do upstream.
3. Contexto específico das pastas do Tarot: `.github/instructions/tarot-ide.instructions.md` (carrega via `applyTo`).
4. Cancelamento: prefira `CancellationToken`/`CancellationTokenSource` internamente e adapte `AbortSignal` só em fronteiras nativas ou de terceiros ([guia](.github/copilot-instructions.md#cancellation)).

## 2. Invariantes Críticas (Non-Negotiables)

**a) Extension-First (90%+)**
- Toda nova feature vive em `extensions/tarot-core/` (ou extensões irmãs `extensions/tarot-*`).
- Só toque em `src/vs/` se for **tecnicamente impossível** via Extension API, com o **menor diff possível**, e registre-o no mesmo ciclo em `docs/PROJECT_CONTEXT.md` (Seção 5) e na matriz de conflitos de `docs/MIGRATION_PLAN.md`.
- Não faça find-and-replace global de "VS Code" em `src/vs/` nem em `extensions/*/package.nls.json`; o rebranding de textos é centralizado em `src/vs/nls.ts` (`_rebrandMessage`).

**b) Package manager: somente `pnpm`**
- `pnpm install`, `pnpm run compile-tarot`, `pnpm run watch-tarot` / `watch-tarot-fast` / `watch-tarot-core`, `pnpm exec gulp compile-extension:tarot-core`.
- **Nunca** use `npm` (o `build/npm/preinstall.ts` bloqueia).

**c) Privacidade & Marketplace**
- **Nunca** restaure `defaultChatAgent`, `enableTelemetry: true`, `aiConfig`, `tasConfig` ou endpoints Microsoft no `product.json`.
- O marketplace é exclusivamente o **Open VSX** (`extensionsGallery`); nunca use URLs do Visual Studio Marketplace.
- **Nunca delete `extensions/copilot/`** (quebra `pnpm-lock.yaml` e os merges com o upstream); o Copilot é desativado via `product.json` + `--disable-extension=GitHub.copilot-chat`.

**d) Segurança BYOA & Webviews**
- Execute CLIs sempre com `spawn(bin, args, { shell: false })`; nunca concatene prompts do usuário em strings de shell.
- Respeite o **Workspace Trust** (`vscode.workspace.isTrusted`) **antes** de carregar ou executar qualquer coisa de `.tarot/` (hooks, agentes, steering, skills, MCP, workflows).
- Webviews: CSP estrita com `nonce`; **nunca** `innerHTML` com saída de LLMs/CLIs (use `textContent`/DOM seguro).
- Nunca logue nem persista tokens ou credenciais em `.tarot/` ou OutputChannels.

**e) Idioma**
- Documentação (`docs/`, specs, mensagens de commit de contexto/docs): **PT-BR**.
- Código, identificadores, comentários técnicos e mensagens de commit de código: **Inglês**.
- **UI vs. prompts**: todo texto de *chrome* da UI (comandos, mensagens, placeholders, tooltips, TreeViews, painel agêntico) é **Inglês externalizado com `vscode.l10n.t()`** (+ `package.nls.json` para o manifesto); **prompts enviados aos agentes** e **templates de documentos gerados** (`.tarot/specs/**`, `.tarot/steering/**`, hooks) permanecem **PT-BR**. Em webviews, use o catálogo injetado (`window.__tarotL10n` + helper `t(key, ...)`) — detalhes em `docs/PROJECT_CONTEXT.md` §3.5.

**f) Git**
- Trabalhe em `tarot-main` (ou feature branches criadas a partir dela). **Nunca** commite em `main` (espelho do `upstream/main`).
- Commits atômicos e verificados; mantenha `docs/` sincronizadas na mesma entrega.

## 3. Ponte para os Docs (leia antes de planejar ou alterar arquivos)

| Documento | Quando ler |
| --- | --- |
| `docs/PROJECT_CONTEXT.md` | **Sempre primeiro**: visão do produto, stack, regras e guardrails (Seção 3), casos de uso `UC-01..UC-11`, mapa de alterações em `src/vs/` (Seção 5), estrutura de `tarot-core` (Seção 6), comandos e troubleshooting. |
| `docs/EVOLUTION_PLAN_V2.md` | **Roadmap ativo (Fase 6: `M6.1–M6.23`)**: Cursor-style Inline Diff Review (`M6.1`), Auto-Contexto (`M6.1b`), `/comandos` unificados, Inline Edit `Ctrl+K`, Imagens no Chat, NL Hooks/Schedules, NL-to-Shell, Inline Diffs (`M6.7`), `/rewind`, Focus Mode redimensionável, Export `.zip` + Spec Drift, `@` Autocomplete inline, Prompt Queue, Guided Compaction, Hook Output/SubagentStop, Browser Preview, Evidence Summary Pré-PR, Comandos Pendentes no Chat, Auto-Diagnósticos Pós-Edição, Terminal Quick Fix, Regras Externas (`CLAUDE.md`/`.cursor/rules`), Multi-Sessão Paralela em Worktrees, Tab FIM Opt-in e Telemetria Local de Sessão. |
| `docs/MIGRATION_PLAN.md` | Registro concluído das Fases 1–5 (`M3.1–M3.10`, Fase 4 `.deb`/CI e Fase 5 Tarot Crew) e **matriz de conflitos de sincronização com o upstream**. |
| `docs/KIRO_ARCHITECTURE_REFERENCE.md` | Ao tocar Specs, Steering, Hooks, Permissões, Workflows, Sessions ou UX do painel: referência validada da doc oficial do Kiro (Seção 4) e tabela Kiro × Tarot. |

**Status do plano**: **Fases 1–5 100% concluídas** (`MIGRATION_PLAN.md`) · **Fase 6 ativa (`docs/EVOLUTION_PLAN_V2.md`)** — `M6.1` ✅, `M6.1b` ✅ e `M6.7` ✅ concluídos · próximo marco: **`M6.2` (Sistema Unificado de `/comandos`)**.
Se este status divergir do `docs/EVOLUTION_PLAN_V2.md`, **o `EVOLUTION_PLAN_V2.md` vence**; atualize este arquivo.

## 4. Mapa Rápido do Repositório

- `extensions/tarot-core/` — extensão built-in do Tarot (agents, specs, steering, hooks, permissions, workflows, context, checkpoints, review, git, views, `media/webview`, temas e ícones).
- `.tarot/` (no workspace do usuário) — `specs/`, `steering/`, `hooks/`, `workflows/`, `sessions/`, `checkpoints/`, `settings/mcp.json` + `AGENTS.md` na raiz *(permissões ficam **fora** do repo: `~/.tarot/settings/permissions.yaml` e `~/.tarot-ide/workspace-roots/<hash>/permissions.yaml`)*.
- `src/vs/**` — núcleo do VS Code, **sob restrição estrita** (ver 2a).
- `product.json`, `resources/**`, `docs/**` — identidade, assets e documentação do Tarot.

## 5. Fluxos Padronizados (prompts reutilizáveis em `.github/prompts/`)

- `tarot-execute-milestone.prompt.md` — executa o próximo marco pendente do `MIGRATION_PLAN.md` (hoje: **M3.9c**).
- `tarot-new-feature.prompt.md` — nova funcionalidade isolada em `extensions/tarot-core/`.
- `tarot-upstream-sync.prompt.md` — sincronização com tags do `microsoft/vscode` seguindo a matriz de conflitos.

## 6. Checklist Mínimo Antes de Concluir Qualquer Tarefa

1. `pnpm exec gulp compile-extension:tarot-core` sem erros + `node --test "extensions/tarot-core/out/test/**/*.test.js"`; se tocou `src/vs/`: também `node build/next/index.ts transpile` e `pnpm run typecheck-client`.
2. JSON/manifestos alterados (`package.json`, `product.json`, `*.nls.json`, temas) são válidos.
3. Nenhuma violação das invariantes da Seção 2 (`rg "innerHTML|shell:\s*true" extensions/tarot-core/src extensions/tarot-core/media`).
4. `docs/MIGRATION_PLAN.md` (status/DoD) e, se aplicável, `docs/PROJECT_CONTEXT.md` atualizados no mesmo ciclo.
