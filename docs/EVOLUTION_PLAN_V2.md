# Tarot IDE — Plano de Evolução Agêntica v2 (Agent-Ready · Fase 6)

> **Guia de execução estruturado para agentes de IA e engenheiros.**
> Este documento dá continuidade ao [MIGRATION_PLAN.md](./MIGRATION_PLAN.md) (Fases 1–5 **100% concluídas**).
> Cada marco abaixo define: **Objetivo**, **Arquivos-Alvo**, **Contratos/Especificação**, **Critérios de Aceite (DoD)** e **Comandos de Verificação**.
>
> **Invariantes obrigatórias** (ver [AGENTS.md](../AGENTS.md) e [PROJECT_CONTEXT.md](./PROJECT_CONTEXT.md)):
> - **100% Extension-First** (`extensions/tarot-core/`), sem tocar `src/vs/`.
> - **Package manager**: somente `pnpm` (nunca `npm`).
> - **Segurança BYOA & Webviews**: `spawn(bin, args, { shell: false })`, `vscode.workspace.isTrusted` antes de carregar `.tarot/`, CSP estrita com `nonce` e **zero `innerHTML`**.
> - **Idioma**: UI chrome em Inglês (`vscode.l10n.t()` + `package.nls.json`), prompts/templates gerados em PT-BR, docs em PT-BR.

---

## Mapa Geral da Fase 6 (`M6.1–M6.34`)

| Marco | Título | Inspiração | Prioridade | Dependências | Status |
| :--- | :--- | :--- | :---: | :--- | :--- |
| **M6.1** | **Cursor-Style Diff Review (`Accept / Reject` por Arquivo, Git e Non-Git)** | Cursor + Kiro | P0 | `checkpointService.ts`, `agentPanelView.ts` | ✅ Concluído |
| **M6.1b** | **Auto-Contexto do Arquivo Atual no Chat (*Current File Chip* + Seleção ao Vivo)** | Cursor + Kiro + VS Code | P0 | `agentPanelView.ts`, `panel.js`, `activeFileContext.ts` | ✅ Concluído |
| **M6.2** | **Sistema Unificado de Slash Commands (`/comando`) no Chat e Focus Mode** | Kiro + Claude Code | P0 | `agentPanelView.ts`, `focusModeView.ts` | 📋 Planejado |
| **M6.3** | **Inline Quick Edit (`Ctrl+K`) + Quick Fix Agêntico (`Fix with Tarot`)** | Kiro + Cursor | P0 | `M6.1` | 📋 Planejado |
| **M6.4** | **Colar & Arrastar Imagens no Chat e Focus Mode (`Ctrl+V` / Drag & Drop)** | Kiro | P0 | `panel.js`, `focusMode.js` | 📋 Planejado |
| **M6.5** | **Criação em Linguagem Natural de Agent Hooks & Schedules (*"Ask Tarot to create..."*)** | Kiro | P0 | `visualConfigEditors.ts` | 📋 Planejado |
| **M6.6** | **Natural Language to Shell no Terminal com Gate de Permissões** | Kiro | P0 | `permissionsService.ts` | 📋 Planejado |
| **M6.7** | **Inline Code Diffs Coloridos (`+`/`-`) na Conversa + `Keep`/`Revert` por Arquivo** | Kiro + Cursor | P0 | `M6.1`, `panel.js` | ✅ Concluído |
| **M6.8** | **Comando `/rewind` Interativo por Turno (*Fork* vs *Restore Checkpoint*)** | Kiro | P1 | `M6.2`, `checkpointService.ts` | 📋 Planejado |
| **M6.9** | **Painéis Redimensionáveis (Drag Handles) + Strip só de Ícones no Focus Mode** | Kiro | P1 | `focusMode.{js,css}` | 📋 Planejado |
| **M6.10** | **Exportação Portável de Sessão `.zip`** | Kiro | P1 | `compactionService.ts` | 📋 Planejado |
| **M6.10b** | **Spec-to-Code Drift Check (`tarot.specs.checkDrift`)** | Kiro | P1 | `specService.ts` | 📋 Planejado |
| **M6.11** | **Autocomplete Inline de Arquivos & Símbolos (`@arquivo` / `#arquivo`) no Composer** | Kiro + Cursor | P0 | `M6.1b`, `panel.js`, `focusMode.js` | 📋 Planejado |
| **M6.12** | **Fila de Mensagens (*Prompt Queue*) enquanto o Agente Executa** | Kiro + Cursor | P0 | `agentPanelView.ts`, `panel.js` | 📋 Planejado |
| **M6.13** | **Guided Compaction (`/compact <diretriz>`)** | Kiro (Nov/2026) | P0 | `M6.2`, `compactionService.ts` | 📋 Planejado |
| **M6.14** | **Output Longo de Hooks Salvo em Arquivo (`> 3.000 chars`)** | Kiro (Nov/2026) | P0 | `hookEngine.ts` | 📋 Planejado |
| **M6.14b** | **Trigger `SubagentStop` em Agent Hooks** | Kiro (Nov/2026) | P0 | `hookEngine.ts`, `subagentManager.ts` | 📋 Planejado |
| **M6.15** | **Live Browser Preview (`localhost`) + Captura de Erros de Console no Chat** | Kiro `browser-harness` | P1 | `M6.4`, `devServerService.ts` | 📋 Planejado |
| **M6.16** | **Spec Task Waves (Execução por Ondas de Dependência)** | Kiro Specs | P1 | `specService.ts` | 📋 Planejado |
| **M6.16b** | **Evidence Summary Pré-PR Consolidado** | Frontier | P1 | `M6.10b`, `M6.16`, `specService.ts`, `gitReviewService.ts` | 📋 Planejado |
| **M6.17** | **Card Clicável de Comandos Pendentes no Chat (`▶ Run & Feed Output`)** | Cursor + Claude Code | P0 | `permissionsService.ts`, `agentPanelView.ts` | 📋 Planejado |
| **M6.18** | **Auto-Detecção de Diagnósticos Pós-Edição (`✦ Fix N errors` na Review Bar)** | Cursor + Windsurf | P0 | `M6.1`, `reviewSessionService.ts` | 📋 Planejado |
| **M6.19** | **Quick Fix Direto em Erros do Terminal (`registerTerminalQuickFixProvider`)** | Cursor + VS Code | P0 | `extension.ts`, `agentPanelView.ts` | 📋 Planejado |
| **M6.20** | **Compatibilidade Nativa com Regras Externas (`CLAUDE.md`, `.cursor/rules/*.mdc`, `.windsurfrules`)** | Cursor + Windsurf + Claude | P0 | `steeringService.ts` | 📋 Planejado |
| **M6.21** | **Execução Paralela Real em Background (Multi-Sessão Concorrente em Worktrees)** | Cursor + Zed | P1 | `agentPanelView.ts`, `worktreeManager.ts` | 📋 Planejado |
| **M6.22** | **Tab Autocomplete Inline (Ghost-Text FIM Opt-in via Ollama / Endpoint Local)** | Cursor + Zed | P1 | `extension.ts`, `tarotConfig.ts` | 📋 Planejado |
| **M6.23** | **Telemetria Local de Sessão (Tokens, Custo por Turno e Timeline de Ferramentas)** | Claude Code + Cursor | P1 | `sessionStore.ts`, `compactionService.ts`, `panel.js` | 📋 Planejado |
| **M6.24** | **Bugbot-Style PR Review Agent (Autofix via Background Agent)** | Cursor | P1 | `M6.1`, `gitReviewService.ts`, `M6.16b` | 📋 Planejado |
| **M6.25** | **Background Agents via Gatilho Externo (`@tarot` em GitHub/Slack/Linear)** | Cursor | P1 | `M6.21`, `permissionsService.ts` | 📋 Planejado |
| **M6.26** | **Automations por Evento de Git/PR (`on: push, pull_request`)** | Cursor | P1 | `M6.5`, `hookEngine.ts` | 📋 Planejado |
| **M6.27** | **MCP Marketplace Interno de Workspace/Time** | Cursor | P2 | `mcpConfigService.ts` | 📋 Planejado |
| **M6.28** | **Sign-In OAuth Diferido para MCP (Non-Blocking Auth)** | Kiro | P2 | `mcpConfigService.ts` | 📋 Planejado |
| **M6.29** | **Memória Persistente por Sub-Agente (Formato Steering)** | Kiro | P1 | `subagentManager.ts`, `steeringService.ts` | 📋 Planejado |
| **M6.30** | **Resumo Automático de Sessão sem Gatilho Manual** | Claude Code | P0 | `M6.13`, `compactionService.ts` | 📋 Planejado |
| **M6.31** | **Sincronização de Estado de Sessão entre Múltiplas Janelas** | Kiro | P2 | `sessionStore.ts`, `agentPanelView.ts` | 📋 Planejado |
| **M6.32** | **Output Styles — Personas de Resposta Reutilizáveis** | Claude Code | P1 | `steeringService.ts`, `M6.2` | 📋 Planejado |
| **M6.33** | **Safe Mode (Boot de Emergência sem AGENTS.md/Hooks/MCP/Skills)** | Claude Code | P1 | `extension.ts`, `permissionsService.ts` | 📋 Planejado |
| **M6.34** | **Modo Acessibilidade (Plain-Text / Screen Reader) no Painel Agêntico** | Claude Code | P2 | `agentPanelView.ts`, `panel.js` | 📋 Planejado |

