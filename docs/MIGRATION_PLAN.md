# Tarot IDE — Plano de Migração e Execução (Agent-Ready)

> **Guia de execução estruturado para agentes de IA e engenheiros.**
> Cada etapa abaixo define: **Objetivo**, **Arquivos-Alvo**, **Contratos/Especificação**, **Critérios de Aceite (DoD)** e **Comandos de Verificação**.
> Consulte `docs/PROJECT_CONTEXT.md` para regras obrigatórias, stack e casos de uso (`UC-01` a `UC-07`).

---

## Mapa Geral de Fases

| Fase | Marco | Status | Próximo Agente Pode Pegar? |
| --- | --- | --- | --- |
| **Fase 1** | Setup do ambiente, fork `microsoft/vscode` (`1.148.0`), branch `tarot-main`, `tarot-core`, licença GPL-3.0 e remote `origin` | ✅ Concluída | — |
| **Fase 2** | Rebranding completo (assets, tema Arcana, 46 ícones, SVGs UI, `nls.ts`, walkthrough, desativação do Copilot, URLs/licença) | ✅ Concluída | — |
| **Fase 3** | **IDE 100% Agêntica (Paridade Kiro IDE + BYOA `claude`, `codex`, `agy`)** | 🚧 **Em progresso (M3.1–M3.4 ✅ · próximo: M3.5 → M3.9)** | **Sim — iniciar por M3.5** |
| **Fase 4** | Empacotamento de produção, CLI `tarot`, instaladores e CI/CD | 📋 Planejada | Após M3.5 |
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

> **Princípio de execução**: todas as entregas M3.1–M3.6 residem em **`extensions/tarot-core/`**. Não alterar `src/vs/` salvo justificativa explícita na especificação do marco.

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

### Marco M3.1 — Contratos & `AgentRuntimeManager` (UC-01) — ✅ Concluído
- **Objetivo**: detectar automaticamente na máquina do usuário as CLIs `claude`, `codex` e `agy` (e binários customizados), expondo status, caminho e versão.
- **Arquivos-alvo**:
  - `extensions/tarot-core/src/config/tarotConfig.ts`
  - `extensions/tarot-core/src/agents/types.ts`
  - `extensions/tarot-core/src/agents/processRunner.ts`
  - `extensions/tarot-core/src/agents/runtimeManager.ts`
  - `extensions/tarot-core/package.json` (`contributes.configuration` com `tarot.agents.*`)
- **Contratos obrigatórios (`types.ts`)**:
  - `AgentId = 'claude' | 'codex' | 'agy' | string`
  - `AgentStatus = { id: AgentId; displayName: string; binary: string; available: boolean; resolvedPath?: string; version?: string; error?: string }`
  - `AgentEvent = { type: 'text' | 'tool_start' | 'tool_end' | 'diff' | 'error' | 'done'; content?: string; metadata?: Record<string, unknown> }`
  - `AgentAdapter`: `detect(): Promise<AgentStatus>`, `run(req: AgentRunRequest, onEvent: (e: AgentEvent) => void, token: vscode.CancellationToken): Promise<void>`
- **Critérios de Aceite (DoD)**:
  - [x] Detecta `claude`, `codex` e `agy` sem usar `shell: true` (via resolução de `PATH` + `~/.local/bin` + `spawn(bin, ['--version'], { shell: false })`).
  - [x] Comando `tarot.agents.refresh`, `tarot.agents.select` e item na Status Bar exibindo o agente ativo (`$(sparkle) Tarot: claude`).
  - [x] Configurações `tarot.agents.default`, `tarot.agents.paths.{claude,codex,agy}`, `tarot.agents.timeoutMs` e `tarot.agents.custom` registradas no schema de Settings.
- **Verificação**:
  ```bash
  pnpm exec gulp compile-extension:tarot-core
  ```

---

