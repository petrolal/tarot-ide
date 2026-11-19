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
| **Fase 3** | **IDE 100% Agêntica (Layout & Workflow Kiro + BYOA `claude`, `codex`, `agy`)** | 🚧 **Em progresso (M3.1–M3.3 ✅ · próximo: M3.4)** | **Sim — iniciar por M3.4** |
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

### Marco M3.4 — Agent Steering (`.tarot/steering/*.md`) (UC-04)
- **Objetivo**: implementar o sistema de regras persistentes do projeto no modelo do Kiro, injetado automaticamente em qualquer agente local selecionado.
- **Arquivos-alvo**:
  - `extensions/tarot-core/src/steering/steeringService.ts`
  - Integração com `tarotSidebarViews.ts` e adaptadores em `src/agents/`
- **Especificação**:
  - Suportar arquivos `.tarot/steering/*.md` com frontmatter opcional:
    - `inclusion: always` (padrão) — sempre injetado.
    - `inclusion: fileMatch` + `fileMatchPattern: "src/**/*.ts"` — injetado quando o arquivo ativo ou referenciado casa com o glob.
    - `inclusion: manual` — injetado quando citado pelo usuário (`#steering-name`).
  - Ação **"Generate Base Steering"** que pede ao agente ativo para criar `product.md`, `tech.md` e `structure.md` analisando o workspace.
- **Critérios de Aceite (DoD)**:
  - [ ] TreeView **Agent Steering** lista, cria e abre arquivos `.tarot/steering/*.md` em tempo real via `FileSystemWatcher`.
  - [ ] Contexto de Steering é anexado ao prompt efetivo de `claude`, `codex` e `agy` de forma transparente e visível no painel.

---

### Marco M3.5 — Spec-Driven Development (`.tarot/specs/<slug>/`) (UC-03)
- **Objetivo**: implementar o fluxo completo do Kiro IDE de especificação antes da implementação: **`requirements.md` → `design.md` → `tasks.md` → execução tarefa a tarefa**.
- **Arquivos-alvo**:
  - `extensions/tarot-core/src/specs/specService.ts`
  - `extensions/tarot-core/src/specs/taskParser.ts`
  - Integração com `tarotSidebarViews.ts` e `agentPanelView.ts`
- **Especificação**:
  - Estrutura em disco: `.tarot/specs/<slug>/{requirements.md,design.md,tasks.md}`.
  - Transições guiadas com portão de aprovação humana entre cada fase (Requirements → Design → Tasks).
  - CodeLens (ou ações inline na TreeView) sobre itens `- [ ]` em `tasks.md`: **"Run Task with Active Agent"** e **"Run Task with..."** (escolhendo `claude` / `codex` / `agy`), atualizando automaticamente para `- [x]` após validação.
- **Critérios de Aceite (DoD)**:
  - [ ] Criar nova Spec no **Spec Mode** gera sequencialmente os 3 arquivos Markdown no workspace.
  - [ ] TreeView **Specs** mostra o progresso (ex.: `3/7 tasks`) e permite disparar tarefas individuais.
  - [ ] Cada execução de tarefa injeta automaticamente `requirements.md`, `design.md`, `tasks.md` e os arquivos de **Steering** aplicáveis.

---

### Marco M3.6 — Agent Hooks (`.tarot/hooks/*.json`) (UC-05)
- **Objetivo**: automações orientadas a eventos do editor que invocam agentes locais em segundo plano.
- **Arquivos-alvo**:
  - `extensions/tarot-core/src/hooks/hookEngine.ts`
  - Integração com `tarotSidebarViews.ts`
- **Schema de Hook (`.tarot/hooks/<id>.json`)**:
  ```json
  {
    "id": "update-tests-on-save",
    "name": "Atualizar testes ao salvar",
    "enabled": true,
    "trigger": "onSave",
    "glob": "src/**/*.ts",
    "agent": "default",
    "prompt": "Verifique se o arquivo alterado {{file}} exige atualização nos testes unitários."
  }
  ```
- **Critérios de Aceite (DoD)**:
  - [ ] Suporta gatilhos `onSave`, `onCreate`, `onDelete` e `manual` com debounce e fila para evitar disparos simultâneos redundantes.
  - [ ] **Bloqueado automaticamente quando `!vscode.workspace.isTrusted`** (exigência de segurança).
  - [ ] Toggle habilitar/desabilitar e execução manual direto na TreeView **Agent Hooks**, com log dedicado no OutputChannel `Tarot IDE`.

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