---

## M6.1 — Cursor-Style Diff Review (`Accept / Reject` por Arquivo, Git e Non-Git)

### Objetivo
Entregar uma experiência de revisão de código estilo Cursor/Git nativa no VS Code após edições de qualquer agente BYOA (`claude`, `agy`, `codex`): abrir automaticamente o **Diff Editor (`Before ↔ Agent Edit`)** com botões de **`✓ Accept File`**, **`✕ Reject File`**, **`✓ Accept All`**, **`✕ Reject All`** e **`Next File`** no CodeLens, na barra de título do editor e na Status Bar — funcionando **tanto em repositórios Git quanto em pastas sem Git**.

### Arquivos-Alvo
- `[NEW]` `src/vs/workbench/contrib/tarotReview/browser/{tarotReview.contribution.ts,tarotReview.css}` & `[MODIFY]` `src/vs/workbench/workbench.common.main.ts` *(contrib Monaco isolado para ViewZone vermelha, ContentWidget de pills por hunk e OverlayWidget flutuante — impossível via Extension API; registrado em `PROJECT_CONTEXT.md` §5 e `MIGRATION_PLAN.md`)*
- `[NEW]` `extensions/tarot-core/src/review/{reviewSessionService.ts,reviewSessionModel.ts,diffHunkEngine.ts}`
- `[MODIFY]` `extensions/tarot-core/src/checkpoints/checkpointService.ts` & `src/git/gitReviewService.ts`
- `[MODIFY]` `extensions/tarot-core/src/views/{agentPanelView.ts,panelHtml.ts,panelProtocol.ts,panelStrings.ts}` & `media/webview/{panel.js,panel.css}`
- `[MODIFY]` `extensions/tarot-core/src/extension.ts`, `package.json` & `package.nls.json`
- `[NEW]` `extensions/tarot-core/src/test/{reviewSessionModel.test.ts,diffHunkEngine.test.ts}`

### Contratos & Especificação
1. **Snapshot pré-turno universal (Git e Non-Git)**:
   - Em `checkpointService.ts`, classifica corretamente arquivos Git rastreados modificados/deletados vs novos (`git status --porcelain -uall`) e, quando o workspace **não** tem `.git`, faz backup leve dos arquivos de texto existentes (≤ 512 KB) no checkpoint pré-turno para diffs `Before ↔ After` e `Reject` reversível.
2. **Inline Diff Review nativo no Editor Único (estilo Cursor)**:
   - `src/vs/workbench/contrib/tarotReview/` recebe o estado via comando interno `_tarot.inlineReview.setState` e renderiza diretamente no arquivo normal (sem split 2 colunas): linhas removidas em vermelho (`ViewZone`), linhas adicionadas em verde (`decoration`), pills flutuantes **`Accept`** / **`Reject`** por hunk (`ContentWidget`) e barra flutuante no rodapé central **`↑ 1 of N ↓ | File X/Y → | Reject File (Alt+N) | Accept File (Alt+Y)`** (`OverlayWidget`).
   - Apenas arquivos deletados usam fallback `vscode.diff` com `tarot-checkpoint-before:`.
3. **Controles na Review Bar do Chat & Sincronização**:
   - Review Bar expande automaticamente com **`✓ Accept All`**, **`✕ Reject All`**, estatísticas reais `+N -M` e botões **`✓`** / **`✕`** por arquivo, sincronizada com Editor Title, Status Bar, Focus Mode e `fileWriteGate`.