### Marco M3.2 — Layout Kiro: Activity Bar Esquerda + Painel Agêntico na Secondary Side Bar (UC-01, UC-02) — ✅ Concluído
- **Objetivo**: criar a estrutura visual do **Kiro IDE** — container **Tarot** na barra lateral esquerda com 4 TreeViews (**Specs**, **Agent Hooks**, **Agent Steering**, **Local Agents**) e **Painel Agêntico** (`WebviewView`) ancorado na **Secondary Side Bar (direita)**.
- **Arquivos-alvo**:
  - `extensions/tarot-core/package.json` (`viewsContainers`, `views`, `menus`)
  - `extensions/tarot-core/src/views/tarotSidebarViews.ts`
  - `extensions/tarot-core/src/views/agentPanelView.ts`
  - `extensions/tarot-core/media/webview/{panel.css,panel.js}`
- **Critérios de Aceite (DoD)**:
  - [x] Container esquerdo **Tarot** exibe as 4 seções (`Specs`, `Hooks`, `Steering`, `Local Agents`) com ícones coerentes e ações inline (`+`, refresh).
  - [x] Painel direito (`WebviewView` em `viewsContainers.secondarySidebar`) exibe: seletor de agente (`claude` / `agy` / `codex`), toggle **Vibe / Spec**, lista de mensagens com streaming, botão de cancelar execução e chip de arquivos anexados do editor ativo.
  - [x] CSP estrita com `nonce` gerada por renderização e sanitização de todo output de agente (DOM seguro com `textContent`, zero `innerHTML`).
- **Verificação**:
  ```bash
  pnpm exec gulp compile-extension:tarot-core
  ./scripts/code.sh # validar visualmente barras esquerda e direita
  ```

---

### Marco M3.3 — Adaptadores dos Agentes Locais (`claude`, `codex`, `agy`) + Vibe Mode (UC-02, UC-06) — ✅ Concluído
- **Objetivo**: conectar o Painel Agêntico aos executáveis reais da máquina com streaming em tempo real, cancelamento limpo (`SIGTERM`), envio de contexto (`#file`, `#selection`) e persistência agnóstica de sessão.
- **Arquivos-alvo**:
  - `extensions/tarot-core/src/agents/promptBuilder.ts`
  - `extensions/tarot-core/src/agents/sessionStore.ts`
  - `extensions/tarot-core/src/agents/adapters/{claudeAdapter,agyAdapter,codexAdapter,customAdapter}.ts`
- **Critérios de Aceite (DoD)**:
  - [x] Enviar prompt no Vibe Mode dispara o agente selecionado (`claude`, `agy`, `codex` ou custom), transmite resposta incremental no painel e permite cancelar a qualquer momento.
  - [x] Trocar de agente no seletor preserva o histórico em `.tarot/sessions/<sessionId>.json` e injeta resumo de contexto no novo agente (`UC-06`).
  - [ ] *(Aprimoramento futuro)* Ação dedicada no card de resposta para abrir diff de arquivos modificados via `vscode.diff`.

---

### Marco M3.4 — Paridade Visual do Painel Kiro (Abas de Sessão, Disclosures, Composer Exato, `#` Context Providers, `Autopilot` Toggle e Checkpoints) (UC-02) — ✅ Concluído
- **Objetivo**: alinhar 100% a UX do `Tarot Agent` aos prints oficiais do Kiro IDE (ver `docs/KIRO_ARCHITECTURE_REFERENCE.md` Seção 3.1) e entregar `#` Context Providers + Autonomia + Checkpoints.
- **Arquivos-alvo**:
  - `extensions/tarot-core/src/context/contextProviders.ts`
  - `extensions/tarot-core/src/checkpoints/checkpointService.ts`
  - Atualizações em `agentPanelView.ts`, `panel.css`, `panel.js`, `sessionStore.ts`, `promptBuilder.ts`, `agyAdapter.ts` e `types.ts`
