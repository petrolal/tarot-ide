# Tarot IDE — Plano de Migração e Execução (Agent-Ready)

> **Guia de execução estruturado para agentes de IA e engenheiros.**
> Cada etapa abaixo define: **Objetivo**, **Arquivos-Alvo**, **Contratos/Especificação**, **Critérios de Aceite (DoD)** e **Comandos de Verificação**.
> Consulte `docs/PROJECT_CONTEXT.md` para regras obrigatórias, stack e casos de uso (`UC-01` a `UC-11`).
> Os marcos M3.6.6 em diante foram validados contra a leitura direta de `kiro.dev` (specs, workflows, hooks, permissões, agentes, skills, chat, Crew e `topics/frontier-engineering/*`) em 19–20/11/2026; ver `docs/KIRO_ARCHITECTURE_REFERENCE.md` Seção 4.

---

## Mapa Geral de Fases

| Fase | Marco | Status | Próximo Agente Pode Pegar? |
| --- | --- | --- | --- |
| **Fase 1** | Setup do ambiente, fork `microsoft/vscode` (`1.148.0`), branch `tarot-main`, `tarot-core`, licença GPL-3.0 e remote `origin` | ✅ Concluída | — |
| **Fase 2** | Rebranding completo (assets, tema Arcana, 46 ícones, SVGs UI, `nls.ts`, walkthrough, desativação do Copilot, URLs/licença) | ✅ Concluída | — |
| **Fase 3** | **IDE 100% Agêntica (Paridade Kiro IDE + BYOA `claude`, `codex`, `agy`)** | 🚧 **Em progresso (M3.1–M3.8a ✅ · próximo: M3.8b → M3.8c → M3.9a/b/c → M3.10)** | **Sim — iniciar por M3.8b** |
| **Fase 4** | Empacotamento de produção, CLI `tarot`, instaladores e CI/CD | 📋 Planejada | Após M3.9c |
| **Fase 5** | *(Opcional)* "Tarot Crew": bots, webhooks, heartbeat, apps, gateways, ACP | 💤 Backlog | Após Fase 4 |
| **Contínuo** | Sincronização periódica com `upstream` (`microsoft/vscode`) | 🔄 Recorrente | Conforme releases |

---

## Histórico Consolidado (Fases 1 e 2 — Concluídas ✅)

Commits de referência na branch `tarot-main`:
- `6763816a` — Setup inicial, rebranding `product.json`, tema **Tarot Arcana Dark**, ícones de SO/web, `extensions/tarot-core` e docs.
- `fea4ec6e` — Substituição dos SVGs internos do workbench (`code-icon.svg`, `vscode-icon.svg`, `letterpress-*.svg`).
- `8af8dfbb` — Tema de ícones de pastas/arquivos **Tarot Arcana Icons** (46 SVGs) como padrão.
- `b11b77c1` — Rebranding centralizado de strings UI em `src/vs/nls.ts`, atualização do playground Markdown e Walkthrough `Get Started with Tarot IDE`.
- `9d838ac9` — Desativação limpa do Copilot (`product.json`, `scripts/code.{sh,bat}`), 5 guards contra `defaultChatAgent === undefined` e scripts rápidos `*-tarot*` no `package.json`.

**Pendências administrativas encerradas:**
- [x] Licença **GNU GPL v3.0** configurada (`LICENSE`, `LICENSE.txt`, `NOTICE.md` com Copyright `Lucas Petrola` + atribuição obrigatória GPLv3 §7(b) + nota de dual-licensing comercial, preservando MIT do upstream em `LICENSE-VSCODE-MIT.txt`).
- [x] Repositório remoto `origin` conectado (`https://github.com/petrolal/tarot-ide.git`) e URLs (`licenseUrl`, `serverLicenseUrl`, `reportIssueUrl`) atualizadas em `product.json`.
- [ ] *(Opcional)* Substituir bitmaps `resources/win32/inno-*.bmp` antes do primeiro release Windows.

---

## Fase 3 — Arquitetura 100% Agêntica (Layout & Workflow Kiro + BYOA)

> **Princípio de execução**: todas as entregas da Fase 3 residem em **`extensions/tarot-core/`**. Não alterar `src/vs/` salvo justificativa explícita na especificação do marco.
> **Consistência visual obrigatória (todos os marcos M3.6.6–M3.10)**: toda nova view/webview (Specs, Hooks, Permissões, Workflows, Sessions/Tarot Agent Mode, Schedule) deve herdar o mesmo design system **Clean Kiro + Arcana** em **Dark e Light (`body.vscode-light`)**: superfícies limpas com bordas sutis, tokens `--vscode-*`, ícones `icons/arcana/{,light/}*.svg` (`{ light, dark }`) e a tríade **roxo (ações/seleção) · ouro (headers/cartas) · teal (sucesso/checks/contexto)**.

### Arquitetura Alvo dentro de `extensions/tarot-core/`