### Critérios de Aceite (DoD)
- [x] `TarotReviewSessionService` + `diffHunkEngine.ts` + contrib nativo `tarotReview` implementados com Accept/Reject por hunk e por arquivo, barra flutuante, Status Bar e atalhos `Alt+Y`/`Alt+N`.
- [x] `checkpointService.ts` classifica corretamente arquivos Git rastreados (`-uall`) e grava backups leves pré-turno em workspaces sem Git (≤ 512 KB).
- [x] `Reject Hunk` / `Reject File` restaura exatamente o bloco ou arquivo original; `Accept Hunk` / `Accept File` / `Accept All` limpa o overlay, decorações e estado pendente ao vivo.
- [x] Testes unitários passando (178/178) + `compile-extension:tarot-core` + `esbuild.mts` + `node build/next/index.ts transpile` + `pnpm run typecheck-client` com 0 erros + 0 ocorrências de `innerHTML`/`shell: true`.

> **Risco observado em concorrentes (Kiro):** relatos de usuários apontam o agente editando um snapshot interno em vez do arquivo real, gerando estado inconsistente entre o que é mostrado e o que está em disco. `Accept`/`Reject` em `M6.1` deve sempre operar sobre o arquivo real do workspace, nunca sobre uma cópia em memória desatualizada — já coberto pelo DoD acima, mantido como lembrete de regressão.

---

## M6.2 — Sistema Unificado de Slash Commands (`/comando`) no Chat e Focus Mode

### Objetivo
Unificar e expandir o sistema de `/comandos` estilo Kiro / Claude Code com autocomplete pesquisável, navegação por teclado (`↑`/`↓`/`Tab`/`Enter`) e suporte idêntico no **Painel Lateral** e no **Focus Mode**.

### Arquivos-Alvo
- `[NEW]` `extensions/tarot-core/src/commands/slashCommandRegistry.ts`
- `[MODIFY]` `extensions/tarot-core/src/views/agentPanelView.ts`
- `[MODIFY]` `extensions/tarot-core/src/views/focusModeView.ts`
- `[MODIFY]` `extensions/tarot-core/media/webview/panel.js` & `media/webview/focusMode.js`
- `[NEW]` `extensions/tarot-core/src/test/slashCommandRegistry.test.ts`

### Contratos & Especificação
- Comandos built-in agrupados por categoria:
  - **Workflow & Modes**: `/spec`, `/quick-spec`, `/bugfix`, `/plan`, `/vibe`, `/workflow`, `/focus`
  - **Code & Review**: `/review`, `/diff`, `/rewind`, `/undo`
  - **Session & Context**: `/compact`, `/recap`, `/context`, `/clear`, `/export`, `/help`
  - **Config & Tools**: `/model`, `/permissions`, `/hook`, `/schedule`, `/mcp`, `/steering`
  - **Dynamic Discovery**: `/<agent-profile>`, `/<skill-id>`, `/<steering-id>`

### Critérios de Aceite (DoD)
- [ ] `slashCommandRegistry.ts` lista e filtra comandos estáticos + dinâmicos (agentes, skills, steering).
- [ ] Menu `/` funciona por teclado e clique tanto no Painel Lateral quanto no Focus Mode.
- [ ] `/diff`, `/permissions`, `/model`, `/recap`, `/compact`, `/hook`, `/schedule`, `/mcp`, `/help` executam ações reais.
- [ ] Testes unitários para parsing, filtro fuzzy e despacho de comandos.

---

## M6.3 — Inline Quick Edit (`Ctrl+K`) + Quick Fix Agêntico (`Fix with Tarot`)

### Objetivo
Permitir editar código diretamente no editor via `Ctrl+K` com preview no Diff Review (`M6.1`) e corrigir diagnósticos (`Problems`) com 1 clique via lâmpada `Ctrl+.` (`✦ Fix with Tarot`).

### Arquivos-Alvo
- `[NEW]` `extensions/tarot-core/src/editors/inlineEditService.ts`
- `[NEW]` `extensions/tarot-core/src/editors/tarotCodeActionProvider.ts`
- `[MODIFY]` `extensions/tarot-core/src/extension.ts`, `package.json`, `package.nls.json`
- `[NEW]` `extensions/tarot-core/src/test/inlineEdit.test.ts`

### Critérios de Aceite (DoD)
- [ ] `Ctrl+K` no editor coleta instrução + seleção/arquivo ativo, executa o agente BYOA e abre o diff no `M6.1` (`Accept / Reject`).
- [ ] `CodeActionProvider` oferece `✦ Fix with Tarot` em erros/warnings e `✦ Explain / Refactor with Tarot` em seleções.
- [ ] Respeita `vscode.workspace.isTrusted` e permissões configuradas.

---

## M6.4 — Colar & Arrastar Imagens no Chat e Focus Mode (`Ctrl+V` / Drag & Drop)

### Objetivo
Suportar colagem (`Ctrl+V`) e arraste (Drag & Drop) de screenshots/mockups (PNG, JPEG, WebP até 10 MB) no composer do Painel Lateral e do Focus Mode, salvando em `.tarot/attachments/` e anexando o caminho ao prompt BYOA.

### Arquivos-Alvo
- `[NEW]` `extensions/tarot-core/src/context/imageAttachmentService.ts`
- `[MODIFY]` `extensions/tarot-core/src/views/agentPanelView.ts`, `focusModeView.ts`
- `[MODIFY]` `extensions/tarot-core/media/webview/panel.js`, `focusMode.js`, `panel.css`, `focusMode.css`
- `[NEW]` `extensions/tarot-core/src/test/imageAttachmentService.test.ts`

### Critérios de Aceite (DoD)
- [ ] Validação estrita de MIME (`image/png`, `image/jpeg`, `image/webp`) e limite máximo de 10 MB.
- [ ] Preview seguro em thumbnail (DOM puro, zero `innerHTML`) com botão remover.
- [ ] Caminho absoluto da imagem repassado aos adaptadores `claude`/`agy`/`codex`.

---

## M6.5 — Criação em Linguagem Natural de Agent Hooks & Schedules

### Objetivo
Adicionar fluxo *"Ask Tarot to create..."* nos editores visuais e na sidebar de Hooks e Schedules para gerar o JSON estruturado via agente BYOA, validar com `parseHookFile` / `isValidCronExpression` antes de gravar e abrir imediatamente no editor visual.

### Arquivos-Alvo
- `[NEW]` `extensions/tarot-core/src/commands/nlConfigGenerator.ts`
- `[MODIFY]` `extensions/tarot-core/src/views/visualConfigEditors.ts`, `extension.ts`, `package.json`
- `[NEW]` `extensions/tarot-core/src/test/nlConfigGenerator.test.ts`

