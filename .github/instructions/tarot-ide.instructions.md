---
description: Contexto técnico do Tarot IDE — arquitetura de extensions/tarot-core, paleta Arcana, padrões BYOA, EARS, Hooks v1, permissões e checklist de conclusão. Aplica-se às pastas específicas do fork.
applyTo: "extensions/tarot-core/**,product.json,resources/**,.tarot/**,docs/**"
---

# Tarot IDE — Instruções Direcionadas

> Precedência: `AGENTS.md` e `docs/PROJECT_CONTEXT.md` vencem as instruções padrão da Microsoft. Aqui ficam apenas detalhes das pastas acima. Idioma: **docs em PT-BR; código, identificadores e comentários técnicos em Inglês**.

## 1. Arquitetura de `extensions/tarot-core/src/`

`extension.ts` faz o bootstrap e a composição dos módulos (comandos `tarot.*`, views, serviços). Módulos:

| Pasta | Responsabilidade | Estado |
| --- | --- | --- |
| `config/` | Leitura tipada de `tarot.*` (`tarotConfig.ts`) | ✅ |
| `agents/` | Contratos (`types.ts`), `processRunner.ts` (`spawn` seguro, cancelamento, timeout), `runtimeManager.ts` (auto-detecção no PATH + Status Bar), `promptBuilder.ts`, `sessionStore.ts` (`.tarot/sessions/<id>.json`), `adapters/` (`claude`, `codex`, `agy`, `custom`) | ✅ |
| `context/` | Provedores `#` (`#File`, `#Folder`, `#Problems`, `#Git Diff`, `#Terminal`, `#Codebase`, `#Steering`, `#Spec`) | ✅ (ampliar em M3.8c) |
| `checkpoints/` | Snapshot por turno em `.tarot/checkpoints/<session>/<cp>/` e Restore | ✅ |
| `steering/` | `AGENTS.md` + `~/.tarot/steering` + `.tarot/steering`, 4 modos (`always`/`fileMatch`/`auto`/`manual`) | ✅ |
| `specs/` | `specService`, `taskParser`, `taskCodeLensProvider` (Feature/Bugfix EARS, gates, Run Task) | ✅ (M3.6.6/M3.6.7 estendem) |
| `git/` | `gitReviewService` (Review Queue, diff HEAD×working tree, revert, AI Commit Message) · `worktreeManager` (M3.6.7) · Pre-PR Review BYOA (M3.8c) | ✅ (estende em M3.6.7/M3.8c) |
| `views/` | `tarotSidebarViews.ts` (TreeViews) e `agentPanelView.ts` (WebviewView do Tarot Agent) | ✅ |
| `hooks/` | Engine de Agent Hooks `v1` | 📋 M3.7 |
| `permissions/` | `permissions.yaml`, política, parser de shell, trust | 📋 M3.8a |
| `skills/`, `powers/`, `mcp/` | Skills, Powers e `mcp.json` | 📋 M3.8b |
| `workflows/` | Motor de Recipes (`step`/`sequence`/`repeat`/`parallel`/`watch`) | 📋 M3.9a |

UI do painel: `media/webview/{panel.js,panel.css}`. Temas/ícones: `themes/`, `icons/`. Marcos futuros criam as pastas marcadas 📋; consulte a especificação em `docs/MIGRATION_PLAN.md` antes de criá-las.

Convenções: TypeScript `strict`; módulos de lógica pura (parsers, grafos, políticas) **não importam `vscode`** para serem testáveis com `node --test`; serviços recebem dependências no construtor; descarte tudo via `vscode.Disposable`; cancele com `CancellationToken`.

## 2. Paleta Oficial — Tarot Arcana Dark

| Papel | Nome | Hex |
| --- | --- | --- |
| Fundo base | Midnight Cosmic | `#0A0A16` |
| Superfícies/painéis | Deep Indigo | `#1D1135` |
| Primária/seleção | Royal Purple | `#4B0082` |
| Destaque/ênfase | Starlight Gold | `#D4AF37` |
| Sucesso/links/info | Mystic Teal | `#4FD1C5` / `#008080` |
| Erro/alerta/destrutivo | Arcana Red | `#8B0000` |

Regra: **prefira os tokens CSS `--vscode-*`** (ex.: `--vscode-editor-background`, `--vscode-foreground`, `--vscode-button-background`, `--vscode-focusBorder`) para respeitar temas (`Tarot Arcana Dark`, `Tarot Arcana Light` ou temas do Open VSX); use os hex acima apenas em `themes/tarot-{dark,light}-color-theme.json`, SVGs de marca e como fallback `var(--vscode-x, #hex)`. Nunca apague `extensions/theme-*` do upstream.

## 3. Padrões BYOA