```text
extensions/tarot-core/
├── package.json                 # Views (Activity Bar esquerda + Secondary Side Bar direita), comandos e settings tarot.*
├── src/
│   ├── extension.ts             # Bootstrap e composição de todos os módulos
│   ├── config/
│   │   └── tarotConfig.ts       # Leitura tipada de configurações tarot.*
│   ├── agents/
│   │   ├── types.ts             # Interfaces AgentAdapter, AgentInfo, AgentSession, AgentEvent
│   │   ├── runtimeManager.ts    # Auto-detecção no PATH (claude, codex, agy) + status + seleção ativa
│   │   ├── processRunner.ts     # Execução segura spawn(bin, args, { shell: false }), cancelamento, timeouts
│   │   └── adapters/
│   │       ├── claudeAdapter.ts # Adaptador para Claude Code CLI (`claude`)
│   │       ├── codexAdapter.ts  # Adaptador para OpenAI Codex CLI (`codex`)
│   │       └── agyAdapter.ts    # Adaptador para Antigravity CLI (`agy`)
│   ├── steering/
│   │   └── steeringService.ts   # Descoberta e montagem de contexto `.tarot/steering/*.md`
│   ├── specs/
│   │   ├── specService.ts       # CRUD de `.tarot/specs/<slug>/{requirements,design,tasks}.md`
│   │   └── taskParser.ts        # Parser de checklists `- [ ]` / `- [x]` em `tasks.md`
│   ├── hooks/
│   │   └── hookEngine.ts        # Engine `.tarot/hooks/*.json` ligada a eventos do workspace (respeitando Workspace Trust)
│   └── views/
│       ├── tarotSidebarViews.ts # TreeViews na barra lateral esquerda (Specs, Hooks, Steering, Agents)
│       └── agentPanelView.ts    # WebviewView na Secondary Side Bar (Painel Agêntico Vibe/Spec + streaming + diffs)
└── media/
    └── webview/                 # CSS/JS do Painel Agêntico (CSP estrita + paleta Arcana)
```

---

### Marcos Concluídos da Fase 3 (M3.1 – M3.6.5 + Saneamento Pré-M3.6.6 — ✅ Concluídos)

| Marco | Escopo entregue em `extensions/tarot-core/` |
| --- | --- |
| **M3.1** (UC-01) | `tarotConfig`, `agents/{types,processRunner,runtimeManager}`: auto-detecção segura (`shell: false`) de `claude`, `codex`, `agy` + `tarot.agents.custom`, Status Bar e comandos `tarot.agents.*`. |
| **M3.2** (UC-01, UC-02) | Layout Kiro: container esquerdo **Tarot** (4 TreeViews: Specs, Hooks, Steering, Local Agents) + **Tarot Agent** (`WebviewView`) na Secondary Side Bar com CSP estrita (`nonce`) e zero `innerHTML`. |
| **M3.3** (UC-02, UC-06) | Adaptadores reais (`claude`, `agy`, `codex`, `custom`), `promptBuilder`, `sessionStore` agnóstico em `.tarot/sessions/<id>.json`, streaming, cancelamento `SIGTERM` e handoff entre agentes. |
| **M3.4** (UC-02) | Paridade visual do painel Kiro: abas multi-sessão, disclosures (`Thought complete`, `tool calls`, `Elapsed time`), composer Kiro (`#`, `📎`, `○`, agente, modo, `Autopilot`), `contextProviders` (`#File`, `#Folder`, `#Codebase`, `#Problems`, `#Terminal`, `#Git Diff`, `#Steering`) e `checkpointService` (`Restore Checkpoint`). |
| **M3.5** (UC-04) | `steeringService`: descoberta hierárquica (`AGENTS.md`, `~/.tarot/steering`, `.tarot/steering`), 4 modos de inclusão (`always`, `fileMatch`, `auto`, `manual`) e comando `tarot.steering.generate` (`product.md`, `tech.md`, `structure.md`). |
| **M3.6** (UC-03) | `specs/{specService,taskParser,taskCodeLensProvider}`: Feature Spec (Requirements-First e Design-First em EARS), Bugfix Spec (`bugfix.md`), gates entre fases, card `Updated task list` e CodeLens `▶ Run Task` / `Run Task with...`. |
| **M3.6.5** (UC-02, UC-03) | Boot Agent-First (Secondary Side Bar + Command Center visíveis, minimap desligado por padrão), Review Queue (`git/gitReviewService.ts`, diff HEAD×working tree, revert), popup `/` de Slash Commands, `#Spec`, `Ctrl+L` (*Send Selection*), Dockable Chat Tab (`⤢`), Agent Focus Mode toggle, AI Commit Message (`✦`), **Clean Kiro Visual Polish** (base neutra grafite-violeta sem faixa em L no gutter/breadcrumb, sintaxe equilibrada Dark/Light, bordas sutis, abas minimalistas, header `Tarot`, Status Bar discreta) e **Model & Effort Popover** estilo Kiro (botões customizados sem `<select>` nativo, seleção de CLI + modelos dinâmicos via `agy models` / presets + Reasoning Effort `Auto/Low/Med/High/XHigh/Max`). |
| **M3.6.5-bis** (saneamento pré-M3.6.6) | Consistência de idioma, manifesto e template de Hooks — sem novo marco funcional. Ver abaixo. |

---

### Saneamento Pré-M3.6.6 (✅ Concluído)

Três inconsistências encontradas na auditoria do fork, resolvidas antes de iniciar M3.6.6:

1. **Template de Agent Hook desatualizado**: `tarot.hooks.create` gerava um JSON no formato legado (`trigger: "onSave"`, `glob`, `agent`, `prompt` no topo). Agora emite o **schema `v1`** (`.tarot/hooks/*.json`): `{ "version": "v1", "hooks": [{ name, description, enabled, trigger: "PostFileSave", matcher, timeout, action: { type, prompt } }] }`, alinhado à especificação de M3.7 e ao `KIRO_ARCHITECTURE_REFERENCE.md`. O *prompt* do hook continua em PT-BR (conteúdo dirigido ao agente).
2. **Comandos registrados mas não declarados**: `tarot.agents.selectById`, `tarot.specs.runTask` e `tarot.specs.runTaskWith` existiam em runtime porém ausentes de `contributes.commands` — invisíveis na Command Palette e não vinculáveis a atalhos. Foram declarados com títulos em `package.nls.json` (`command.agents.selectById.title`, `command.specs.runTask.title`, `command.specs.runTaskWith.title`) e ocultados da Palette via `contributes.menus.commandPalette` com `"when": "false"` (são invocados com argumentos por *inline action* de TreeView e CodeLens).
3. **UI bilíngue**: o manifesto, o walkthrough e o painel já eram em Inglês, enquanto as mensagens de código eram PT-BR hardcoded. Foi aplicada a divisão de idioma formalizada em `PROJECT_CONTEXT.md` §3.5: **chrome da UI em Inglês via `vscode.l10n.t()`** (novo catálogo `src/views/panelStrings.ts` injetado na webview como `window.__tarotL10n`, consumido por `t(key, ...)` em `media/webview/panel.js`) e **prompts/templates gerados em PT-BR**. Bundles de tradução ficam para a Fase 4.

- **Arquivos-alvo**: `src/extension.ts`, `src/agents/{runtimeManager,sessionStore}.ts`, `src/agents/adapters/*.ts`, `src/checkpoints/checkpointService.ts`, `src/context/contextProviders.ts`, `src/git/gitReviewService.ts`, `src/specs/taskCodeLensProvider.ts`, `src/views/{agentPanelView,tarotSidebarViews,panelStrings}.ts`, `media/webview/panel.js`, `package.json`, `package.nls.json`.
- **DoD**: `pnpm exec gulp compile-extension:tarot-core` com 0 erros; `package.json`/`package.nls.json` válidos; nenhuma ocorrência de `innerHTML`/`shell: true`; strings de UI externalizadas com `vscode.l10n.t()` (PT-BR remanescente apenas em prompts/templates).

---

### Marco M3.6.6 — Specs: UX Kiro (Stepper, Modos de Sessão, Quick Spec, Analyze Requirements, Markdown Review, PBT no Transcript) + Testes Base (UC-03) — ✅ Concluído
- **Fonte**: `kiro.dev/docs/specs/*` (Feature, Bugfix, Quick Spec, Analyze Requirements, Correctness, Best Practices) + Print 1.
- **Objetivo**: fechar a paridade de UX de Specs e iniciar a cobertura de testes unitários em `extensions/tarot-core/`.
- **Arquivos-alvo**:
  - `extensions/tarot-core/src/specs/specStepper.ts` (barra/CodeLens `📋 <slug> [1 Requirements] > [2 Design] > [3 Task list]` no topo de `.tarot/specs/<slug>/*.md`)
  - `extensions/tarot-core/src/specs/specService.ts` (modos Quick Spec, Plan, Analyze Requirements, "Generate spec" a partir de sessão Vibe)
  - `extensions/tarot-core/src/specs/markdownReview.ts` (comentários por trecho enviados em lote ao agente)
  - `extensions/tarot-core/src/views/agentPanelView.ts` + `media/webview/{panel.js,panel.css}` (tela **"Let's build"**, cards de tool calls, bloco de `Counter-example`)
  - `extensions/tarot-core/src/test/**` (suíte unitária: `taskParser`, `steeringService`, `promptBuilder`, `gitReviewService`, `specService`)
- **Especificação**:
  - **Tela inicial "Let's build"** com seletor opcional de modo de sessão e cartas ilustradas (`media/arcana/*.png` via `asWebviewUri`): **Vibe** (`00-the-fool.png`), **Spec** (`05-the-hierophant.png`), **Plan** (`09-the-hermit.png`, somente plano, sem alterar arquivos), **Bug Fix** (`16-the-tower.png`) e **Quick Spec** (perguntas de esclarecimento → gera `requirements.md`/`design.md`/`tasks.md` sem portões de aprovação). Sem escolha = agente **Default**. Configuração `tarot.specs.defaultWorkflow` para pular a escolha.
  - **Stepper** `1 Requirements > 2 Design > 3 Task list` (Bugfix usa `bugfix.md`); no Design-First a ordem é Design → Requirements → Tasks.
  - **Analyze Requirements**: ação no menu **Continue** do editor (e no chat) que detecta inconsistências lógicas, ambiguidades, restrições conflitantes e lacunas antes do Design.
  - **Markdown Review**: botão flutuante **Review** em `requirements`/`design`/`bugfix` para comentar trechos exatos e enviar todos os comentários de uma vez ao agente.
  - **"Generate spec"** dentro de uma sessão Vibe pergunta se deve iniciar sessão Spec reaproveitando o contexto.
  - **Transcript**: tool calls em cards individuais (`Replace in File`, `Write File` com chip do arquivo e `✓`); falha de PBT exibe `Counter-example:` (input reduzido por *shrinking*, ícone `icons/arcana/16-the-tower.svg`) e `Error:`; ao corrigir, o agente pode salvar a regra aprendida em `.tarot/steering/`.
  - **Testes de Fronteira vs Unitários nas Specs** (*Frontier Engineering*): templates de `design.md` e `tasks.md` separam explicitamente **testes de contrato/fronteira** (integração/E2E e PBT de invariantes, preserváveis em reescritas) de testes unitários acoplados à implementação; a suíte base em `src/test/` roda lógica pura via `node --test` (sem importar `vscode`) como *fast feedback loop* determinístico.
- **Critérios de Aceite (DoD)**:
  - [x] Abrir qualquer arquivo de Spec exibe o stepper clicável com a etapa ativa.
  - [x] "Let's build" oferece Spec / Plan / Bug Fix / Quick Spec; Plan não escreve arquivos; Quick Spec gera os 3 artefatos sem gates.
  - [x] **Analyze Requirements** e **Markdown Review** funcionam sobre `requirements.md`/`bugfix.md`/`design.md`.
  - [x] `Counter-example:` e tool calls aparecem estruturados no transcript.
  - [x] Suíte unitária inicial (lógica pura sem `vscode`) executa e passa via CLI (`node --test "extensions/tarot-core/out/test/**/*.test.js"`).

---

### Marco M3.6.7 — Motor de Tarefas de Spec (Run All Tasks em Ondas, Opcionais `*`, Sync Files, Rastreabilidade, Per-Task Diff & Worktrees) (UC-03) — ✅ Concluído
- **Fonte**: `kiro.dev/docs/specs/` (Task Execution / Parallel tasks), Best Practices (Sync Files, import de requisitos), `topics/frontier-engineering/` e Print 1.
- **Arquivos-alvo**: `extensions/tarot-core/src/specs/{taskParser,taskGraph,taskRunner,taskCodeLensProvider,specSync}.ts`, `extensions/tarot-core/src/git/worktreeManager.ts`, `checkpointService.ts`.
- **Especificação**:
  - **Run all Tasks**: monta grafo de dependências de `tasks.md` e agrupa tarefas independentes em **ondas** (Wave 1 = sem dependências, Wave 2 = dependências satisfeitas pela Wave 1…); ondas em sequência, tarefas da mesma onda em paralelo. Executa só tarefas **incompletas e obrigatórias**.
  - **Git Worktrees Gerenciados (`git/worktreeManager.ts`)**: serviço leve (criar, listar, aplicar/cherry-pick ou descartar worktree isolado) usado opcionalmente por tarefas paralelas de uma onda (e reutilizado em M3.8c/M3.9a para sessões paralelas e prototipação comparativa de 2 designs lado a lado sem conflito de arquivos).
  - **Tarefas opcionais** marcadas com `*` (ex.: testes PBT, docs extras); escolha na criação: *manter opcionais (MVP rápido)* ou *tornar tudo obrigatório*. PBTs são opcionais por padrão.
  - **Rastreabilidade**: cada tarefa referencia `_Requirements: 1.1, 1.2_`; tarefas de PBT trazem `**Property N: ...**` e `**Validates: Requirements x.y**`; passar o mouse numa propriedade no `design.md` mostra requisito e tarefa ligados.
  - **Estados em tempo real**: `in progress` / `completed` na lista; CodeLens pós-conclusão `✓ Task completed | ↺ View changes` (diff **por tarefa**, exige checkpoint por tarefa) + gutter verde.
  - **Sync Files** em `tasks.md`: regera/atualiza tarefas após mudança em requirements/design (Requirements-First e Design-First); specs permanecem sincronizados com o código evolutivo.
  - **Design-First com importação**: anexar PNG/JPG (draw.io, whiteboard), colar texto de design, `#arquivo.md Generate a spec from it`, ou importar via MCP (Jira/Confluence); Kiro formaliza `design.md` e deriva requisitos. Referência `#spec:nome implement task 2.1`.
  - **PBT**: propriedades extraídas dos requisitos EARS na fase de Design; execução sob demanda; falha vira cartão com opções (corrigir implementação, ajustar teste ou refinar requisito). Bugfix gera PBTs para: bug reproduzível, fix correto e comportamento inalterado preservado.
- **Critérios de Aceite (DoD)**:
  - [x] **Run all Tasks** executa em ondas respeitando dependências e ignora tarefas opcionais/concluídas. *(`taskGraph.computeTaskWaves` + `taskRunner.runTaskWaves`, puros/testados via `node --test`; execução dentro de uma onda é sequencial nesta primeira entrega — paralelismo real de sessões fica para M3.8c/M3.9a, que reutilizam `worktreeManager.ts`.)*
  - [x] `*` e `_Requirements:_`/`Validates:` são parseados, preservados e exibidos. *(`taskParser.ts` adiciona `optional`, `requirementRefs`, `dependsOn`, `property`, `validates`; CodeLens exibe `(optional)` no tooltip e mantém o texto original da linha.)*
  - [x] `View changes` abre o diff isolado de uma tarefa; **Sync Files** gera tarefas novas sem apagar as concluídas. *(`checkpointService.getCheckpointDiff` + `specTaskCheckpoints.ts` + comando `tarot.specs.viewTaskChanges` abrem `vscode.diff` por arquivo; `specSync.mergeTasksMarkdown` reconcilia a regeneração do agente preservando/anexando tarefas já concluídas — comando `tarot.specs.syncFiles`.)*