### Critérios de Aceite (DoD)
- [ ] Geração validada de Hooks (`.tarot/hooks/*.json`) e Schedules (`.tarot/schedules/*.json`) a partir de descrição em linguagem natural.
- [ ] Rejeição segura de JSON inválido ou cron inválido antes de gravar em disco.

---

## M6.6 — Natural Language to Shell no Terminal com Gate de Permissões

### Objetivo
Comando `tarot.terminal.nlToShell` (`Ctrl+Shift+K` no terminal ou Command Palette) que traduz uma intenção em linguagem natural para comando shell seguro, valida via `permissionsService.evaluateShellCommand` e pede confirmação antes de enviar ao terminal ativo.

### Arquivos-Alvo
- `[NEW]` `extensions/tarot-core/src/commands/nlToShellCommand.ts`
- `[MODIFY]` `extensions/tarot-core/src/extension.ts`, `package.json`, `package.nls.json`
- `[NEW]` `extensions/tarot-core/src/test/nlToShell.test.ts`

### Critérios de Aceite (DoD)
- [ ] Comandos `deny` na política de permissões são bloqueados antes de chegar ao terminal.
- [ ] Preview do comando gerado + botão `Run in Terminal` / `Copy` / `Cancel`.

---

## M6.7 — Inline Code Diffs Coloridos (`+`/`-`) na Conversa + `Keep`/`Revert` por Arquivo

### Objetivo
Renderizar hunks coloridos (`+` verde / `-` vermelho) diretamente no card de arquivos alterados da conversa (Painel Lateral e Focus Mode), usando DOM puro (zero `innerHTML`) e conectados ao `TarotReviewSessionService` (`M6.1`).

### Arquivos-Alvo
- `[MODIFY]` `extensions/tarot-core/src/views/agentPanelView.ts`, `focusModeView.ts`
- `[MODIFY]` `extensions/tarot-core/media/webview/panel.js`, `panel.css`, `focusMode.js`, `focusMode.css`

### Critérios de Aceite (DoD)
- [x] Diff colapsável por arquivo dentro do chat com botões `Open Diff`, `✓` (Accept) e `✕` (Reject).
- [x] Zero `innerHTML`; 100% compatível com Dark e Light themes.

---

## M6.8 — Comando `/rewind` Interativo por Turno (*Fork* vs *Restore Checkpoint*)

### Objetivo
Permitir executar `/rewind` no chat para escolher qualquer turno anterior da sessão e decidir entre **Fork Conversation** (nova sessão a partir dali sem tocar arquivos) ou **Restore Checkpoint + Rewind** (restaurar código + conversa).

### Arquivos-Alvo
- `[MODIFY]` `extensions/tarot-core/src/views/agentPanelView.ts`, `src/commands/slashCommandRegistry.ts`

### Critérios de Aceite (DoD)
- [ ] QuickPick listando turnos com timestamp, resumo e indicador de checkpoint disponível.
- [ ] Ambas as opções (`Fork` e `Restore Checkpoint`) testadas e funcionais.

---

## M6.9 — Painéis Redimensionáveis (Drag Handles) + Strip só de Ícones no Focus Mode

### Objetivo
Adicionar divisórias arrastáveis (drag handles) entre Sessions, Chat e Inspector no Focus Mode + modo colapsado (strip só de ícones) com persistência das larguras em `globalState`.

### Arquivos-Alvo
- `[MODIFY]` `extensions/tarot-core/media/webview/focusMode.js`, `focusMode.css`
- `[MODIFY]` `extensions/tarot-core/src/views/focusModeView.ts`

### Critérios de Aceite (DoD)
- [ ] Drag handles suaves sem seleção de texto acidental; larguras persistidas entre sessões.
- [ ] Toggle para colapsar sidebar esquerda em strip de ícones.
- [ ] **Risco a evitar (queixa recorrente sobre a "Agents Window" do Cursor):** o Focus Mode redimensionável não pode perder diff view, navegação de arquivos ou funcionalidade de LSP presentes no editor clássico — validar lado a lado antes de concluir o marco.

---

## M6.10 — Exportação Portável de Sessão `.zip`

### Objetivo
Exportar uma sessão completa (transcrição Markdown, JSON da sessão, anexos e diffs) em um único arquivo `.zip` gerado em Node.js puro (sem binários externos).

### Arquivos-Alvo
- `[NEW]` `extensions/tarot-core/src/sessions/zipExporter.ts`
- `[MODIFY]` `extensions/tarot-core/src/extension.ts`, `package.json`
- `[NEW]` `extensions/tarot-core/src/test/zipExporter.test.ts`

### Critérios de Aceite (DoD)
- [ ] `.zip` válido gerado com `zlib.deflateRawSync` + cabeçalhos PKZIP padrão e testado por teste unitário.

---

## M6.10b — Spec-to-Code Drift Check (`tarot.specs.checkDrift`)

### Objetivo
Comando `tarot.specs.checkDrift` que compara o estado atual do código contra `.tarot/specs/<slug>/{requirements,design}.md` e gera relatório de aderência/drift.

### Arquivos-Alvo
- `[MODIFY]` `extensions/tarot-core/src/commands/specCommands.ts`, `src/specs/specService.ts`
- `[NEW]` `extensions/tarot-core/src/test/specDriftCheck.test.ts`

### Critérios de Aceite (DoD)
- [ ] `tarot.specs.checkDrift` funcional para qualquer Spec do workspace, apontando requisitos/design sem cobertura correspondente no código atual.

---

## M6.11 — Autocomplete Inline de Arquivos & Símbolos (`@arquivo` / `#arquivo`) no Composer

### Objetivo
Permitir digitar `@` ou `#` seguido de qualquer parte do nome de arquivo, pasta, spec ou símbolo diretamente no composer do Painel Lateral e do Focus Mode, exibindo popup fuzzy navegável por teclado (`↑`/`↓`/`Tab`/`Enter`) sem abrir modais QuickPick.

### Arquivos-Alvo
- `[NEW]` `extensions/tarot-core/src/context/inlineMentionService.ts`
- `[MODIFY]` `extensions/tarot-core/src/views/{agentPanelView.ts,focusModeView.ts,panelProtocol.ts}`
- `[MODIFY]` `extensions/tarot-core/media/webview/{panel.js,panel.css,focusMode.js}`
- `[NEW]` `extensions/tarot-core/src/test/inlineMentionService.test.ts`

### Critérios de Aceite (DoD)
- [ ] Digitar `@` ou `#` + texto no composer consulta arquivos/pastas/specs do workspace com ranking fuzzy e insere o chip diretamente ao confirmar.
- [ ] Funciona por teclado e clique tanto no Painel Lateral quanto no Focus Mode, respeitando exclusões (`node_modules`, `.git`, `.tarot/sessions`, `.tarot/checkpoints`).