- **Especificação (fiel aos prints oficiais do Kiro)**:
  - **Abas horizontais de sessão no topo do painel direito**: `TAROT | [Sessão 1] [• Spec: ...] [+]` com alternância entre múltiplas sessões e fechamento individual.
  - **Transcript estruturado**: seções recolhíveis `> Thought complete` e `> N tool calls`, rodapé **`Elapsed time: Xm Ys`** e ação **`↺ Restore Checkpoint`** por turno.
  - **Composer exato do Kiro**: `<textarea>` no topo com botão quadrado `↑`/`■` no canto superior direito; barra inferior interna com `#` · `📎` · anel de contexto `○` · seletor do agente (`claude / agy / codex ⌄`) à esquerda, e seletor de modo (`Vibe / Spec / Plan ⌄`, `Shift+Tab`) + **`Autopilot` toggle switch** à direita.
  - **Menu `#` empilhável**: `#File`, `#Folder`, `#Codebase`, `#Problems` (`vscode.languages.getDiagnostics`), `#Terminal`, `#Git Diff` (`git diff`) e `#Steering`.
  - **Checkpoints**: snapshot automático por turno em `.tarot/checkpoints/<sessionId>/<turnId>/` com botão **Restore Checkpoint** em 1 clique preservando o histórico da conversa.
- **Critérios de Aceite (DoD)**:
  - [x] Painel direito exibe abas de múltiplas sessões + botão `+`, disclosures recolhíveis de tool calls e `Elapsed time`.
  - [x] Composer segue o layout exato (botão `↑` no topo direito, `#` / `📎` / `○` / agente à esquerda e modo + switch `Autopilot` à direita).
  - [x] Digitar `#` abre popup filtrável; `#Problems`, `#Git Diff`, `#File`, `#Folder`, `#Terminal`, `#Codebase` e `#Steering` injetam dados reais no prompt.
  - [x] Clicar em **Restore Checkpoint** restaura arquivos do turno mantendo o histórico visível.

---

### Marco M3.5 — Agent Steering Completo (`product.md`, `tech.md`, `structure.md`, `AGENTS.md`, 4 Modos) (UC-04)
- **Objetivo**: implementar o sistema completo de Steering do Kiro (workspace + global + `AGENTS.md`) injetado em todos os agentes locais.
- **Arquivos-alvo**:
  - `extensions/tarot-core/src/steering/steeringService.ts`
  - Integração com `tarotSidebarViews.ts`, `agentPanelView.ts` e `promptBuilder.ts`
- **Especificação**:
  - Hierarquia de descoberta: `AGENTS.md` (raiz do repo) + `~/.tarot/steering/*.md` (global) + `.tarot/steering/*.md` (workspace).
  - Parser de frontmatter YAML suportando os **4 modos oficiais do Kiro**:
    - `inclusion: always` *(padrão)*
    - `inclusion: fileMatch` + `fileMatchPattern` (glob casado contra editor ativo e `#File` anexados)
    - `inclusion: auto` + `description` (incluído quando relevante ao prompt)
    - `inclusion: manual` (injetado apenas quando referenciado via `#steering-name`)
  - Comando **`Tarot IDE: Generate Project Steering Documents`** criando `product.md`, `tech.md` e `structure.md` via agente ativo.
- **Critérios de Aceite (DoD)**:
  - [ ] TreeView **Agent Steering** exibe grupo *Workspace*, *Global* e `AGENTS.md` com badge do modo de inclusão.
  - [ ] Todos os 4 modos de inclusão funcionam de forma determinística e são visíveis nos metadados do turno.

---

### Marco M3.6 — Spec-Driven Development Completo (Feature EARS, Bugfix `bugfix.md`, Run Task & PBT) (UC-03)
- **Objetivo**: implementar o ciclo completo de Specs do Kiro IDE, incluindo Feature Specs (*Requirements-First* e *Design-First*), Bugfix Specs e execução granular de tarefas por qualquer agente local.
- **Arquivos-alvo**:
  - `extensions/tarot-core/src/specs/specService.ts`
  - `extensions/tarot-core/src/specs/taskParser.ts`
  - `extensions/tarot-core/src/specs/taskCodeLensProvider.ts`