---

### Marco M3.7 — Agent Hooks Engine `v1` (Arquivo + Ferramenta + Prompt + Ciclo de Vida + Compaction + Task) (UC-05) — ✅ Concluído (DoD) · Compaction/SessionStart·End/PermissionRequest adiados
- **Fonte**: `kiro.dev/docs/hooks/` (+ `hooks/types`, `hooks/actions`) e blog `introducing-kiro`.
- **Arquivos-alvo**: `extensions/tarot-core/src/hooks/{hookEngine,hookTypes,hookRunner,hookMigration}.ts`; integração em `tarotSidebarViews.ts` e `agentPanelView.ts`.
- **Schema `v1`** (`.tarot/hooks/*.json` e `~/.tarot/hooks/*.json`, vários hooks por arquivo; global e workspace rodam juntos):
  ```json
  { "version": "v1",
    "hooks": [ {
      "name": "Lint on save", "description": "opcional", "enabled": true,
      "trigger": "PostFileSave", "matcher": "\\.(ts|tsx)$",
      "timeout": 60,
      "action": { "type": "command", "command": "npx eslint --fix" } } ] }
  ```
- **Triggers** (disponibilidade por superfície da doc; Tarot aceita aliases de nome):
  - **Prompt/turno**: `PromptSubmit` (`UserPromptSubmit`; variável `USER_PROMPT`; em ação `agent` o prompt é *anexado* ao do usuário; pode **bloquear** o envio), `Stop`/`AgentStop` (fim do turno).
  - **Sessão**: `SessionStart`, `SessionEnd`.
  - **Compaction**: `PreCompaction` (exit `2` cancela a compaction), `PostCompaction` (saída volta ao contexto).
  - **Ferramenta**: `PreToolUse` (exit `2` **bloqueia** a ferramenta), `PostToolUse`, `PermissionRequest` (responde `allow`/`deny` ao prompt de permissão via `hookSpecificOutput.decision`; nunca sobrepõe `deny` de política nem prompts protegidos).
  - **Arquivo** (regex no caminho): `PostFileCreate`, `PostFileSave`, `PostFileDelete`.
  - **Tarefa de Spec**: `PreTaskExecution`, `PostTaskExecution`.
  - **Manual**: botão Play na TreeView.
- **`matcher` de ferramenta**: ID da ferramenta, tag de categoria (`read`, `write`, `shell`), `@mcp`, `@<servidor>`, wildcard ou regex.
- **Contrato do `command`**: contexto como JSON no **STDIN** (`hook_event_name`, `cwd`, `session_id`, arquivo/ferramenta); `exit 0` ⇒ STDOUT entra no contexto do agente; `exit 2` ⇒ bloqueia (PreToolUse/PromptSubmit) ou cancela (PreCompaction); outro código ⇒ STDERR vira aviso ao usuário/agente; `timeout` padrão 60 s (`0` desativa). Ação `agent` consome tokens (novo loop); `command` não.
- **`confirm` em hooks `Stop` com `command`**: pergunta + opções (`id`, `label`, `run`), opcional `confirmCommand` que devolve `{ "skip": true }` ou pergunta/opções dinâmicas (fallback para a estática se falhar).
- **Criação**: botão `+` → **Ask Tarot to create a hook** (linguagem natural gera o JSON) + **presets built-in de guardrails determinísticos** (*secret/credential scan* em diff/output, lint/typecheck em `Stop`/`PreToolUse`); itens de Hooks na TreeView usam `icons/arcana/10-wheel-of-fortune.svg`; on-demand manual = *steering* `inclusion: manual` invocado por `/nome`. *(Pré-requisito já entregue no saneamento pré-M3.6.6: `tarot.hooks.create` grava o template no schema `v1` com ação `agent`.)*
- **Segurança**: fila serial por hook, debounce, **nenhum hook roda em workspace não confiável**, escrita em `.tarot/hooks/` sempre pede confirmação (ver M3.8a).
- **Critérios de Aceite (DoD)**:
  - [x] Triggers de arquivo, `PromptSubmit`, `Stop`, `PreToolUse`/`PostToolUse` funcionam para `command` e `agent`, com toggle, `timeout` e Play. *(`hooks/{hookTypes,hookMigration,hookRunner,hookEngine}.ts` puros/testados (28 testes); `tarot.hooks.toggle` grava `enabled` com confirmação, `tarot.hooks.runManual` é o botão Play da TreeView (`HooksTreeProvider`, agrupada Workspace/Global); `timeout` honrado em `runHookCommand`. `PostToolUse` depende de um evento `tool_end` novo nos adaptadores: `claudeAdapter` correlaciona `tool_use_id`↔`tool_result` de verdade; `codexAdapter`/`agy` reportam a ferramenta só depois de concluída, então `tool_start`+`tool_end` disparam juntos — aproximação honesta dado o protocolo de cada CLI.)*
  - [x] `PreToolUse` com `exit 2` bloqueia a ferramenta; `PromptSubmit` pode bloquear o envio. *(`PromptSubmit` bloqueia de verdade antes de chamar `adapter.run` — nenhum processo chega a nascer. Para `PreToolUse`, nenhuma CLI BYOA expõe um canal para negar uma tool call já despachada antes que ela rode (ver "Divergências conhecidas Kiro × Tarot" abaixo); `exit 2` aqui cancela a sessão ativa via `SIGTERM` assim que a negação chega, impedindo qualquer tool/edição seguinte no mesmo turno — bloqueio real de continuação, não da chamada já em voo. Full pre-execution gating fica para quando M3.8a/M3.8b trouxerem um protocolo de permissão bidirecional com os CLIs.)*
  - [x] Nenhum hook executa automaticamente em workspaces não confiáveis. *(Todo gatilho automático — file watchers, `PromptSubmit`/`Stop`/`PreToolUse`/`PostToolUse` em `runPrompt`, `PreTaskExecution`/`PostTaskExecution` em `runSpecTaskInternal` — checa `vscode.workspace.isTrusted` antes de descobrir hooks; o Play manual também exige trust.)*
  - *(Adiado, fora do DoD)*: `SessionStart`/`SessionEnd`, `PreCompaction`/`PostCompaction` (sem mecanismo de compaction ainda — chega em M3.8c) e `PermissionRequest` (sem protocolo de permissão bidirecional com os CLIs — chega em M3.8a/M3.8b). O schema/engine já aceitam esses triggers; só faltam os pontos de disparo.

---

### Marco M3.8a — Permissões Baseadas em Capacidades (`permissions.yaml`), Modos de Permissão e Workspace Trust (UC-06) — ✅ Concluído (DoD) · cartão de aprovação webview e flags nativas de claude/codex adiados
- **Fonte**: `kiro.dev/docs/permissions/`, `custom-agents/subagents`, `ide/chat`, `workflows` (Security and trust).
- **Arquivos-alvo**: `extensions/tarot-core/src/permissions/{permissionsService,policyEngine,shellParser,presets,trustService}.ts`; UI de aprovação em `agentPanelView.ts`.
- **Especificação**:
  - **Capabilities**: `fs_read`, `fs_write`, `shell`, `web_fetch`, `web_search`, `mcp`, `subagent`, `skill`, `power`, `context`, `diagnostics`, `sandbox_network`; meta: `all` (exceto `sandbox_network`), `builtin`, `filesystem`.
  - **Efeitos** e prioridade `deny > ask > allow > evaluate`; **sem precedência entre escopos** (o mais restritivo vence). Regras com `match` e `exclude` (globs: FS usa `*`/`**`/`{a,b}`; shell/web/MCP só `*`).
  - **Escopos**: *Tarot* (invariantes fixas), *administration* (opcional), *user* (`~/.tarot/settings/permissions.yaml`), *workspace* (**armazenado fora do repositório**, ex. `~/.tarot-ide/workspace-roots/<hash>/permissions.yaml`, para que um repo clonado não injete regras), *agent* (campo `permissions` do agente), *session* (decisões da sessão).
  - **Parser de shell**: comandos compostos (`;`, `&&`, `||`, `|`) são divididos e avaliados um a um; flags combinadas são analisadas; comandos não analisáveis são bloqueados com pedido de reescrita ao agente.
  - **Invariantes**: o agente **nunca** escreve em arquivos de permissões/settings, `.tarotignore` ou estados internos; **sempre pergunta** para `.git/**`, `.vscode/**`, `*.code-workspace` e diretórios `agents/`, `hooks/`, `workflows/`, `powers/` do `.tarot`.
  - **Presets**: `allow-all`, `edit-workspace`, `read-workspace`, `read-all`, `read-only-shell`, `dev-shell`, `approve-for-me` (`evaluate` depende de classificador; indisponível ⇒ sem regras).
  - **Padrão sem configuração**: leitura do workspace e `git` somente-leitura permitidos; todo o resto pergunta. **Headless**: `ask` vira `deny`.
  - **Modos de permissão no composer** (substituem o toggle binário Autopilot): **Supervised** (aprova por turno com edições, hunks aceitar/rejeitar/discutir), **Accept file changes** (equivale ao antigo Autopilot) e **Approve for me**. O switch atual vira atalho para *Accept file changes*.
  - **Workspace Trust ampliado**: em workspace não confiável **não carregar** agentes, steering, skills, MCP e workflows do `.tarot/`; perguntar antes de **todo** shell/MCP/Power (inclusive com regra `allow`); decisão guardada fora do workspace.
  - **Sub-agentes**: cada chamada é avaliada contra a política da sessão pai **e** a do sub-agente; vence a mais estrita; regra `allow` do sub-agente nunca excede o pai; capability `subagent` só controla o *início*.
  - **Cartões de aprovação** no transcript (*Allow / Deny / Always allow / Always deny* ou feedback, ícone `icons/arcana/05-the-hierophant.svg` nos cartões de aprovação e política `permissions.yaml`), destacando visualmente **ações reversíveis vs irreversíveis** (ex.: escrita em workspace com checkpoint vs deploy/delete/rede externa), e estado *parked* (`🔒 N sub-agent needs approval`).