---

## M6.12 — Fila de Mensagens (*Prompt Queue*) enquanto o Agente Executa

### Objetivo
Permitir que o usuário continue digitando e enfileirando prompts de follow-up enquanto o agente executa o turno atual (em vez de bloquear com *"The agent is currently busy"*), exibindo a fila acima do composer com opções de editar, remover ou executar imediatamente ao fim do turno.

### Arquivos-Alvo
- `[MODIFY]` `extensions/tarot-core/src/views/{agentPanelView.ts,panelProtocol.ts,panelStrings.ts}`
- `[MODIFY]` `extensions/tarot-core/media/webview/{panel.js,panel.css}`
- `[NEW]` `extensions/tarot-core/src/test/promptQueue.test.ts`

### Critérios de Aceite (DoD)
- [ ] Enviar mensagem durante `isRunning === true` adiciona à fila da sessão ativa (com snapshot dos anexos) e exibe pill/lista compacta acima do composer.
- [ ] Ao concluir o turno sem cancelamento, o próximo item da fila é despachado automaticamente; cancelar o turno oferece limpar ou manter a fila.

---

## M6.13 — Guided Compaction (`/compact <diretriz>`)

### Objetivo
Estender `/compact` e `compactionService.ts` para aceitar instruções explícitas do usuário (ex.: `/compact Preserve as decisões de migração e os passos de validação`), garantindo que o resumo compactado destaque e preserve integralmente o foco solicitado.

### Arquivos-Alvo
- `[MODIFY]` `extensions/tarot-core/src/context/compactionService.ts`
- `[MODIFY]` `extensions/tarot-core/src/views/agentPanelView.ts`
- `[MODIFY]` `extensions/tarot-core/src/test/compactionService.test.ts`

### Critérios de Aceite (DoD)
- [ ] `/compact <diretriz>` repassa a diretriz ao resumo estruturado e destaca uma seção `Guided Focus` preservada na compactação.
- [ ] Testes unitários validam compactação guiada vs padrão.
- [ ] **Risco a evitar (queixa recorrente em Cursor/Claude Code):** compactação nunca é silenciosa — todo resumo (manual ou automático, ver `M6.30`) exibe no chat o que foi preservado e o que foi condensado antes de seguir.

---

## M6.14 — Output Longo de Hooks Salvo em Arquivo (`> 3.000 chars`)

### Objetivo
Quando um Agent Hook produzir saída superior a 3.000 caracteres, salvar o log completo em `.tarot/hooks/output/<timestamp>-<hook>.log` e injetar no contexto apenas um resumo + caminho do arquivo, evitando estourar a janela de contexto.

### Arquivos-Alvo
- `[MODIFY]` `extensions/tarot-core/src/hooks/{hookTypes.ts,hookEngine.ts,hookRunner.ts}`
- `[MODIFY]` `extensions/tarot-core/src/test/hookEngine.test.ts`

### Critérios de Aceite (DoD)
- [ ] Saídas de hook `> 3.000` chars gravam arquivo em `.tarot/hooks/output/` e retornam referência + tail truncado ao agente.

---

## M6.14b — Trigger `SubagentStop` em Agent Hooks

### Objetivo
Adicionar o gatilho `SubagentStop` ao `hookEngine.ts` e `subagentManager.ts`, disparado ao término de cada sub-agente para permitir validação ou uma instrução extra antes de retornar o resultado ao agente pai.

### Arquivos-Alvo
- `[MODIFY]` `extensions/tarot-core/src/hooks/{hookTypes.ts,hookEngine.ts}`
- `[MODIFY]` `extensions/tarot-core/src/agents/subagentManager.ts`
- `[MODIFY]` `extensions/tarot-core/src/test/hookEngine.test.ts`

### Critérios de Aceite (DoD)
- [ ] Trigger `SubagentStop` suportado no schema `v1`, editor visual de hooks e execução de sub-agentes, respeitando `vscode.workspace.isTrusted`.

---

## M6.15 — Live Browser Preview (`localhost`) + Captura de Erros de Console no Chat

### Objetivo
Integrar o `devServerService.ts` com um painel Webview de Preview para apps locais (`http://127.0.0.1:*` / `http://localhost:*`), permitindo visualizar a aplicação rodando e enviar erros de console/runtime ou captura visual diretamente para o chat do agente em 1 clique.

### Arquivos-Alvo
- `[NEW]` `extensions/tarot-core/src/views/browserPreviewPanel.ts`
- `[MODIFY]` `extensions/tarot-core/src/crew/devServerService.ts`, `src/extension.ts`, `package.json`

### Critérios de Aceite (DoD)
- [ ] Restrito estritamente a origens locais (`localhost` / `127.0.0.1`), respeitando CSP segura e zero `innerHTML`.
- [ ] Ação *"Send Console Error / Preview to Tarot"* anexa o diagnóstico diretamente ao composer ativo.

---

## M6.16 — Spec Task Waves (Execução por Ondas de Dependência)

### Objetivo
Executar as tarefas de uma Spec (`tasks.md`) em **ondas** calculadas pelo grafo de dependências declarado entre tarefas, em vez de sequencialmente uma a uma — permitindo que tarefas independentes dentro da mesma onda sejam agrupadas (e, quando `M6.21` estiver disponível, executadas em paralelo em worktrees distintos).

### Arquivos-Alvo
- `[MODIFY]` `extensions/tarot-core/src/specs/specService.ts`
- `[MODIFY]` `extensions/tarot-core/src/commands/specCommands.ts`
- `[NEW]` `extensions/tarot-core/src/test/specTaskWaves.test.ts`

### Critérios de Aceite (DoD)
- [ ] `Run All Tasks` calcula ondas a partir do grafo de dependências de `tasks.md`; tarefas sem dependência mútua ficam na mesma onda.
- [ ] Falha em uma tarefa de uma onda interrompe apenas as tarefas dependentes dela, não as demais ondas já concluídas.

---

## M6.16b — Evidence Summary Pré-PR Consolidado

### Objetivo
Consolidar um **Evidence Summary** automático ao concluir `Run All Tasks` (ondas de `M6.16`) ou ao acionar **Pre-PR Review**, reunindo testes executados, status de lint/build, diff total e checagem de Spec Drift (`M6.10b`) em um cartão pronto para revisão humana ou descrição de PR.