- **Especificação**:
  - **Feature Spec**: `.tarot/specs/<slug>/{requirements.md,design.md,tasks.md}` usando notação **EARS** (`WHEN ... THE SYSTEM SHALL ...`), suportando entrada *Requirements-First* e *Design-First* + seção de *Correctness / Property-Based Testing* em `design.md`.
  - **Bugfix Spec**: `.tarot/specs/<slug>/{bugfix.md,design.md,tasks.md}` com os 3 blocos EARS (*Current Behavior*, *Expected Behavior*, *Unchanged Behavior*).
  - **Portões de aprovação humana** entre fases (Requirements/Bugfix → Design → Tasks) no painel agêntico.
  - **CodeLens em `tasks.md`** sobre cada `- [ ]`: **`▶ Run Task`** (agente ativo) e **`▶ Run Task with...`** (`claude` / `agy` / `codex`), marcando `- [x]` após conclusão.
- **Critérios de Aceite (DoD)**:
  - [ ] Comando `Tarot: New Spec` permite escolher **Feature (Requirements-First)**, **Feature (Design-First)** ou **Bugfix**.
  - [ ] CodeLens em `tasks.md` dispara o agente escolhido com o contexto completo da Spec + Steering e atualiza progresso (`done/total tasks`) na TreeView.

---

### Marco M3.7 — Agent Hooks Engine `v1` (File + Lifecycle + Manual, `command` & `agent`) (UC-05)
- **Objetivo**: implementar a engine de automações orientadas a eventos fiel ao schema `v1` do Kiro IDE.
- **Arquivos-alvo**:
  - `extensions/tarot-core/src/hooks/hookEngine.ts`
  - Integração com `tarotSidebarViews.ts` e `agentPanelView.ts`
- **Schema `v1` (`.tarot/hooks/*.json` e `~/.tarot/hooks/*.json`)**:
  ```json
  {
    "version": "v1",
    "hooks": [
      {
        "name": "Lint on save",
        "enabled": true,
        "trigger": "PostFileSave",
        "matcher": "\\.(ts|tsx)$",
        "action": {
          "type": "command",
          "command": "pnpm exec eslint --fix {{file}}"
        }
      }
    ]
  }
  ```
- **Especificação**:
  - Triggers: `PostFileCreate`, `PostFileSave`, `PostFileDelete` (com `matcher` regex), `Stop` (fim de turno do agente), `SessionStart`, `SessionEnd` e `Manual` (botão Play na TreeView).
  - Ações: `type: "command"` (execução direta segura sem shell injection) e `type: "agent"` (dispara prompt no agente escolhido).
  - Debounce, fila serial por hook e **bloqueio obrigatório quando `!vscode.workspace.isTrusted`**.
- **Critérios de Aceite (DoD)**:
  - [ ] Hooks `PostFileSave` e `Manual` funcionam para `command` e `agent`, com toggle habilitar/desabilitar e botão Play na TreeView.
  - [ ] Nenhum hook executa automaticamente em workspaces não confiáveis.

---

### Marco M3.8 — MCP (`mcp.json`), Powers, Plan Subagent (`Shift+Tab`) & Permissões (`permissions.yaml`) (UC-06)
- **Objetivo**: fechar a paridade com os recursos avançados do Kiro IDE 1.0+.
- **Arquivos-alvo**:
  - `extensions/tarot-core/src/mcp/mcpConfigService.ts`
  - `extensions/tarot-core/src/permissions/permissionsService.ts`
  - `extensions/tarot-core/src/powers/powersService.ts`