- **⚠ Risco BYOA**: Tarot só **impõe** regras nas ações que passam por ele (hooks, git, checkpoints, ferramentas próprias). Para `claude`/`codex`/`agy` as regras são **traduzidas em flags nativas** (permission mode, sandbox, allow/deny lists) quando existirem e marcadas como **advisory** quando o CLI não suportar — a UI deve mostrar *enforced* vs *advisory*.
- **Critérios de Aceite (DoD)**:
  - [x] `permissions.yaml` (user + workspace externo) avaliado com deny-overrides, `match`/`exclude` e parser de shell composto. *(`permissions/{permissionTypes,yamlLite,shellParser,presets,policyEngine}.ts` puros/testados (37 testes novos); `permissionsService.ts` carrega `tarot` (invariantes fixas) + `user` (`~/.tarot/settings/permissions.yaml`) + `workspace` (`~/.tarot-ide/workspace-roots/<hash>/permissions.yaml`, fora do repo, hash do path absoluto, só se o workspace for confiável) + `session` (em memória, "Always allow/deny"); `deny > ask > allow > evaluate` sem precedência entre escopos (o mais restritivo de qualquer escopo vence); glob completo (`*`/`**`/`?`/`{a,b}`) para `fs_read`/`fs_write`, wildcard só `*` para shell/web/mcp; `evaluate` sem classificador não contribui decisão (preset `approve-for-me` hoje equivale a "sem regras extras"). Escopos `administration` e `agent` ficam vazios até existir um perfil de administração e Custom Agents (M3.8b).)*
  - [x] Os 3 modos de permissão funcionam e o estado *enforced/advisory* é visível por agente. *(`AutonomyMode` passa a `supervised | acceptFileChanges | approveForMe`, substituindo o toggle binário *Autopilot* do composer por um seletor de 3 opções (mesmo padrão do seletor de *Mode*); um ponto ao lado mostra *enforced* (teal — ações do próprio Tarot: hoje só hooks `command`) vs *advisory* (dourado — CLIs BYOA) com tooltip explicando a tradução. `agy` já tinha uma flag nativa traduzida (`--mode accept-edits`); `claude` passou a ter a sua também — ver item 19 dos Débitos Técnicos: sem `--permission-mode`, `claude -p` rodava no seu próprio padrão (`manual`), que nega toda edição/Bash não-leitura em modo headless sem host de permissão, deixando *Accept File Changes*/*Approve For Me* sem efeito real algum no CLI. `codex` continua 100% advisory — equivalente não verificado ainda (CLI não disponível para teste neste ciclo).)*
  - [x] Workspace não confiável não carrega nada de `.tarot/` e pergunta antes de shell/MCP. *(Hooks já paravam em workspace não confiável desde M3.7; agora `steeringService.resolveForTurn` e o provider `#steering` também checam `vscode.workspace.isTrusted` antes de ler `.tarot/steering/`. Toda execução de hook `command` passa pelo `policyEngine` via `permissionsService.createGatedRunCommand`: `deny` bloqueia sem rodar o processo, `ask` exibe um cartão de aprovação (Allow/Always Allow/Deny/Always Deny) — ou vira `deny` silencioso em gatilhos automáticos de arquivo (`headless: true`), evitando um pop-up a cada save. MCP ainda não existe no código (chega em M3.8b), então "perguntar antes de MCP" não se aplica ainda.)*
  - *(Adiado, fora do DoD)*: o cartão de aprovação é hoje um `showWarningMessage` modal nativo do VS Code, não (ainda) um cartão desenhado no transcript do webview com o ícone `icons/arcana/05-the-hierophant.svg`; tradução de modos de permissão em flags nativas de `claude`/`codex`; política aplicada a git/checkpoints; herança de política por sub-agente (sem sub-agentes ainda). Esses itens chegam com M3.8b/M3.9a conforme os recursos que dependem deles existirem.
- **Revisão de código pós-M3.8a (2026-11-22)**, antes do primeiro commit do marco — 3 achados corrigidos no mesmo ciclo:
  1. **Bypass do allowlist de `git` somente-leitura**: `isReadOnlyGitCommand` olhava só o subcomando (`git show`/`git diff`/...), então `git show HEAD:f > ~/.bashrc` caía no `allow` padrão por não checar redirecionamento de shell — escrita arbitrária sob uma política "allow". Corrigido com `hasUnquotedRedirection` em `policyEngine.ts` (+ teste de regressão em `policyEngine.test.ts`).
  2. **Prompt sem limite de tamanho via argv**: todo adapter BYOA (`claude`/`codex`/`agy`/custom) embute o prompt inteiro — incluindo anexos/Steering sem cap — como um único argumento de CLI; em tamanho real isso arrisca `E2BIG`/`ENAMETOOLONG` do SO (crítico no Windows, ~32k chars de limite de `CreateProcess`). Mitigado com `agents/commandLineLimits.ts` (checagem antes do `spawn`, com erro claro em vez de falha opaca do SO) + cap de 50k chars por seção em `promptBuilder.ts` (nunca trunca o prompt do próprio usuário).
  3. **TreeViews carregando `.tarot/**` sem checar Trust**: `HooksTreeProvider`, `SteeringTreeProvider` (incluindo o `AGENTS.md` da raiz como Steering) e `SpecsTreeProvider` populavam a árvore antes de `vscode.workspace.isTrusted` — um repo clonado malicioso podia ter seu `.tarot/` carregado na UI (e, via Steering, no contexto do agente) antes do usuário confiar explicitamente. Corrigido com gate de trust + `refresh()` em `onDidGrantWorkspaceTrust` nas 3 views.
  - Commits: `57cd30c1601` (M3.8a completo, inclui a correção 1) e `ee1673639cd` (correções 2 e 3, isoladas).

---

### Marco M3.8b — Skills, Custom Agents, Sub-agentes, Powers, MCP & Adaptador Universal ACP (UC-06)
- **Fonte**: `kiro.dev/docs/{skills,custom-agents,custom-agents/subagents,powers,mcp,steering}/` + Agent Client Protocol (ACP).
- **Arquivos-alvo**: `extensions/tarot-core/src/{skills/skillsService,agents/customAgentService,agents/subagentManager,agents/adapters/acpAdapter,agents/agentCatalog,powers/powersService,mcp/mcpConfigService}.ts`; ajustes em `steeringService.ts` e `runtimeManager.ts`.
- **Especificação**:
  - **Descoberta Dinâmica & ACP (`acpAdapter.ts` + `agentCatalog.ts`)**: introduzir um adaptador genérico **ACP (Agent Client Protocol via stdio)** compatível com qualquer CLI ACP (`agy acp`, `kiro-cli`, `opencode`, `goose`, bridges de Claude/Codex, etc.) + catálogo declarativo de presets (mantendo `claude`, `codex`, `agy` prontos *out-of-the-box*, mas sem exigir uma classe TS hardcoded para cada novo CLI).
  - **Skills** (padrão *Agent Skills*): pasta com `SKILL.md` (+ `scripts/`, `references/`) em `.tarot/skills/` e `~/.tarot/skills/`; *progressive disclosure* (só nome+descrição no início, instruções completas ao casar com o pedido ou via `/nome [args]` / `$nome`); workspace vence global; **Import skill** (URL de repo GitHub/GitLab apontando subpasta, ou pasta local); skill ≥ 30.000 caracteres carrega por inteiro se couber.
  - **Custom agents**: `.tarot/agents/<nome>.{md,json}` e `~/.tarot/agents/` (subpastas ⇒ `team/planner`; workspace vence). Campos: `name`, `description`, `tools`, `excludedTools`, `includeMcpJson`, `includePowers`, `resources` (`file://`, `skill://`), `permissions`, `prompt`, `model`, `welcomeMessage`. **Seletor de agente** no composer agrupado em *Built-in* (Default, Spec, Quick Spec, Bug Fix, Plan) / *User* / *Workspace*; troca mantém histórico e permissões; desabilitado durante execução multi-passo.
  - **Sub-agentes**: janela de contexto isolada, herdam steering, MCP, acesso a arquivos e permissões; **DAG** planejado de antemão e imutável; **review loops** (`target`, `trigger` ≥ 4 caracteres, `max_iterations` 1–10; sem loop em si mesmo nem mútuo); built-ins: *Context gathering*, *General purpose*, *Validation*; execução paralela; orquestrador precisa da tool `subagent`.
  - **Powers** (formato *Agent Plugins*): `plugin.json` (keywords de ativação) + `skills/` + `mcp.json`; ativam sob demanda e desativam ao mudar de assunto; instalação por registry ou URL GitHub; Powers ⊃ Skills; Steering é contexto específico do Tarot (ícone `icons/arcana/02-high-priestess.svg` em Skills/Powers/Steering).
  - **MCP**: `.tarot/settings/mcp.json` + `~/.tarot/settings/mcp.json`, servidores locais (stdio) e remotos (URL + headers), TreeView **MCP Servers**, `#mcp`, sincronização com os CLIs.
  - **Steering (complementos de M3.5)**: modo `auto` exige `name`+`description`; `fileMatchPattern` aceita array; referências vivas `#[[file:<caminho>]]`; `AGENTS.md` também em **subdiretórios**; steering `manual`/`auto` aparecem como comandos `/`.
- **Critérios de Aceite (DoD)**:
  - [ ] Skills carregam por *progressive disclosure*, são invocáveis por `/` e importáveis por URL/pasta.
  - [ ] Custom agents aparecem no seletor agrupados por origem e respeitam `tools`/`permissions`.
  - [ ] Sub-agente herda a política do pai (mais estrita vence) e roda com contexto isolado.
  - [ ] TreeView lista MCP; `#mcp` e ativação de Powers por keyword funcionam.

---

### Marco M3.8c — Chat, Contexto e Sessões (Medidor, Compaction, Fork, Checkpoints, Atalhos) (UC-02)
- **Fonte**: `kiro.dev/docs/{ide/chat,checkpoints,compaction,ide/whats-new-v1}/`.
- **Arquivos-alvo**: `extensions/tarot-core/src/{context/contextProviders,context/compactionService,checkpoints/checkpointService,agents/sessionStore}.ts`, `agentPanelView.ts`, `panel.js`.
- **Especificação**:
  - **Provedores `#` completos**: `#codebase`, `#file`, `#folder`, `#git diff`, `#terminal`, `#problems` (arquivo atual), `#url`, `#code`, `#repository`, `#current`, `#steering`, `#docs`, `#spec`, `#mcp`; combináveis. `@file` e `$skill` aceitos como aliases (composer Crew).
  - **Medidor de contexto real** (substitui o anel `○` decorativo) e **compaction automática** perto de 80%: resumo estruturado que **preserva** status de tarefas, arquivos modificados, decisões/restrições, próximos passos e intenção; comprime saída de tools, raciocínio intermediário e erros resolvidos; mantém as últimas mensagens literais; avisa o agente quais skills/steering foram descartados e recarrega os pedidos. Configurações `tarot.compaction.{autoThreshold,excludeMessages}`. É unidirecional (oferecer export antes).
  - **Checkpoints** a cada prompt: **Restore** reverte arquivos **e** o contexto; **Revert** desfaz só o último turno; **Fork conversation** cria nova sessão a partir de um turno antigo **sem tocar nos arquivos** (não carrega artefatos). Limitação: só edições do agente são rastreadas; em BYOA usar snapshot por *git tree* para cobrir edições feitas pelo CLI.
  - **Atalhos**: `Ctrl+L` traz a seleção para o chat atual, `Ctrl+Shift+L` abre **nova sessão** com a seleção, `Ctrl+Alt+B` alterna a Secondary Side Bar; menu *Ask Tarot* com ações rápidas (*Fix Grammar/Spelling*, *Write Comments*, *Optimize*). Inline chat não existe.
  - **Sessões**: abas, `+`, **History** (buscar/restaurar/excluir), **Task list**, **Export Chat** (`.md` e zip `session.json` + `messages.jsonl`), detecção de intenção (pergunta ⇒ resposta; diretiva ⇒ ação). Chats paralelos podem editar o mesmo workspace: oferecer **git worktree por sessão** (via `git/worktreeManager.ts`) e aviso de conflito.
    - *(Estado atual, pré-M3.8c)*: `sessionStore.ts::persist` já grava cada mensagem em `.tarot/sessions/<id>.json` desde antes deste marco, mas **nada lê esses arquivos de volta** — `TarotSessionStore` sempre nasce com a lista de sessões vazia (`extension.ts`), então o histórico se perde na UI a cada reinício da IDE apesar de já estar em disco. O **History** deste marco precisa adicionar esse carregamento, não só a UI de busca/restaurar. **Modelo/Reasoning Effort** selecionados, por outro lado, **já persistem** via `context.globalState` desde antes de M3.8c (mesmo padrão do `ACTIVE_AGENT_STATE_KEY` de `runtimeManager.ts`, commit `61e9daeb7be`) — não é um item pendente deste marco.
  - **Pre-PR Review (BYOA) & Evidence Summary**: ação de 1 clique na *Review Queue* / Source Control que dispara um **agente local diferente do autor** (ex.: `claude` escreveu → `codex`/`agy` revisa corretude, segurança, testes e aderência à Spec) e exibe um cartão resumo de evidências (testes, lint, PBT, diff) pronto para revisão assíncrona.
  - **Dev Servers**: processos longos em background sem bloquear o chat. *(Prioridade baixa: voz, anexos de imagem/PDF/CSV/DOCX, `/model`, `/context`; seletor visual de modelo + Reasoning Effort já entregue no composer em M3.6.5.)*
- **Critérios de Aceite (DoD)**:
  - [ ] Medidor reflete tokens reais; compaction preserva os itens obrigatórios.
  - [ ] **Fork conversation** cria sessão sem alterar arquivos; **Restore** reverte arquivos + contexto.
  - [ ] Todos os provedores `#` e os atalhos `Ctrl+L` / `Ctrl+Shift+L` funcionam.

---

### Marco M3.9a — Motor de Workflows & Recipes (schema oficial) (UC-07)
- **Fonte**: `kiro.dev/docs/workflows/` (+ `authoring`, `manage`, `patterns`).
- **Arquivos-alvo**: `extensions/tarot-core/src/workflows/{workflowEngine,recipeLoader,recipeValidator,templateResolver,watchHandlers,runStore}.ts`, `recipes/*.workflow.json` (bundled).
- **Schema de Recipe** (`.tarot/workflows/*.workflow.{json,yaml,yml}`, global `~/.tarot/workflows/`):
  - **Raiz**: `name`*, `description`, `inputs` (mapa nome→dica de tipo `prompt|file|string`; não impostos em runtime), `modelId`, `effortLevel`, `steps`* (sequência implícita).
  - **Nós**: `step` (`id`,`agent`,`prompt`; opcionais `artifacts`, `captureOutput`, `completion`, `modelId`, `effortLevel`), `sequence`, `repeat` (`maxIterations`*, `onMaxIterations: abort|continue|pause`, `stopCondition` **ou** `stopWhen`), `parallel` (`branches`, `joinPolicy: all|allSettled|any`), `watch` (`handler`, `config`, `idleTimeoutSec` no nó).
  - **`stopCondition`**: `containsText` | `completionSignal` (`success`/`need_input`/`error`) | `fileCheck{path,jsonPath,value}` (caminho pontilhado, `$.` opcional, sem `[` `]` `*` `..`; `value` array = qualquer-de). `stopWhen`: `"<watch-id>.terminal"` ou `"{{x.output}} contains TEXTO"`; nunca os dois no mesmo `repeat`. Um `repeat` roda **ao menos uma vez**.
  - **Limites**: ≤ **50** steps estáticos, profundidade ≤ **8**, IDs únicos, `maxIterations` positivo.
  - **Templates**: `{{input}}`, `{{previous.output}}` (proibido no 1º nó de um container e dentro de `parallel`), `{{step-id.output}}`, `{{artifacts.nome}}`; variável bare não declarada fica literal com *warning*; saída capturada é injetada com **delimitadores à prova de adulteração**.
  - **Protocolo `send_message`** (injetado em todo step): severidade `success` ⇒ conclui e avança; `warning` ⇒ `need_input` (step e run pausam até a resposta); `error` ⇒ falha propaga; `info` ⇒ só progresso. Turno sem `send_message` e sem condição pendente conclui o step. Só o agente do step sinaliza (sub-agentes não).
  - **Watch**: `github-pr` (`prRef`|`url`, `pollIntervalSec` ≥ 30, `includeOwnActivity`, `ignoreAuthors`; acorda por comentários, reviews, conflito de merge e checks falhos; `terminal-state` em MERGED/CLOSED) e `command` (programa rodado a cada poll com JSON no STDIN `{cursor,config,workspacePath}`; responde **um** JSON `{outcome: idle|new-activity|terminal-state, cursor, payload}`; exit `2`/`126`/`127` falham, outros ⇒ *idle*; `pollIntervalSec` ≥ 10; sem templates em `command`). Cursor persistido; entrega *at-least-once*.
  - **Modelo/esforço por step**: override do step > default do workflow > sessão pai > default do agente; modelo desconhecido só gera *warning* e falha na 1ª chamada.
  - **`validate_workflow`**: erro de schema/enum, IDs duplicados, limites, `stopWhen` malformado, `jsonPath` inválido, ordem de templates inválida, `fileCheck` fora do workspace, sub-agente embutido como agente de step.
  - **Precedência**: projeto > usuário > conta sincronizada > bundled; recipe inválida de maior prioridade não esconde válida de menor; JSON e YAML com mesmo nome ⇒ JSON vence e conflito é reportado.
  - **Agentes bundled** `wf-planner`, `wf-coder`, `wf-design`, `wf-design-reviewer`, `wf-review-aggregator`, `wf-pr-submitter`, `wf-pr-responder`, `wf-auto-researcher`, `semantic_reviewer` (+ `wf-workflow-creator` interno), disponíveis só com workflows ativos.
  - **Execução**: cada step em **sessão própria com contexto novo**; handoff só por saída capturada/artefato; checkpoint em **fronteiras de nó** (status, saídas, artefatos, progresso de `repeat`, cursores de watch) para retomar após reinício; pause **cooperativa** (efetiva na próxima fronteira); stop não desfaz arquivos; tempo pausado não conta; reconexão tenta o mesmo step por até 24 h. **Revisar o plano restante** em execução (`update_workflow`) preservando nós concluídos, validado de novo; plano novo exige **cartão de aprovação** (*Allow/Deny/Always/feedback*).
  - **Segurança**: workflows são *opt-in* (`tarot.workflows.enabled`); recipes do workspace **não carregam** sem trust; cada step e cada `command` watch passam pela política de permissões da sessão que lançou (mais restritiva vence); com *trust-all* a aprovação do plano é *Allow* de uso único e não salva regra; a recipe `publish-pr` entrega PR verde/aprovado e **não faz merge**.
  - **Entrada**: pedir ao chat (gera workflow, com aprovação do plano), `/workflow-run` (seletor + formulário de inputs), `/workflow run <recipe> --task "..."`, ou delegação a agente único em background (`agent://<nome>`). Controle **Use workflows**: *Only when asked* (padrão) / *Only for large tasks* / *As much as possible*.
- **⚠ Adaptação BYOA**: cada step = uma execução de CLI com contexto novo; `send_message` é exposto como **ferramenta MCP do Tarot** (ou marcador estruturado no stdout quando o CLI não suportar MCP); pause/resume/steer exigem *session resume* do CLI — registrar a capacidade por adaptador.
- **Critérios de Aceite (DoD)**:
  - [ ] `validate_workflow` reprova os casos listados e aprova as recipes bundled.
  - [ ] `repeat`/`parallel`/`watch`/`completion` seguem a semântica acima, com checkpoint e retomada após reiniciar o IDE.
  - [ ] Cada step pode usar um agente local diferente (`claude`/`agy`/`codex`) e respeita a política de permissões da sessão pai.

---

### Marco M3.9b — UI de Workflows (Runs, Recipes, Aba de Run, Controles) (UC-07)
- **Fonte**: `kiro.dev/docs/workflows/manage` + Print 2.
- **Arquivos-alvo**: `extensions/tarot-core/src/views/{workflowRunsView,recipesView,workflowRunEditor}.ts`, `media/webview/workflow.{js,css}`.
- **Especificação**:
  - **Sidebar** com `WORKFLOW RUNS` (execuções com timestamp e sub-itens `✓ validate`, **agrupadas por status com "Needs you" primeiro**, campo *Search workflows* por nome/status/duração) e `RECIPES` (grupos Global/Workspace, descrição, botão `▷`, ícone `icons/arcana/10-wheel-of-fortune.svg` em Workflows/Recipes e `icons/arcana/17-the-star.svg` em `publish-pr`).
  - **Aba "Workflow: <nome>"** no editor: árvore de steps dockada ao lado do transcript do step, cabeçalho com `Created by: <chat>` (link), **Go to active**, switch **Follow**, `Pause / Resume / Stop`, **Add loops** quando `onMaxIterations: pause`; cabeçalho de título `feature-pipeline · 6 steps · review-loop max 2` e pill `✓ Completed`/`Running · step X of Y`; badges `[loop ×2]`, `[parallel]`, `pass 1 of 2`, `Approved`/`Passed`; agente/papel ao lado de cada step (`wf-coder`, `wf-design-reviewer`, `semantic_reviewer`); *hover* mostra status, agente, modelo e esforço; campo **"Message this step's agent"**.
  - **Estados**: `running`, `paused` (3 variantes: *needs input*, *at a boundary*, *iteration cap*), `completed`, `failed`, `aborted` (+ `pending`/`skipped`). IDE não expõe Retry (iniciar novo run); CLI do Tarot pode expor.
  - **Card do run no chat pai**: nome, ID, tarefa, artefato, tempo decorrido, `Open run`, Pause/Stop; **linhas de notificação** de steps (`Info`/`Completed`/`Needs input`/`Failed` com ações `Open step session` / `Answer <step>`); resumo final (resultado, steps, arquivos, artefatos, validações, o que ficou sem verificar).
  - **Orientação em duas vias**: responder direto na aba do step ou pedir ao chat pai que repasse; step ativo lê no próximo turno, pausado trata como a resposta esperada.
  - **Recipes bundled**: `investigate`, `feature-pipeline`, `publish-pr` (**confirmadas na doc**) + `autoresearch`, `goal`, `ralph`, `semantic-review-multi-model` (**vistas no Print 2**, não listadas na doc; tratar como recipes do Tarot).
  - **Concorrência**: runs não isolam branches/worktrees; sugerir `run_dir`/artefatos distintos e worktree por run.
- **Critérios de Aceite (DoD)**:
  - [ ] Runs agrupados por status com busca; aba de run com árvore, Follow, Go to active, Pause/Resume/Stop e Add loops.
  - [ ] Responder a um step *needs input* retoma a mesma sessão; notificações aparecem no chat pai com ações.
  - [ ] Recipes bundled listadas com `▷` e badges fiéis ao Print 2.

---

### Marco M3.9c — Sessions & Tarot Agent Mode / Agent Focus Mode (Desktop, estilo `app.kiro.dev`) (UC-02, UC-07)
- **Fonte**: `kiro.dev/docs/ide/chat` (Agent Focus Mode), `kiro.dev/web/` (`app.kiro.dev`, adaptado para **Desktop nativo** no Tarot IDE) e Prints 3 e 4.
- **Arquivos-alvo**: `extensions/tarot-core/src/views/{sessionsView,focusModeView}.ts`, `agentPanelView.ts`, `media/webview/panel.{js,css}`.
- **Decisão arquitetural**: a experiência de orquestração estilo `app.kiro.dev` **roda como modo Desktop nativo dentro do Tarot IDE** (`extensions/tarot-core`, 100% Extension-First — funcionando também via `tarot-server` no navegador), substituindo integralmente a Agents Window nativa `src/vs/sessions/` do VS Code (cujos pontos de entrada ficam ocultos).
- **Especificação**:
  - **Painel Sessions (esquerda)**: busca, filtros, `+ New ⌄` (ícone `icons/arcana/00-the-fool.svg`), botão recolher, cards multi-repositório (`título`, resumo, badge `repo`, horário, status `Needs input` ou `🔒 1 sub-agent needs approval` *parked*), `Older Sessions >` e **rodapé fixo com atalhos diretos**: **Schedule** (M3.10), **Agent Config** (Custom Agents / Steering / Skills / MCP / Permissions) e **Settings** (`tarot.*`).
  - **Área Central (Transcript + Composer)**: cabeçalho com título da sessão e ações à direita (refresh, diff/PR, alternar painel auxiliar); disclosures `> N steps`, `> Spawned 1 sub-agent <nome>`, `> Ran command ...`, `> Created PR ...`, `> Edited <arquivo>`, resposta Markdown/tabelas e **chips de ações sugeridas** (*follow-ups*); composer com anexos, seletor de **branch/worktree** (`git/worktreeManager.ts`), seletor de **repositório**, seletor de agente local (`Auto / claude / agy / codex`) e gatilhos `(/command · @file · $skill)`.
  - **Agent Focus Mode (3 painéis)**: Sessions à esquerda | chat expandido ao centro | painel auxiliar recolhível de Specs/Diffs/Artefatos à direita; toggle em 1 clique no canto superior direito alternando entre *Editor View* e *Tarot Agent Mode*; modos de permissão disponíveis; sessões paralelas; seletor de workflow no início. *Não* oferece Fork nos painéis de step.
  - **Concorrência segura**: chats Spec/Quick Spec/Bug Fix esperam um ao outro (`The agent is currently busy`); Plan e custom agents rodam em paralelo; aviso quando duas sessões podem editar os mesmos arquivos (com oferta de worktree isolado).
- **Critérios de Aceite (DoD)**:
  - [ ] Sessions filtra/pesquisa, mostra badge de repo, `Needs input` / badges *parked* e atalhos de rodapé (**Schedule**, **Agent Config**, **Settings**).
  - [ ] Tarot Agent Mode / Focus Mode alterna em 1 clique com o Editor View, exibe os 3 painéis e permite selecionar repo/worktree e agente local direto no composer.

---

### Marco M3.10 *(opcional / novo)* — Agendamento, Digests e Lições Aprendidas (UC-09)
- **Fonte**: `kiro.dev/crew`, `docs/crew/*` (Crew é produto à parte, open source Apache-2.0, sobre Kiro CLI + ACP).
- **Escopo no IDE**: jobs **cron** com fuso, *timeout* por job, *jitter* e datas de exclusão, cada run em **sessão própria**, logada e com checkpoint; entrega de resultado como notificação/**digest**; jobs sem chamada de modelo não gastam tokens.
- **Lições & Hygiene de Steering**: correções do usuário (`"use pnpm, not npm"`) viram **lições** em Markdown no formato de steering (inspecionáveis, editáveis, escopo por workspace); fluxos repetidos podem virar skills; comando **Audit / Prune Steering** ajuda a revisar e podar regras redundantes ou workarounds de modelos antigos ao trocar de CLI/modelo.
- **Critérios de Aceite (DoD)**:
  - [ ] Job cron cria sessão própria, registra log e gera notificação/digest.
  - [ ] Correção do usuário gera lição editável em `.tarot/steering/` e **Audit / Prune Steering** identifica regras obsoletas/redundantes.

---

### Divergências conhecidas Kiro × Tarot (BYOA) a respeitar nos marcos acima
| Tema | Kiro | Decisão no Tarot |
| --- | --- | --- |
| Autonomia | Modos *Supervised / Accept file changes / Approve for me* (o "Autopilot" 0.x foi substituído) | Mesmos 3 modos; switch Autopilot vira atalho |
| Imposição de permissões | Harness próprio impõe tudo | Tarot impõe o que passa por ele; resto *advisory* (ver M3.8a) |
| Hooks `Manual` | Hook manual legado; novo fluxo = steering `manual` via `/nome` | Seguir o novo fluxo |
| `send_message`, pause/resume | Nativos do harness | MCP próprio + *session resume* por adaptador (ver M3.9a) |
| Créditos por step | Exibidos no card do run | Exibir tokens/tempo quando o CLI reportar |
| Worktrees | Workflows não isolam; IDE usa a branch atual ou worktree | `git/worktreeManager.ts` gerenciado por onda/sessão/run (M3.6.7+) |
| Crew / bots / mensageria | Produto separado | Fase 5 opcional |

---

### Débitos Técnicos Conhecidos (Auditoria de Gaps, 2026-11-22)

Auditoria dedicada comparando o DoD de cada marco **já concluído** (M3.1–M3.8a) contra o código real, em 5 frentes paralelas, mais os 2 gaps que o próprio usuário encontrou usando a IDE. Itens ✅ já corrigidos nesta mesma auditoria (commits referenciados); itens 🔲 são débito técnico pendente, a continuar corrigindo.

| # | Área / Arquivo | Achado | Status |
| --- | --- | --- | --- |
| 1 | `permissions/policyEngine.ts::ruleMatchesValue` | Qualquer regra `allow` com `match` (presets `read-only-shell`/`dev-shell`, ou regra do usuário) casava um comando mesmo com redirecionamento de shell não citado — `cat secrets.env > /tmp/exfil.txt` casava `'cat *'`, `pnpm test > ~/.bashrc` casava `'pnpm *'` do `dev-shell`. Mesma classe do bypass do `git` corrigido antes, só que no caminho genérico de match, não só no atalho padrão. | ✅ Corrigido — `hasUnquotedRedirection` agora também invalida qualquer regra `allow` com `match` explícito (uma regra sem `match`, como `allow-all`, é concessão deliberada e fica intocada). |
| 2 | `permissions/*` + `views/agentPanelView.ts` | A capability `fs_write` existia no schema (tipos, presets, invariantes) mas **nunca era avaliada em lugar nenhum do runtime** — nenhuma escrita de arquivo (pelo agente BYOA) jamais passava por política real; os diálogos de "aprovar" que o usuário via eram sempre o gate de `shell` (texto puro, sem lista de arquivos, porque shell não tem "arquivos"). | ✅ Implementado `reviewFileWritesForTurn`: ao fim de cada turno, avalia `fs_write` para cada arquivo que o diff do checkpoint mostra como alterado; `deny` reverte automático; `ask` explícito (invariante ou regra do usuário) vira um card real no transcript com a lista de arquivos + **Keep Changes**/**Revert These Files** (`checkpointService.restoreCheckpointFiles`, `git checkout` como fallback seguro antes de deletar). O "ask" apenas-default (sem regra nenhuma) só aparece em modo *Supervised* — não reintroduz fricção em *Accept file changes*/*Approve for me*. **Confirmado na prática (2026-11-22, usuário testando em workspace sem `.git`) e corrigido junto com o item 7**: este gate depende de `checkpointService.getCheckpointDiff`, que fora de um repo git era cego a arquivos que o agente cria sem abrir em aba — o item 7 agora resolve isso com um baseline de mtime/tamanho. Nota importante que não é regressão nem bug: no cenário exato que o usuário viu (modo *Accept File Changes*, nenhuma regra de `permissions.yaml` configurada), o card continua, corretamente, **não aparecendo** — é o "ask" apenas-default, que por design só aparece em *Supervised*. O card agora aparece de verdade nesse workspace para `deny`/`ask` explícito (invariante ou regra do usuário) e em modo *Supervised*, que é o que estava quebrado. |
| 3 | `checkpoints/checkpointService.ts::collectDirtyFiles` | **Limitação conhecida do item 2, não resolvida**: `collectDirtyFiles` exclui todo caminho com prefixo `.tarot/` do diff (para não gerar ruído do próprio bookkeeping do Tarot). Isso significa que o novo gate de `fs_write` **não enxerga** escritas em `.tarot/settings/**`, `permissions.yaml` ou `.tarot/{hooks,agents,workflows,powers}/**` — exatamente os caminhos que as `TAROT_INVARIANT_RULES` deveriam proteger. Só caminhos normais do workspace e `.git/**`/`.vscode/**` são cobertos hoje. | 🔲 Pendente — exigiria o próprio detector de arquivos sujos do checkpoint parar de excluir `.tarot/**`, com cuidado para não poluir o diff com o bookkeeping normal (sessions, checkpoints aninhados). |
| 4 | `hooks/hookMigration.ts:52` | Upconvert do hook legado copia `glob` (ex. `*.ts`) direto para o campo `matcher` do schema v1, mas `hookEngine.selectHooksForTrigger` trata `matcher` como **regex**. `new RegExp("*.ts")` lança `SyntaxError`, capturado e tratado como "não casa" — o hook migrado nunca mais dispara, sem nenhum erro visível ao usuário. | 🔲 Pendente |
| 5 | `specs/specSync.ts::mergeTasksMarkdown` | Casa tarefa antiga↔nova só por texto normalizado **idêntico**. Se o agente reformular levemente um título já concluído ao rodar "Sync Files" (comportamento normal de LLM), a tarefa aparece de novo como `[ ]` pendente na lista viva e a versão concluída vira um apêndice duplicado "Preserved Completed Tasks" — o oposto do que o DoD promete. | 🔲 Pendente |
| 6 | `permissions/{permissionsService,yamlLite,permissionTypes}.ts` | Erros de parsing de `permissions.yaml` (YAML malformado, `version` inválida, regra com campo errado) são computados mas **nunca mostrados** ao usuário — não vão a `outputChannel`, não viram `showWarningMessage`. Um typo faz regras (ou o arquivo inteiro) serem ignorados silenciosamente, sem sinal de que a política configurada não está em vigor. | 🔲 Pendente |
| 7 | `checkpoints/checkpointService.ts` | Fora de um repositório git, `collectDirtyFiles` só enxergava arquivos via abas de editor abertas e "dirty" — qualquer arquivo criado/editado pelo agente fora de uma aba aberta era invisível ao snapshot, ao diff e ao revert, mas `restoreCheckpoint` sempre mostrava "Checkpoint restored successfully" (sucesso falso-positivo). Confirmado ao vivo: deixava o gate de `fs_write` do item 2 completamente sem efeito em workspace sem git (usuário criou projeto novo via `agy`, 6 tool calls escreveram arquivos reais, zero card de aprovação apareceu). | ✅ Corrigido — `createCheckpoint` agora grava um `baseline` (mtime+size de todo arquivo do workspace, sem copiar conteúdo, só quando não há git) via `scanWorkspaceFingerprint`; `getCheckpointDiff`/`restoreCheckpoint` comparam contra esse baseline (`diffAgainstBaseline`) para achar o que mudou mesmo sem git ou aba aberta. Limite honesto que permanece: um arquivo que já existia **limpo** antes do checkpoint e foi modificado sem git disponível não tem conteúdo de backup algum — não dá pra restaurar o original, só detectar que mudou. `restoreCheckpointFiles` agora retorna `{reverted, skipped}` em vez de fingir sucesso: esses arquivos entram em `skipped` e o usuário é avisado (`"N file(s) could not be safely reverted"`) em vez de serem apagados (perda de dado) ou silenciosamente ignorados. |
| 21 | `views/agentPanelView.ts` (fallback de texto do turno) | Quando o CLI fecha o turno sem nenhum texto de resposta mesmo após tool calls reais (confirmado com `agy`: 6 tool calls, resposta vazia), a mensagem genérica `"(Run completed with no additional output.)"` dá a impressão de que nada aconteceu — o único traço do trabalho real fica escondido atrás do disclosure recolhido "N tool calls" que o usuário precisa expandir. | ✅ Corrigido — `summarizeToolsFallback` sintetiza `"Completed N action(s): ..."` a partir dos labels de ferramenta já coletados, sempre que houver pelo menos 1 tool call e nenhum texto; mantém o placeholder genérico só quando não há nem texto nem tool call algum. |
| 8 | `context/contextProviders.ts` (`#Git Diff`) | Fora de um repo git (ou `git` indisponível), `git status --short` falha (`stderr` com "fatal: not a git repository"), mas o código só olha `stdout` (vazio) e cai no texto fixo `"Working tree clean."` — desinformação ativa entregue ao agente, não apenas ausência de dado. | 🔲 Pendente |
| 9 | `agents/adapters/customAdapter.ts::detect()` | Se `execSimple('--version')` lançar exceção (timeout, binário trava, permissão negada), o `catch` retorna `available: true, version: 'custom'` — diferente de `claudeAdapter`/`codexAdapter`, que no mesmo cenário retornam `available: false` com `error` preenchido. Um binário customizado quebrado aparece como "pronto" (verde) até o usuário tentar usá-lo de verdade. | 🔲 Pendente |
| 10 | `agents/adapters/claudeAdapter.ts` | Rebaixa `xhigh` → `high` no Reasoning Effort sem necessidade — o `claude` CLI instalado já lista `--effort` com `xhigh` nativo. Selecionar "XHigh" no popover silenciosamente vira "High" no comando real. | 🔲 Pendente |
| 11 | `agents/adapters/codexAdapter.ts::run()` | Nunca lê `request.effort` — nenhuma flag de raciocínio é passada ao `codex`. Trocar o Reasoning Effort no composer com Codex ativo não tem efeito nenhum, sem aviso. | 🔲 Pendente |
| 12 | `git/worktreeManager.ts` | 129 linhas nunca importadas/instanciadas fora do próprio arquivo (a única referência em `agentPanelView.ts` é um comentário). `taskRunner.ts` não chama o worktree manager em nenhum momento — a feature que o DoD do M3.6.7 descreve como "usada opcionalmente por tarefas paralelas de uma onda" é inacessível ao usuário hoje. | 🔲 Pendente |
| 13 | `views/agentPanelView.ts::handleSlashCommand` | Lista fixa de 8 comandos hardcoded (`/spec`, `/quick-spec`, ...); nenhuma referência a `steeringService`. Contradiz o que o M3.7 documenta ("on-demand manual = steering `inclusion: manual` invocado por `/nome`") — hoje um doc de steering manual só é alcançável via `#Steering`, nunca por `/nome`. | 🔲 Pendente |
| 14 | `views/agentPanelView.ts` (picker de modelo) + `media/webview/panel.js::renderModelAndModePickers` | `selectedModel` persiste entre reinícios (ver commit `61e9daeb7be`), mas se o CLI remover/renomear um modelo entre sessões, o picker exibe o ID morto em vez de cair para "Auto", e o próximo `send` tenta `--model <id-morto>` — falha no CLI em vez de degradar graciosamente. | 🔲 Pendente |
| 15 | `git/worktreeManager.ts::createWorktree` | Se `git worktree add` tiver sucesso mas a escrita do manifesto `.tarot-worktree.json` falhar, o worktree/branch continuam existindo no disco/git mas `listWorktrees` nunca os encontra (depende do manifesto) — fica órfão sem rota de limpeza. Baixo impacto hoje (item 12: a feature não está em uso), vira risco real quando M3.8c/M3.9a ligarem isso de verdade. | 🔲 Pendente |
| 16 | `specs/specTaskCheckpoints.ts` | Suspeita não confirmada: usa `task.numberLabel ?? String(task.index)` como chave; para tarefas sem numeração, `index` é a posição no array parseado — reordenar/adicionar tarefas entre execuções pode colidir e sobrescrever o checkpoint de uma tarefa não relacionada. | 🔲 A confirmar |
| 17 | `extension.ts` (gatilhos de arquivo) + `hooks/hookEngine.ts` | A "fila serial por hook" do M3.7 é real *dentro* de uma chamada, mas não há debounce/lock *entre* chamadas — `onDidSaveTextDocument` dispara `void runFileTriggerHooks(...)` a cada evento sem lock; saves rápidos consecutivos do mesmo arquivo disparam múltiplas filas em paralelo, cada uma rodando os mesmos comandos shell concorrentemente. | 🔲 Pendente |
| 18 | `permissions/yamlLite.ts` | Parser YAML *hand-rolled* (sem `yaml`/`js-yaml`); gaps não totalmente enumerados — construções válidas e comuns (strings multi-linha com barra/maior-que, âncoras/referências) provavelmente não são suportadas e quebrariam silenciosamente ou com erro confuso num `permissions.yaml` real escrito à mão. | 🔲 A mapear |
| 19 | `agents/adapters/{claudeAdapter,codexAdapter}.ts` | Nenhum dos dois adaptadores jamais passava `--permission-mode`/equivalente ao CLI. `claude -p` sem flag roda no seu próprio padrão (`manual`): nega toda edição/Bash não-leitura sem host de permissão. `codex exec` sem flag roda em **sandbox somente-leitura por padrão** (confirmado em `developers.openai.com/codex/noninteractive`) — nunca conseguiria escrever um arquivo sequer. *Accept File Changes*/*Approve For Me* eram apenas estado de UI nos dois, sem efeito real no CLI (achado pelo usuário na prática: `claude` travado pedindo aprovação "na UI do Claude Code", que não existe nesse contexto). | ✅ Corrigido para `claude` (verificado ao vivo contra `claude --help` instalado) — `--permission-mode plan` quando `mode==='plan'`; `acceptEdits` (+ `--disallowedTools 'Bash(rm *)'`, já que `acceptEdits` também auto-aprova `rm`/`mv`/`cp`) para *Accept File Changes* **e** *Supervised* (ver item 22 — Supervised real por hunk não é possível sem o `--permission-prompt-tool` bidirecional de M3.8b/M3.9a, então usa o mesmo `acceptEdits` e deixa o gate de `fs_write` do Tarot ser a revisão de fato); `auto --permission-prompts none` para *Approve For Me*. ✅ Corrigido para `codex`, mas **só com base na documentação oficial, sem o CLI instalado neste ambiente para cross-check** (ao contrário do `claude`) — `--skip-git-repo-check` sempre (o checkpoint do Tarot já cobre isso sem git, ver item 7); `--sandbox workspace-write` para *Supervised*/*Accept File Changes*; `--approve-for-me` para *Approve For Me* (flag citada textualmente pela doc); nada para `mode==='plan'` (o padrão já é somente-leitura). **Verificar contra uma instalação real antes de confiar cegamente.** |

| 20 | `media/webview/panel.js::appendInlineSegments` | O transcript só reconhece ``code`` e `**bold**` inline — não existe parsing de link Markdown (`[texto](url)`). Achado pelo usuário na prática: `agy` respondeu com `[implementation_plan.md](file:///home/.../antigravity-cli/brain/<id>/implementation_plan.md)` (plano fora do workspace, na pasta interna do próprio `agy`) e o texto aparece literal, com colchetes e tudo, sem nenhum link clicável — o usuário não tem como abrir o plano que o agente gerou. Não é específico do `agy`: qualquer agente (claude/codex/agy) que referencie um arquivo ou URL em Markdown fica com texto morto no transcript hoje. | 🔲 Pendente — correção bem delimitada: adicionar regex de link em `appendInlineSegments`, renderizar como elemento clicável (não `<a href>` cru, que a CSP/webview provavelmente bloqueia) que dispara `postMessage` pro host; host abre `file://` via `vscode.workspace.openTextDocument`/`showTextDocument` (funciona fora do workspace, como o caso do `agy`) ou `http(s)://` via `vscode.env.openExternal`. |

| 22 | `agents/adapters/claudeAdapter.ts`/`codexAdapter.ts` (Supervised) vs `docs/KIRO_ARCHITECTURE_REFERENCE.md:100` | O Kiro documenta Supervised como "pausa para aprovação **por turno com edições (hunks aceitar/rejeitar/discutir)**" — ou seja, pausa **antes/durante** a escrita, diff **por hunk**. O Tarot não faz isso: Supervised aplica a edição direto (mesma flag de *Accept File Changes*) e só revisa **depois**, **arquivo inteiro** (Keep/Revert), nunca por hunk. Causa raiz arquitetural, não negligência: o Kiro controla o próprio loop do agente de ponta a ponta e pode pausar no meio de uma edição; o Tarot orquestra CLIs de terceiros como processo externo, e só o `claude` expõe algum canal pra isso (`--permission-prompt-tool`), que ainda exigiria uma ponte bidirecional síncrona (pergunta → resposta no meio do processo) não construída. | 🔲 Pendente — rastreado para M3.8b/M3.9a (protocolo de permissão bidirecional), quando houver uma ponte real para pausar o CLI no meio da escrita. Até lá, o gate pós-turno de `fs_write` é a aproximação disponível. |
| 23 | `agents/adapters/agyAdapter.ts` (Supervised) | Diferente de *Accept File Changes*/*Approve For Me* (que recebem `--mode accept-edits`), o modo *Supervised* não passa `--mode` nenhum para o `agy` — cai no padrão do próprio CLI, que não está documentado no `agy --help` instalado (sem `(default: ...)` explícito). Mesma classe de risco do item 19 (padrão desconhecido rodando sem terminal interativo), mas **não confirmado na prática** como os outros 2 casos — não haviam evidência de trava ao vivo no momento da auditoria. | 🔲 A confirmar — testar `agy` em modo Supervised antes de mexer; não adivinhar a flag certa sem reproduzir o problema primeiro (lição do item 19/debt table: só implementar depois de evidência ou documentação, nunca por suspeita). |

Commits desta rodada: `57cd30c1601`/`ee1673639cd`/`61e9daeb7be`/`59588fb159d` (rodada anterior) + os desta auditoria (ver histórico git).

---

## Fase 4 — Empacotamento, CLI `tarot` e Distribuição

### 4.1 Builds de Produção Locais (Linux)
```bash
pnpm exec gulp vscode-linux-x64-min
pnpm exec gulp vscode-linux-x64-build-deb
pnpm exec gulp vscode-linux-x64-build-rpm
```
- **Critério de Aceite**: pacote `.deb` instala o binário `/usr/bin/tarot`, ícone `tarot-ide`, `.desktop` funcional, tema **Tarot Arcana Dark**, **Tarot Arcana Icons**, Open VSX ativo e sem `extensions/copilot`.

### 4.2 Multiplataforma & CI/CD
- [ ] Alvos Windows (`vscode-win32-x64-min` + Inno Setup) e macOS (`vscode-darwin-arm64-min`, `com.tarot.ide`).
- [ ] GitHub Actions acionado por tags `v*` publicando artefatos em GitHub Releases.
- [ ] *(Opcional)* Serviço leve de auto-update configurado via `updateUrl` em `product.json`.

---

## Fase 5 *(opcional)* — "Tarot Crew": Bots, Webhooks, Heartbeat, Apps e Gateways
- **Referência**: Crew = workspace persistente com **bots** (agentes nomeados com memória, objetivos, check-ins e dashboard próprios), webhooks autenticados, *heartbeat* de PRs/deploys, **Apps SDK**, dashboards, base de conhecimento (embeddings + full-text), 8 camadas de defesa (sandbox de processo, aprovação de tools, bloqueio de caminhos sensíveis, comandos negados, validação MCP, redação de saída, auditoria assinada), superfícies Slack/Discord/Telegram/Teams/Webex e instâncias remotas por SSH.
- **Decisão de produto**: fora do núcleo do IDE. Avaliar interoperar via **ACP (Agent Client Protocol)** como adaptador de agente adicional e, depois, gateways de mensagens.

---

## Protocolo Contínuo de Sincronização com o Upstream (`microsoft/vscode`)

```bash
# 1. Buscar histórico/tag alvo (na primeira vez após clone shallow, usar --unshallow ou --depth)
git fetch upstream tag 1.149.0 --depth=100

# 2. Atualizar main local sem alterações do Tarot
git checkout main && git merge --ff-only upstream/main

# 3. Criar branch dedicada de sincronização
git checkout tarot-main && git checkout -b sync/vscode-1.149.0
git merge 1.149.0

# 4. Resolver conflitos (ver matriz), reinstalar e validar
pnpm install
pnpm run compile-tarot
pnpm run typecheck-client
node --test build/lib/test/nlsMessages.test.ts build/lib/test/nlsMetadata.test.ts build/next/test/resources.test.ts
./scripts/code.sh

# 5. Integrar em tarot-main
git checkout tarot-main && git merge --no-ff sync/vscode-1.149.0
```

### Matriz de Conflitos por Arquivo

| Arquivo | Risco | Regra de Resolução |
| --- | --- | --- |
| `product.json` | Médio-Alto | Preservar identidade Tarot, Open VSX, `enableTelemetry: false` e ausência de `defaultChatAgent`/`GitHub.copilot-chat`; aceitar atualizações upstream de `builtInExtensions` (`js-debug`) e `webviewContentExternalBaseUrlTemplate`. |
| `pnpm-lock.yaml` | Alto | Nunca resolver manualmente: `git checkout --theirs pnpm-lock.yaml && pnpm install`. |
| `pnpm-workspace.yaml` & `build/npm/dirs.ts` | Baixo | Manter `extensions/tarot-core` em ordem alfabética. |
| `build/gulpfile.extensions.ts` | Baixo | Manter `'extensions/tarot-core/tsconfig.json'` em `compilations`. |
| `package.json` & `scripts/code.{sh,bat}` | Muito baixo | Manter scripts `*-tarot*` e `--disable-extension=GitHub.copilot-chat`. |
| `src/vs/nls.ts` | Muito baixo | Manter `_rebrandMessage` em `_format` antes da interpolação de `args`. |
| `src/vs/workbench/services/themes/common/{workbenchThemeService,themeExtensionPoints}.ts` | Muito baixo | Manter `Tarot Arcana Dark`/`Tarot Arcana Light` (Dark/Light/HC), `FILE_ICON_THEME = 'tarot-arcana-icons'` e o filtro de `vscode.theme-*`/`vscode-theme-seti` (preservando `extensions/theme-*` no Git). |
| `src/vs/workbench/contrib/chat/browser/{chat.shared.contribution,agentSessionsConfiguration}.ts`, `src/vs/workbench/services/chat/common/chatEntitlementService.ts` & `src/vs/platform/workspaces/electron-main/workspacesHistoryMainService.ts` | Muito baixo | Manter defaults `chat.disableAIFeatures: true`, `copilotCliCommand`/`titleBar.signIn`/`welcomePage.signIn`/`titleBar.openInAgentsWindow`/`agentsWindowBanner: false`, `welcomePage.agentsWindowGraphic: 'none'`, `ChatEntitlementContextKeys.Setup.hidden = true` e guard `product.defaultChatAgent` no JumpList (mantendo `src/vs/sessions/` intacta no Git). |
| `onboardingVariationA.ts`, `defaultAccount.ts`, `extensionGalleryService.ts`, `extensionsWorkbenchService.ts`, `abstractExtensionManagementService.ts` | Muito baixo | Manter guards contra `defaultChatAgent === undefined`. |
| `vs_code_editor_walkthrough.ts`, SVGs internos (`code-icon.svg`, `vscode-icon.svg`, `letterpress-*.svg`) e `resources/**` | Muito baixo | Manter versão Tarot (`git checkout --ours`). |
| `src/vs/workbench/workbench.common.main.ts` & `src/vs/workbench/contrib/tarotSpecStepper/**` | Muito baixo | Manter 1 linha de import para `tarotSpecStepper.contribution.js`; pasta `tarotSpecStepper/` é exclusiva do Tarot IDE. |
| `src/vs/workbench/browser/parts/auxiliarybar/auxiliaryBarPart.ts` | Muito baixo | Manter `override get snap(): boolean { return true; }` (drag-to-close da Secondary Side Bar, espelhando `sidebarPart.ts`); se o upstream reescrever `AuxiliaryBarPart`, reaplicar o mesmo getter. |
| `extensions/tarot-core/**`, `resources/tarot/**`, `docs/**`, `LICENSE`, `LICENSE-VSCODE-MIT.txt`, `NOTICE.md` | **Nulo** | Arquivos exclusivos do Tarot IDE (em `LICENSE.txt`, manter versão GPL-3.0 do Tarot com `--ours`). |