### Arquivos-Alvo
- `[NEW]` `extensions/tarot-core/src/specs/evidenceSummary.ts`
- `[MODIFY]` `extensions/tarot-core/src/commands/specCommands.ts`, `src/git/gitReviewService.ts`
- `[NEW]` `extensions/tarot-core/src/test/evidenceSummary.test.ts`

### Critérios de Aceite (DoD)
- [ ] Gera resumo Markdown estruturado (Spec, ondas/tarefas concluídas, testes/evidências, arquivos alterados e drift) copiável para PR ou exibido no chat.

---

## M6.17 — Card Clicável de Comandos Pendentes no Chat (`▶ Run & Feed Output`)

### Objetivo
Quando um agente headless (`claude`/`agy`/`codex`) sugerir um comando shell bloqueado por permissão (ex.: `node --test`, `pnpm test`), renderizar um card clicável **`▶ Run & Send Output to Tarot`** diretamente na mensagem do chat, validando o comando via `permissionsService.evaluateShellCommand`, executando-o com `spawn(..., { shell: false })` ou terminal integrado e devolvendo o stdout/stderr ao agente em 1 clique.

### Arquivos-Alvo
- `[NEW]` `extensions/tarot-core/src/commands/pendingShellCard.ts`
- `[MODIFY]` `extensions/tarot-core/src/views/{agentPanelView.ts,panelProtocol.ts,panelStrings.ts}`
- `[MODIFY]` `extensions/tarot-core/media/webview/{panel.js,panel.css}`
- `[NEW]` `extensions/tarot-core/src/test/pendingShellCard.test.ts`

### Critérios de Aceite (DoD)
- [ ] Comandos `deny` na política de permissões são bloqueados antes da execução; comandos aprovados rodam e anexam a saída ao próximo turno do agente.

---

## M6.18 — Auto-Detecção de Diagnósticos Pós-Edição (`✦ Fix N errors`)

### Objetivo
Escutar `vscode.languages.onDidChangeDiagnostics` nos arquivos tocados pela sessão de revisão (`M6.1`): se novos erros de compilação/lint surgirem após a edição do agente, exibir um pill **`✦ N error(s) — Fix with Tarot`** na Review Bar para corrigir em 1 clique.

### Arquivos-Alvo
- `[MODIFY]` `extensions/tarot-core/src/review/reviewSessionService.ts`
- `[MODIFY]` `extensions/tarot-core/src/views/agentPanelView.ts` & `media/webview/{panel.js,panel.css}`

### Critérios de Aceite (DoD)
- [ ] Detecta diagnósticos `DiagnosticSeverity.Error` nos arquivos pendentes de revisão e dispara prompt focado com arquivo + mensagens exatas de erro ao clicar.

---

## M6.19 — Quick Fix Direto em Erros do Terminal (`registerTerminalQuickFixProvider`)

### Objetivo
Registrar `vscode.window.registerTerminalQuickFixProvider` para oferecer **`✦ Fix with Tarot`** diretamente na linha de erros do terminal integrado, enviando comando + saída de erro + arquivos do stack trace para o chat do agente.

### Arquivos-Alvo
- `[NEW]` `extensions/tarot-core/src/editors/terminalQuickFixProvider.ts`
- `[MODIFY]` `extensions/tarot-core/src/extension.ts`, `package.json`

### Critérios de Aceite (DoD)
- [ ] Erros comuns de build/test/runtime no terminal oferecem ação rápida **`✦ Fix with Tarot`** que abre o chat com o diagnóstico anexado.

---

## M6.20 — Compatibilidade Nativa com Regras Externas (`CLAUDE.md`, `.cursor/rules/*.mdc`, `.windsurfrules`)

### Objetivo
Estender `steeringService.ts` para descobrir automaticamente arquivos de regras de outros ecossistemas (`CLAUDE.md`, `.cursorrules`, `.cursor/rules/*.mdc`, `.windsurfrules`, `.github/copilot-instructions.md`) respeitando `vscode.workspace.isTrusted`, além de oferecer comando 1-clique para importá-los em `.tarot/steering/`.

### Arquivos-Alvo
- `[MODIFY]` `extensions/tarot-core/src/steering/steeringService.ts`
- `[MODIFY]` `extensions/tarot-core/src/test/steeringService.test.ts`

### Critérios de Aceite (DoD)
- [ ] Regras externas descobertas com precedência abaixo de `.tarot/steering/` e `AGENTS.md`, sem duplicação e com testes unitários cobrindo parsing de frontmatter `.mdc`.

---

## M6.21 — Execução Paralela Real em Background (Multi-Sessão Concorrente em Worktrees)

### Objetivo
Substituir o lock global único `runningSessionId` em `agentPanelView.ts` por `Map<sessionId, CancellationTokenSource>`, permitindo executar múltiplos agentes simultaneamente em sessões/Git Worktrees isolados com badge de progresso nas abas e notificação quando um agente em background concluir ou pedir aprovação.

### Arquivos-Alvo
- `[MODIFY]` `extensions/tarot-core/src/views/agentPanelView.ts`, `focusModeView.ts`
- `[MODIFY]` `extensions/tarot-core/src/agents/sessionConcurrency.ts` & `src/test/sessionConcurrency.test.ts`

### Critérios de Aceite (DoD)
- [ ] Duas sessões em worktrees distintos rodam simultaneamente sem bloqueio mútuo; cada aba exibe seu próprio estado de execução e botão Stop independente.
- [ ] **Risco a evitar (issues reportadas em Claude Code com múltiplos agentes):** terminal integrado não pode travar input ou corromper scrollback quando duas ou mais sessões concorrentes escrevem saída simultaneamente — testar explicitamente esse cenário antes de concluir o marco.

---

## M6.22 — Tab Autocomplete Inline (Ghost-Text FIM Opt-in via Ollama / Endpoint Local)

### Objetivo
Registrar `vscode.languages.registerInlineCompletionItemProvider` (desligado por padrão / 100% opt-in e privado) suportando modelos locais de Fill-in-the-Middle (Ollama `qwen2.5-coder` / `deepseek-coder` ou endpoint OpenAI-compatible configurado pelo usuário), com debounce configurável e toggle rápido na Status Bar.

### Arquivos-Alvo
- `[NEW]` `extensions/tarot-core/src/editors/fimCompletionProvider.ts`
- `[MODIFY]` `extensions/tarot-core/src/config/tarotConfig.ts`, `src/extension.ts`, `package.json`, `package.nls.json`
- `[NEW]` `extensions/tarot-core/src/test/fimCompletionProvider.test.ts`

### Critérios de Aceite (DoD)
- [ ] Opt-in via `tarot.autocomplete.enabled` (default `false`), com `CancellationToken`, debounce e validação anti-SSRF/local-only segura.