- Agentes suportados: `claude`, `codex`, `agy` + qualquer CLI em `tarot.agents.custom`. Cada um é um `AgentAdapter` (`detect()` e `run(request, onEvent, token)`) que emite `AgentEvent` (`text | tool_start | tool_end | diff | error | done`).
- Execução: `spawn(bin, args, { shell: false })` via `processRunner`; resolução de PATH (+ `~/.local/bin`); `SIGTERM` no cancelamento; nunca interpolar prompt em string de shell; nunca logar credenciais. Settings de binários (`tarot.agents.paths.*`, `tarot.agents.custom`) devem usar `"scope": "machine"`; `tarot-core` declara `"extensionKind": ["workspace"]`, `"virtualWorkspaces": false` e `"untrustedWorkspaces": { "supported": "limited" }`.
- O estado é **agnóstico de fornecedor** em `.tarot/` (trocar de agente preserva histórico). Capacidades que o CLI não suporta (MCP, *session resume*, flags de permissão) devem ser declaradas por adaptador e sinalizadas como *advisory* na UI.
- Divergências Kiro × Tarot: ver `docs/MIGRATION_PLAN.md` (tabela ao final da Fase 3) e `docs/KIRO_ARCHITECTURE_REFERENCE.md` §4.

## 4. Specs (EARS), Hooks `v1` e Permissões

- **EARS** — requisito: `WHEN [condição/evento] THE SYSTEM SHALL [comportamento]`. Bugfix (`bugfix.md`): *Current* `WHEN … THEN the system [incorreto]` · *Expected* `WHEN … THEN the system SHALL [correto]` · *Unchanged* `WHEN … THEN the system SHALL CONTINUE TO [existente]`. Estrutura: `.tarot/specs/<slug>/{requirements|bugfix,design,tasks}.md`; tarefas `- [ ]`, opcionais com `*`, `_Requirements: x.y_`.
- **Hooks `v1`** (`.tarot/hooks/*.json`, `~/.tarot/hooks/*.json`): `{ "version": "v1", "hooks": [{ "name", "enabled", "trigger", "matcher", "timeout", "action": { "type": "command"|"agent", "command"|"prompt" } }] }`. Contrato `command`: JSON no STDIN; `exit 0` ⇒ stdout ao contexto; `exit 2` ⇒ bloqueia/cancela. **Nunca executar em workspace não confiável.**
- **Permissões** (`permissions.yaml`): capabilities (`fs_read`, `fs_write`, `shell`, `web_fetch`, `web_search`, `mcp`, `subagent`, `skill`, `power`, `context`, `diagnostics`, `sandbox_network`) × efeitos, prioridade **`deny > ask > allow > evaluate`**, sem precedência entre escopos (o mais restritivo vence). **Permissões do workspace ficam fora do repositório** (ex.: `~/.tarot-ide/workspace-roots/<hash>/permissions.yaml`) para que um repo clonado não injete regras. O agente nunca escreve nos próprios arquivos de permissões/settings.
- **Workspace Trust**: em workspace não confiável não carregar agentes, steering, skills, MCP, workflows nem hooks de `.tarot/`.

## 5. Regras específicas por pasta

- `product.json`: manter identidade Tarot, **Open VSX**, `enableTelemetry: false`, sem `defaultChatAgent`/`GitHub.copilot-chat`. Não colocar `tarot-core` em `builtInExtensions`.
- `resources/**`: assets de marca em `resources/tarot/**`; manifestos de SO (`code.desktop`, `VisualElementsManifest.xml`, `manifest.json`) mantêm o nome Tarot.
- `docs/**`: PT-BR; mantenha `PROJECT_CONTEXT.md` (Seção 5 para qualquer diff em `src/vs/`) e `MIGRATION_PLAN.md` sincronizados com cada entrega.
- `.tarot/**`: artefatos do usuário/workspace; só ler/escrever após checar `vscode.workspace.isTrusted`.

## 6. Checklist antes de concluir qualquer tarefa

1. `pnpm exec gulp compile-extension:tarot-core` → **0 erros**.
2. Se tocou `src/vs/`: `node build/next/index.ts transpile` e `pnpm run typecheck-client`, e registre o diff em `docs/PROJECT_CONTEXT.md` (Seção 5) + matriz de `docs/MIGRATION_PLAN.md`.
3. Valide JSON/manifestos alterados (`python3 -m json.tool <arquivo>`): `package.json`, `package.nls.json`, `product.json`, temas.
4. `rg "innerHTML|shell:\s*true" extensions/tarot-core/src extensions/tarot-core/media` → nenhuma ocorrência.
5. Webview nova/alterada: CSP com `nonce`, `textContent`/DOM seguro, cores via `--vscode-*`.
6. Atualize status e DoD do marco em `docs/MIGRATION_PLAN.md` (e `AGENTS.md` se o "próximo marco" mudar).
7. Commits atômicos em `tarot-main` (nunca em `main`).