- **Especificação**:
  - **MCP**: leitura hierárquica `.tarot/settings/mcp.json` → `~/.tarot/settings/mcp.json` com nova TreeView **MCP Servers** na barra lateral Tarot e sincronização de flags/configs com `claude`, `agy` e `codex`.
  - **Plan Subagent (`Shift+Tab` ou `/plan`)**: alterna para modo somente-leitura de exploração/planejamento sem alterar arquivos.
  - **Powers**: pacotes sob demanda (`.tarot/powers/`) que ativam instruções + MCP apenas quando palavras-chave relevantes aparecem no prompt.
  - **Permissões (`.tarot/permissions.yaml`)**: regras declarativas para `shell`, `fs_read`, `fs_write`, `network` e `mcp` (`allow` / `deny` / `ask`).
- **Critérios de Aceite (DoD)**:
  - [ ] TreeView lista servidores MCP configurados no workspace e no usuário.
  - [ ] `Shift+Tab` no composer alterna entre `Vibe` / `Plan` / `Spec`.
  - [ ] `.tarot/permissions.yaml` é avaliado antes de comandos `command` em Hooks e ações supervisionadas.

---

### Marco M3.9 — Workflows & Recipes Multi-Agente + Agent Swarms / Sessions View (UC-07)
- **Objetivo**: implementar o motor de **Workflows & Recipes** visto no Kiro (`feature-pipeline`, `investigate`, `goal`, `publish-pr`, `semantic-review-multi-model`) aproveitando os múltiplos agentes locais do usuário (`claude`, `agy`, `codex`) por step.
- **Arquivos-alvo**:
  - `extensions/tarot-core/src/workflows/workflowEngine.ts`
  - `extensions/tarot-core/src/workflows/recipes.ts`
  - `extensions/tarot-core/src/views/workflowRunEditor.ts` (WebviewPanel no editor central)
  - Novas views na barra esquerda: `WORKFLOW RUNS` + `RECIPES` e painel `SESSIONS` com busca
- **Especificação (fiel aos prints oficiais do Kiro)**:
  - Receitas declarativas em `.tarot/workflows/*.yaml` (e globais `~/.tarot/workflows/*.yaml`) definindo `steps` com `agent` (`claude` | `agy` | `codex` | `default`), `loop`, `parallel`, `gate` (`validate-gate` com testes/typecheck) e aprovação humana (`Approved`).
  - Editor visual central mostrando status `Running · step X of Y`, badges `loop ×N` e `parallel`, sub-passos expansíveis e logs ao vivo.
  - View **Sessions** com campo `Search sessions...`, status (`needs approval`, `done`, `running`) e `Older Sessions`.
- **Critérios de Aceite (DoD)**:
  - [ ] Receitas built-in (`feature-pipeline`, `investigate`, `semantic-review-multi-model`) listadas em `RECIPES` com botão Play `▷`.
  - [ ] Executar uma Recipe abre o painel visual de steps no editor central, respeita `validate-gate` e registra o histórico em `WORKFLOW RUNS`.

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
| `src/vs/workbench/services/themes/common/workbenchThemeService.ts` | Muito baixo | Manter `COLOR_THEME_DARK = 'Tarot Arcana Dark'` e `FILE_ICON_THEME = 'tarot-arcana-icons'`. |
| `src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts` | Muito baixa | Manter defaults `chat.disableAIFeatures: true` e `copilotCliCommand`/`titleBar.signIn`/`welcomePage.signIn: false`. |
| `onboardingVariationA.ts`, `defaultAccount.ts`, `extensionGalleryService.ts`, `extensionsWorkbenchService.ts`, `abstractExtensionManagementService.ts` | Muito baixo | Manter guards contra `defaultChatAgent === undefined`. |
| `vs_code_editor_walkthrough.ts`, SVGs internos (`code-icon.svg`, `vscode-icon.svg`, `letterpress-*.svg`) e `resources/**` | Muito baixo | Manter versão Tarot (`git checkout --ours`). |
| `extensions/tarot-core/**`, `resources/tarot/**`, `docs/**`, `LICENSE`, `LICENSE-VSCODE-MIT.txt`, `NOTICE.md` | **Nulo** | Arquivos exclusivos do Tarot IDE (em `LICENSE.txt`, manter versão GPL-3.0 do Tarot com `--ours`). |