---

## M6.23 — Telemetria Local de Sessão (Tokens, Custo por Turno e Timeline de Ferramentas)

### Objetivo
Persistir e exibir no painel/inspector do chat o detalhamento local de cada turno (tokens input/output/cache, custo estimado quando reportado pelo CLI `claude`/`codex`, latência e timeline de tool calls), sem nenhuma telemetria externa.

### Arquivos-Alvo
- `[MODIFY]` `extensions/tarot-core/src/agents/types.ts`, `src/context/compactionService.ts`
- `[MODIFY]` `extensions/tarot-core/media/webview/{panel.js,panel.css,focusMode.js}`
- `[MODIFY]` `extensions/tarot-core/src/test/compactionService.test.ts`

### Critérios de Aceite (DoD)
- [ ] Tooltip/popover no anel de contexto exibe breakdown por turno (tokens, custo estimado, latência e arquivos alterados), 100% local.

---

## M6.24 — Bugbot-Style PR Review Agent (Autofix via Background Agent)

### Objetivo
Revisar automaticamente Pull Requests (locais via `gitReviewService.ts` ou remotos via `gh`) apontando bugs, riscos de segurança e qualidade, com um botão **`✦ Autofix`** que dispara um agente BYOA em background (`M6.21`) para corrigir e atualizar o PR.

### Arquivos-Alvo
- `[NEW]` `extensions/tarot-core/src/review/prReviewAgent.ts`
- `[MODIFY]` `extensions/tarot-core/src/git/gitReviewService.ts`, `src/specs/evidenceSummary.ts` (`M6.16b`)
- `[MODIFY]` `extensions/tarot-core/src/views/agentPanelView.ts` & `media/webview/{panel.js,panel.css}`
- `[NEW]` `extensions/tarot-core/src/test/prReviewAgent.test.ts`

### Critérios de Aceite (DoD)
- [ ] Gera relatório estruturado (bug/segurança/qualidade, severidade, arquivo:linha) a partir do diff do PR local ou remoto, reaproveitando `diffHunkEngine.ts` (`M6.1`).
- [ ] Botão **`✦ Autofix`** abre sessão em background (`M6.21`) com prompt focado no finding e aplica o fix via Diff Review (`M6.1`) antes de atualizar o PR.
- [ ] Respeita Workspace Trust e nunca executa `gh` ou `git push` sem confirmação explícita do usuário.

---

## M6.25 — Background Agents via Gatilho Externo (`@tarot` em GitHub/Slack/Linear)

### Objetivo
Permitir disparar uma sessão de agente BYOA em background a partir de uma menção `@tarot` em um comentário de Issue/PR do GitHub (via webhook local ou `gh` polling) ou de integrações equivalentes, executando em worktree isolado (`M6.21`) e devolvendo o resultado como comentário/PR.

### Arquivos-Alvo
- `[NEW]` `extensions/tarot-core/src/integrations/externalTriggerListener.ts`
- `[MODIFY]` `extensions/tarot-core/src/agents/sessionConcurrency.ts` (`M6.21`), `src/permissions/permissionsService.ts`
- `[NEW]` `extensions/tarot-core/src/test/externalTriggerListener.test.ts`

### Critérios de Aceite (DoD)
- [ ] Gatilho externo só é aceito com Workspace Trust ativo e política de permissões explícita (`deny` por padrão até configuração manual).
- [ ] Sessão roda em worktree isolado sem bloquear sessões locais ativas; resultado é publicado de volta (comentário/PR) somente após confirmação do usuário, nunca automaticamente em repositórios remotos.

---

## M6.26 — Automations por Evento de Git/PR (`on: push, pull_request`)

### Objetivo
Estender o motor de Hooks (`M6.5`) para suportar gatilhos declarativos em eventos de Git/PR (`on: push`, `on: pull_request`, `on: pre-commit`), complementando os triggers locais já existentes (`PostFileSave`, `SubagentStop`).

### Arquivos-Alvo
- `[MODIFY]` `extensions/tarot-core/src/hooks/{hookTypes.ts,hookEngine.ts,hookRunner.ts}`
- `[MODIFY]` `extensions/tarot-core/src/git/gitReviewService.ts`
- `[MODIFY]` `extensions/tarot-core/src/test/hookEngine.test.ts`

### Critérios de Aceite (DoD)
- [ ] Novos triggers `on: push` / `on: pull_request` / `on: pre-commit` suportados no schema `v1` e no editor visual de Hooks, disparando apenas em repositórios Git confiáveis (`vscode.workspace.isTrusted`).

---

## M6.27 — MCP Marketplace Interno de Workspace/Time

### Objetivo
Permitir que um time publique uma lista curada de servidores MCP aprovados em `.tarot/settings/mcp-catalog.json` (versionado no repo), com instalação opt-in por desenvolvedor — sem depender de nenhum marketplace externo (mantendo a invariante de privacidade da Seção 2c do `AGENTS.md`).

### Arquivos-Alvo
- `[MODIFY]` `extensions/tarot-core/src/mcp/mcpConfigService.ts`
- `[NEW]` `extensions/tarot-core/src/mcp/mcpCatalogService.ts`
- `[NEW]` `extensions/tarot-core/src/test/mcpCatalogService.test.ts`

### Critérios de Aceite (DoD)
- [ ] Catálogo lido apenas de `.tarot/settings/mcp-catalog.json` do próprio workspace (nunca de URL remota de terceiros); instalação sempre opt-in e por servidor individual.

---

## M6.28 — Sign-In OAuth Diferido para MCP (Non-Blocking Auth)

### Objetivo
Permitir adicionar um servidor MCP que requer OAuth sem bloquear a sessão corrente: o servidor fica listado como **`⏳ Pending Sign-In`** até o fluxo de autenticação completar em background, sem travar o chat nem outros MCPs já conectados.

### Arquivos-Alvo
- `[MODIFY]` `extensions/tarot-core/src/mcp/mcpConfigService.ts`
- `[MODIFY]` `extensions/tarot-core/src/views/visualConfigEditors.ts`
- `[NEW]` `extensions/tarot-core/src/test/mcpConfigService.test.ts`

### Critérios de Aceite (DoD)
- [ ] Conectar um MCP com OAuth pendente não bloqueia o uso de outros MCPs/sessões; status visível na sidebar de MCP até a autenticação concluir ou expirar.
- [ ] Nenhum token OAuth é logado ou persistido em texto puro em `.tarot/` ou OutputChannels (reforça invariante 2d do `AGENTS.md`).

---

## M6.29 — Memória Persistente por Sub-Agente (Formato Steering)

### Objetivo
Permitir que cada perfil de sub-agente (`subagentManager.ts`) mantenha memória própria entre execuções, persistida no formato de Steering (`.tarot/steering/subagents/<profile>.md`), para reter decisões/aprendizados específicos daquele papel sem poluir a memória geral do projeto.

### Arquivos-Alvo
- `[MODIFY]` `extensions/tarot-core/src/agents/subagentManager.ts`
- `[MODIFY]` `extensions/tarot-core/src/steering/steeringService.ts`
- `[MODIFY]` `extensions/tarot-core/src/test/subagentManager.test.ts`

### Critérios de Aceite (DoD)
- [ ] Sub-agente lê e atualiza seu arquivo de memória em `.tarot/steering/subagents/<profile>.md` entre execuções, respeitando Workspace Trust e o mesmo pipeline de parsing de `steeringService.ts`.
- [ ] Memória por sub-agente nunca é injetada em sessões de outro perfil sem solicitação explícita.

---

## M6.30 — Resumo Automático de Sessão sem Gatilho Manual

### Objetivo
Disparar automaticamente um resumo de sessão (reaproveitando `compactionService.ts` e o `Guided Focus` de `M6.13`) quando a janela de contexto se aproximar do limite ou a sessão ficar ociosa por um período configurável, eliminando a dependência exclusiva do `/compact` manual — sempre expondo claramente o que foi resumido/descartado (nunca silenciosamente).

### Arquivos-Alvo
- `[MODIFY]` `extensions/tarot-core/src/context/compactionService.ts`
- `[MODIFY]` `extensions/tarot-core/src/views/agentPanelView.ts`
- `[MODIFY]` `extensions/tarot-core/src/test/compactionService.test.ts`

### Critérios de Aceite (DoD)
- [ ] Resumo automático dispara antes do limite de contexto ser atingido, com card explícito **`Auto-Summarized — ver detalhes`** mostrando o que foi preservado e o que foi condensado.
- [ ] Comportamento configurável (threshold e on/off) e nunca executa silenciosamente sem indicação visual no chat.

---

## M6.31 — Sincronização de Estado de Sessão entre Múltiplas Janelas

### Objetivo
Sincronizar o estado de sessões ativas (histórico, fila de prompts `M6.12`, status de execução) entre múltiplas janelas do Tarot abertas para o mesmo workspace, evitando divergência quando o usuário alterna entre janelas.

### Arquivos-Alvo
- `[MODIFY]` `extensions/tarot-core/src/sessions/sessionStore.ts`
- `[MODIFY]` `extensions/tarot-core/src/views/agentPanelView.ts`
- `[NEW]` `extensions/tarot-core/src/test/sessionStoreSync.test.ts`

### Critérios de Aceite (DoD)
- [ ] Editar/enviar prompt em uma janela reflete em até 1s no estado de qualquer outra janela aberta no mesmo workspace, sem duplicar execução do agente.

---

## M6.32 — Output Styles — Personas de Resposta Reutilizáveis

### Objetivo
Suportar estilos de saída nomeados e intercambiáveis (ex.: `concise`, `teaching`, `strict-tdd`) definidos em `.tarot/steering/output-styles/*.md`, selecionáveis via `/comando` (`M6.2`) e aplicáveis sem alterar o comportamento central do agente (equivalente ao `keep-coding-instructions` do Claude Code).

### Arquivos-Alvo
- `[MODIFY]` `extensions/tarot-core/src/steering/steeringService.ts`
- `[MODIFY]` `extensions/tarot-core/src/commands/slashCommandRegistry.ts` (`M6.2`)
- `[NEW]` `extensions/tarot-core/src/test/outputStyles.test.ts`

### Critérios de Aceite (DoD)
- [ ] `/output-style <nome>` troca o estilo ativo da sessão sem precisar reiniciar o chat; estilo persistido por sessão.
- [ ] Estilos vivem em `.tarot/steering/output-styles/` e seguem o mesmo pipeline de parsing/precedência de `steeringService.ts`.

---

## M6.33 — Safe Mode (Boot de Emergência sem AGENTS.md/Hooks/MCP/Skills)

### Objetivo
Adicionar um modo de diagnóstico (`tarot.safeMode` via Command Palette ou flag de ambiente) que desliga de uma vez carregamento de `AGENTS.md`/Steering, Hooks, MCP e Skills para isolar problemas de configuração ou suspeita de conteúdo malicioso em `.tarot/`.

### Arquivos-Alvo
- `[MODIFY]` `extensions/tarot-core/src/extension.ts`
- `[MODIFY]` `extensions/tarot-core/src/permissions/permissionsService.ts`
- `[NEW]` `extensions/tarot-core/src/test/safeMode.test.ts`

### Critérios de Aceite (DoD)
- [ ] Com Safe Mode ativo, nenhum arquivo de `.tarot/` (hooks, steering, mcp, skills) é lido ou executado; indicador persistente na Status Bar enquanto ativo.
- [ ] Sair do Safe Mode exige ação explícita do usuário (nunca reativa automaticamente o carregamento sem confirmação).

---

## M6.34 — Modo Acessibilidade (Plain-Text / Screen Reader) no Painel Agêntico

### Objetivo
Oferecer um modo de renderização opt-in do Painel Agêntico e Focus Mode otimizado para leitores de tela: saída em texto plano estruturado (sem depender de layout visual/CSS para transmitir significado), navegável via teclado e com `aria-live` nas atualizações de streaming.

### Arquivos-Alvo
- `[MODIFY]` `extensions/tarot-core/src/views/{agentPanelView.ts,focusModeView.ts}`
- `[MODIFY]` `extensions/tarot-core/media/webview/{panel.js,panel.css,focusMode.js}`
- `[NEW]` `extensions/tarot-core/src/test/accessibilityMode.test.ts`

### Critérios de Aceite (DoD)
- [ ] Toggle `tarot.accessibility.plainTextMode` (default `false`) renderiza mensagens/diffs em texto plano com `aria-live="polite"` nas atualizações de streaming.
- [ ] Navegação completa por teclado (sem mouse) entre mensagens, diffs e ações do chat quando o modo está ativo.

---

## Comandos de Verificação Padrão (Todos os Marcos)

```bash
pnpm exec gulp compile-extension:tarot-core
node --test "extensions/tarot-core/out/test/**/*.test.js"
node extensions/tarot-core/esbuild.mts
! rg -n "innerHTML|shell:\s*true" extensions/tarot-core/src extensions/tarot-core/media
```
