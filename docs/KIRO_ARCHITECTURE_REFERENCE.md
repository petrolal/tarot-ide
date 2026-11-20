# Referência Arquitetural do Kiro IDE → Mapeamento no Tarot IDE

> Pesquisa baseada na documentação oficial do **Kiro IDE** (`kiro.dev/docs`), documentando exatamente o que o Kiro implementa por padrão e como cada recurso é adaptado no **Tarot IDE** sob o modelo **BYOA (Bring Your Own Agents: `claude`, `agy`, `codex`)**.

---

## 1. Resumo Comparativo: Kiro Default vs. Tarot IDE (BYOA)

| Pilar do Kiro IDE | Implementação Default no Kiro (`kiro.dev/docs`) | Adaptação no Tarot IDE (`extensions/tarot-core`) |
| --- | --- | --- |
| **Diretório de Workspace** | `.kiro/` (global: `~/.kiro/`) | `.tarot/` (global: `~/.tarot/`) |
| **Motor de IA** | Modelos em nuvem gerenciados pelo Kiro | **BYOA**: CLIs locais instalados na máquina (`claude`, `agy`, `codex` + `tarot.agents.custom`) |
| **Layout Default** | Chat-first na Secondary Side Bar + painel lateral Kiro (Specs, Hooks, Steering, MCP) + Status Bar com agente/sessão | Barra esquerda **Tarot** (`Specs`, `Agent Hooks`, `Agent Steering`, `Local Agents`, `MCP`) + **Tarot Agent** exclusivo na Secondary Side Bar direita (Copilot nativo oculto via `chat.disableAIFeatures: true`) |
| **Modos de Sessão** | **Vibe** (chat livre), **Spec** (estruturado) e **Plan Agent** (`Shift+Tab` / `/plan` somente-leitura) | Mesmos 3 modos, passando flags/instruções adequadas a cada CLI local (ex.: `agy --mode plan`) |
| **Autonomia** | **Modos de permissão** (IDE 1.x): **Supervised**, **Accept file changes** e **Approve for me** (o "Autopilot" 0.x foi substituído) | 3 modos no composer; o switch Autopilot vira atalho para *Accept file changes*; flags traduzidas por adaptador (ver M3.8a) |
| **Context Providers (`#`)** | `#File`, `#Folder`, `#Codebase`, `#Problems`, `#Terminal`, `#Git Diff`, `#Steering`, `#MCP` | Menu popup `#` no composer resolvendo contexto via VS Code APIs (`diagnostics`, `git`, `terminal`, `fs`) e injetando no `promptBuilder` |
| **Checkpoints** | Auto-save por turno no chat com rollback de arquivos em 1 clique preservando conversa | Snapshots leves por turno em `.tarot/checkpoints/` (ou `git stash/tree` seguro) com botão **Restore Checkpoint** em cada turno |
| **Specs** | `.kiro/specs/<slug>/` — Feature (`requirements.md` em **EARS**, `design.md`, `tasks.md`) e Bugfix (`bugfix.md` → `design.md` → `tasks.md`); fluxos *Requirements-First* e *Design-First*; *Spec Correctness* (PBT) | `.tarot/specs/<slug>/` com templates Feature & Bugfix (notação EARS), aprovação entre fases e CodeLens **Run Task** em `tasks.md` escolhendo qual CLI local executa cada item |
| **Steering** | `.kiro/steering/*.md` (`product.md`, `tech.md`, `structure.md`), `AGENTS.md` na raiz e `~/.kiro/steering/`; 4 modos de inclusão (`always`, `fileMatch`, `auto`, `manual`) | `.tarot/steering/*.md` + `AGENTS.md` + `~/.tarot/steering/`; suporte aos 4 modos de inclusão injetados em qualquer agente (`claude`, `agy`, `codex`) |
| **Agent Hooks** | `.kiro/hooks/*.json` + `~/.kiro/hooks/*.json` (schema `v1`); triggers de arquivo (`PostFile*`), ferramenta (`Pre/PostToolUse`, `PermissionRequest`), prompt/turno (`PromptSubmit`, `Stop`/`AgentStop`), ciclo de vida (`SessionStart/End`, `Pre/PostCompaction`, `Pre/PostTaskExecution`); ações `command` e `agent` | `.tarot/hooks/*.json` + `~/.tarot/hooks/*.json` compatível com o schema `v1` (respeitando `vscode.workspace.isTrusted`); sob demanda manual = steering `manual` via `/nome` |
| **MCP & Powers** | `.kiro/settings/mcp.json` + `~/.kiro/settings/mcp.json` e **Powers** (pacotes MCP + boas práticas ativados sob demanda por keywords, evitando *MCP sprawl*) | `.tarot/settings/mcp.json` + `~/.tarot/settings/mcp.json` sincronizável com os CLIs locais + catálogo leve de **Powers** sob demanda |
| **Permissões** | **Capability-Based Permissions** (`permissions.yaml`: 12 capabilities, prioridade `deny > ask > allow > evaluate`, 6 escopos, presets; workspace permissions **fora** do repo) | `~/.tarot/settings/permissions.yaml` (user) + `~/.tarot-ide/workspace-roots/<hash>/permissions.yaml` (workspace, **fora do repo**) governando Hooks, shell, MCP e flags nativas dos CLIs (*enforced* vs *advisory*) |

---

## 2. Detalhamento Técnico dos Padrões Oficiais do Kiro

### 2.1 Spec-Driven Development & Notação EARS
O Kiro transforma prompts vagos em artefatos versionados em Markdown antes de escrever código:

1. **Feature Spec** (`.tarot/specs/<slug>/`):
   - `requirements.md` — Histórias de usuário + critérios de aceite em **EARS (Easy Approach to Requirements Syntax)**:
     ```text
     WHEN [condição / evento]
     THE SYSTEM SHALL [comportamento esperado]
     ```
   - `design.md` — Arquitetura técnica, componentes, diagramas de sequência, modelos de dados e propriedades de corretude (*Property-Based Testing* / invariantes universais).
   - `tasks.md` — Lista de tarefas discretas, sequenciadas por dependência (`- [ ] 1. ...`), com execução passo a passo e rastreabilidade até o commit/PR.
   - **Duas entradas suportadas**:
     - **Requirements-First**: comportamento do usuário → `requirements.md` → `design.md` → `tasks.md`.
     - **Design-First**: restrições técnicas/arquitetura → `design.md` → `requirements.md` → `tasks.md`.

2. **Bugfix Spec** (`.tarot/specs/<slug>/`):
   - Substitui `requirements.md` por **`bugfix.md`** com 3 seções EARS obrigatórias:
     - **Current Behavior (Defect)**: `WHEN [condição] THEN the system [comportamento incorreto].`
     - **Expected Behavior (Correct)**: `WHEN [condição] THEN the system SHALL [comportamento correto].`
     - **Unchanged Behavior (Regression Prevention)**: `WHEN [condição] THEN the system SHALL CONTINUE TO [comportamento existente].`
   - Seguido por análise de causa raiz em `design.md` e plano de correção/testes em `tasks.md`.

---

### 2.2 Agent Steering & `AGENTS.md`
- **Geração automática inicial** (*Generate Project Steering Documents*): cria os 3 arquivos base em `.tarot/steering/`:
  - `product.md` (propósito, público, metas de negócio)
  - `tech.md` (stack, bibliotecas, restrições técnicas)
  - `structure.md` (layout de pastas, convenções de nomeação e imports)
- **Hierarquia de carregamento**:
  1. `AGENTS.md` na raiz do repositório (sempre incluído; manter conciso)
  2. Global `~/.tarot/steering/*.md`
  3. Workspace `.tarot/steering/*.md`
- **4 Modos de inclusão via frontmatter YAML**:
  - `inclusion: always` *(padrão se omitido)* — injetado em todos os turnos.
  - `inclusion: fileMatch` + `fileMatchPattern: "src/**/*.ts"` — injetado quando arquivos editados/anexados casam com o glob.
  - `inclusion: auto` + `description: "..."` — injetado automaticamente quando relevante para o prompt.
  - `inclusion: manual` — injetado apenas quando referenciado explicitamente no chat (`#nome-do-steering`).

---

### 2.3 Agent Hooks (Schema `v1`)
Armazenados em `.tarot/hooks/*.json` (workspace) e `~/.tarot/hooks/*.json` (global):
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
- **Gatilhos suportados**:
  - Arquivos (filtrados por regex `matcher`): `PostFileCreate`, `PostFileSave`, `PostFileDelete`
  - Guardrails, ferramenta e ciclo de vida: `PreToolUse` (exit `2` bloqueia), `PostToolUse`, `PermissionRequest`, `PromptSubmit` (`UserPromptSubmit`), `Stop`/`AgentStop`, `SessionStart`, `SessionEnd`, `PreCompaction`, `PostCompaction`, `PreTaskExecution`, `PostTaskExecution`
  - Sob demanda manual: o fluxo oficial atual usa **steering `manual`** invocado por `/nome` (hook `Manual` é legado, mantido apenas como botão Play na TreeView).
- **Ações**: `type: "command"` (STDIN JSON; `exit 0` ⇒ stdout ao contexto; `exit 2` ⇒ bloqueia/cancela) ou `type: "agent"` (envia `prompt` para `claude`, `agy` ou `codex`).

---

### 2.4 Chat Context Providers (`#`), Modos de Permissão e Checkpoints
- **Menu `#` empilhável no composer** (ex.: `#git diff #problems revise minhas alterações`):
  - `#File`, `#Folder`, `#Codebase`, `#Problems` (`vscode.languages.getDiagnostics`), `#Terminal`, `#Git Diff`, `#Steering`, `#Spec`, `#MCP` (ampliado em M3.8c com `#url`, `#code`, `#repository`, `#current`, `#docs`).
- **Modos de Permissão (IDE 1.x — substituem o binário Autopilot/Supervised 0.x)**:
  - **Supervised**: pausa para aprovação por turno com edições (hunks aceitar/rejeitar/discutir).
  - **Accept file changes**: aplica edições de arquivo diretamente (o switch *Autopilot* no composer atua como atalho para este modo).
  - **Approve for me**: delega aprovação com base em política/classificador (`evaluate`).
- **Checkpoints**:
  - Marcação automática a cada prompt; **Restore** reverte arquivos + contexto, **Revert** desfaz o último turno e **Fork conversation** cria nova sessão sem alterar arquivos.

---

### 2.5 MCP, Powers, Plan Subagent & Permissões (`permissions.yaml`)
- **MCP**: hierarquia `Agent Config → .tarot/settings/mcp.json → ~/.tarot/settings/mcp.json`.
- **Powers**: bundles sob demanda (*Agent Plugins*: `plugin.json` + `skills/` + `mcp.json`) ativados por palavras-chave para evitar *MCP sprawl*.
- **Plan Subagent (`Shift+Tab` ou `/plan`)**: modo somente-leitura para explorar a codebase e desenhar planos sem alterar arquivos.
- **Permissões baseadas em capacidades (`permissions.yaml`)**: 12 capabilities com prioridade **`deny > ask > allow > evaluate`** (mais restritivo vence entre escopos). **Permissões de workspace ficam fora do repositório** (`~/.tarot-ide/workspace-roots/<hash>/permissions.yaml`) e user em `~/.tarot/settings/permissions.yaml` para impedir injeção por repos clonados.

---

## 3. Especificação Visual Real (Baseada nos Prints Oficiais do Kiro IDE)

Análise pixel-a-pixel dos 7 prints oficiais do Kiro IDE (layout 3 colunas, Composer, Crew/Sessions, Workflows/Recipes e pipeline de entrega):

### 3.1 Layout Principal de 3 Colunas
- **Activity Bar (Esquerda)**: ícones padrão do editor + grupo dedicado **Tarot** (equivalente ao Kiro):
  1. **Tarot Hub** (Specs, Steering, Hooks, Local Agents, MCP)
  2. **Workflows & Recipes** (`WORKFLOW RUNS` + `RECIPES` com botão Play `▷`)
  3. **Agent Sessions / Crew** (lista pesquisável de sessões com status)
- **Editor Central**: código, Diff Editor nativo (`+X -Y`), editor de Specs e **Visualizador de Workflow Run** (mostrando etapas, badges `loop ×N`, `parallel`, `Approved`, `Running · step X of Y`).
- **Secondary Side Bar (Direita — `Tarot Agent`)**:
  - **Barra de Abas de Sessão no Topo**: `TAROT | [Sessão 1] [Sessão 2] [• Spec: ...] [+]` — múltiplas sessões concorrentes em abas horizontais com bolinha indicadora de execução/Spec e botão `+`.
  - **Transcript Estruturado**:
    - Blocos recolhíveis (*collapsible disclosures*) para pensamento e ferramentas: `> Thought complete`, `> N tool calls`, `> Ran command ... · X passed`, `> Edited file.ts`.
    - Card **Updated task list** com barra de progresso contínua (`2/2`) e itens concluídos (`✓`).
    - Rodapé do turno com **`Elapsed time: Xm Ys`**.
  - **Composer Exato do Kiro (Card Único)**:
    - **Área superior**: `<textarea>` sem borda/resize (`Ask a question or describe a task...`, `Enter` envia / `Shift+Enter` quebra linha) + **botão quadrado arredondado `↑` (ou `■` Stop)** no canto superior direito da caixa.
    - **Barra inferior interna**:
      - *Esquerda*: ícone `#` (SVG Context Providers), ícone clipe (SVG anexar arquivo), anel indicador de uso de contexto (`○` com arco teal), botão customizado **`<cli> · Auto ⌄`** (sem `<select>` nativo) abrindo o **Model & Effort Popover** (pills de CLI + lista dinâmica de modelos via `agy models`/presets + **Reasoning Effort** `Auto | Low | Med | High | XHigh | Max`).
      - *Direita*: botão customizado **`Default ⌄`** abrindo o popover de modo (`Default / Spec / Plan`, `Shift+Tab`) + label **`Autopilot`** com **toggle switch pill**.

### 3.2 Workflows & Recipes Multi-Agente (`.tarot/workflows/*.workflow.{yaml,json}`)
- **Recipes reutilizáveis** (inspiradas nas receitas nativas do Kiro: `autoresearch`, `feature-pipeline`, `goal`, `investigate`, `publish-pr`, `ralph`, `semantic-review-multi-model`):
  - Estrutura baseada nos nós reais do Kiro (`step`, `sequence`, `repeat`, `parallel`, `watch`): `repeat` suporta `maxIterations`, `onMaxIterations` (`abort` | `continue` | `pause`) e condição `stop` (`fileCheck` / `containsText` / `completionSignal`); `parallel` suporta `joinPolicy` (`all` | `allSettled` | `any`); `validate-gate` impede o agente de pular testes falhando.
  - **Vantagem exclusiva do Tarot IDE (BYOA)**: cada step pode especificar um agente local diferente (ex.: `design` em `claude`, `implement` em `agy`, `review-security` em `codex`), entregando **revisão adversarial multi-modelo** usando os CLIs já instalados na máquina.

### 3.3 Sessions & Agent Swarms (Crew)
- Lista de sessões com `Search sessions...`, agrupamento com `profile · repo` + horário, indicador de status (`Flaky tests fixed`, badge amarelo `🔒 1 sub-agent needs approval` para estado *parked*), `+ New ⌄` e `🕒 Older Sessions >`.
- Suporte a **sub-agentes** (`Spawned 1 sub-agent ...`) com herança estrita das permissões da sessão pai (prevalecendo a regra mais restritiva), contagem de reruns (`Ran ... × 20 · 3 failed / 20 passed`) e gatilhos `/command`, `@file` e `$skill` no composer Crew.

---

## 4. Validação contra a documentação oficial (leitura direta de `kiro.dev`, 19/11/2026)

> Fontes lidas por HTTP: `blog/introducing-kiro`, `crew`, `docs/specs/*` (feature, bugfix, quick-spec, analyze-requirements, correctness, best-practices), `docs/workflows/*` (overview, authoring, manage, patterns), `docs/hooks` (+ `types`, `actions`), `docs/steering`, `docs/permissions`, `docs/custom-agents` (+ `subagents`), `docs/skills`, `docs/powers`, `docs/mcp`, `docs/checkpoints`, `docs/compaction`, `docs/ide/chat`, `docs/ide/whats-new-v1`, `docs/crew/*`. A página `specs/plan-mode` não existe (404); Plan é um modo de sessão descrito em `ide/chat`.

### 4.1 Notas críticas da validação (Seções 1–3 já sincronizadas)
- **Inline chat**: **retirado** no Kiro IDE 1.x (`Ctrl+L` envia seleção ao chat atual; `Ctrl+Shift+L` abre nova sessão).
- **Recipes bundled**: a doc confirma **3** (`investigate`, `feature-pipeline`, `publish-pr`); `autoresearch`, `goal`, `ralph` e `semantic-review-multi-model` aparecem no Print 2 e são tratadas como recipes do Tarot.
- **Workflows `repeat` & `watch`**: `repeat` usa `stopCondition` (`containsText`/`completionSignal`/`fileCheck`) ou `stopWhen`, com `maxIterations` obrigatório (roda ≥ 1 vez); `watch` usa handlers `github-pr` e `command` (STDIN/STDOUT JSON + cursor persistido).
- **Kiro Crew**: **produto separado** (open source Apache-2.0, sobre Kiro CLI + ACP); a UI de Sessions dos Prints 3/4 é reaproveitada no Agent Focus Mode do IDE.

### 4.2 Specs (resumo validado)
- Superfícies: Feature, Bugfix, Quick Spec, execução paralela de tasks (todas); Analyze Requirements (IDE/CLI); **Correctness/PBT só no IDE**.
- **Feature Spec**: *Requirements-First* (Requirements → Design → Tasks) ou *Design-First* (Design → Requirements → Tasks, para brownfield, requisitos não funcionais estritos ou importação de design). EARS: `WHEN ... THE SYSTEM SHALL ...`.
- **Bugfix**: `bugfix.md` com *Current* (`WHEN ... THEN the system [incorreto]`), *Expected* (`... SHALL ...`) e *Unchanged* (`... SHALL CONTINUE TO ...`); design com causa raiz e 3 propriedades; tasks com PBTs (bug reproduz, fix funciona, sem regressão). Bugfix não vira Feature Spec diretamente.
- **Run all Tasks**: grafo de dependências → ondas; só tarefas obrigatórias e incompletas. **Optional `*`** e escolha MVP/obrigatório. **Sync Files** atualiza tasks após edição de requirements/design.
- **PBT**: propriedades extraídas dos requisitos; geração de centenas de entradas; *shrinking* para o menor contra-exemplo; PBT opcional por padrão; não é prova formal.
- **Markdown Review**: botão flutuante *Review* para comentar passagens e enviar em lote. Config para workflow padrão.

### 4.3 Workflows (resumo validado)
- Recipe = JSON/YAML (`*.workflow.{json,yaml,yml}`); nós `step | sequence | repeat | parallel | watch`; ≤ 50 steps, profundidade ≤ 8; templates `{{input}}`, `{{previous.output}}`, `{{id.output}}`, `{{artifacts.nome}}` com delimitadores anti-injeção.
- Cada step: sessão nova; agente `wf-*`/`semantic_reviewer`/custom; `modelId`/`effortLevel` por step; `send_message` (`success|warning|error|info`).
- Run: checkpoint por nó, pause cooperativo, stop sem desfazer arquivos, estados `running/paused(3)/completed/failed/aborted`, **Add loops**, revisão do plano restante, cartão de aprovação do plano, controle **Use workflows** (3 níveis), setting global de opt-in.
- UI IDE: *Workflows* acima do chat pai, aba por step/run, campo "Message this step's agent", Follow, Go to active, linhas de notificação.
- Segurança: workspace não confiável não carrega recipes; permissões da sessão pai valem para cada step; `publish-pr` não faz merge.

### 4.4 Hooks, Steering, Agentes, Skills, Powers
- **Hooks**: `PromptSubmit`, `Stop/AgentStop`, `SessionStart/End`, `Pre/PostCompaction`, `Pre/PostToolUse`, `PermissionRequest`, `FileCreate/Save/Delete`, `Pre/PostTaskExecution`; ações `command` (STDIN JSON; exit 0 ⇒ stdout ao contexto; exit 2 ⇒ bloqueia/cancela) e `agent`; `timeout` 60 s; `confirm`/`confirmCommand`; `enabled`; global + workspace juntos.
- **Steering**: `product.md`/`tech.md`/`structure.md`; modos `always|fileMatch|manual|auto`; `fileMatchPattern` com array; `#[[file:...]]`; `AGENTS.md` raiz, global e subdiretórios; manual/auto viram `/comandos`.
- **Custom agents**: `.kiro/agents/*.{json,md}` (campos `tools`, `excludedTools`, `includeMcpJson`, `includePowers`, `resources`, `permissions`, `prompt`, `model`); sub-agentes isolados, DAG imutável, review loops (`max_iterations` 1–10), permissão = mais estrita entre pai e filho.
- **Skills** (*Agent Skills*, progressive disclosure, `/nome`), **Powers** (*Agent Plugins*: `plugin.json` + `skills/` + `mcp.json`, ativação por keyword; Powers ⊃ Skills).
- **Permissões**: capabilities, efeitos, escopos, presets, parser de shell composto, invariantes (agente não escreve nas próprias permissões), workspace trust, headless ⇒ `ask` = `deny`.

### 4.5 Chat, Contexto e Sessões
- Provedores `#`: `codebase, file, folder, git diff, terminal, problems, url, code, repository, current, steering, docs, spec, mcp`.
- **Compaction** automática ~80% com resumo estruturado; **Checkpoints** por prompt (Restore = arquivos + contexto; Revert = último turno); **Fork conversation** (não toca arquivos); Export Chat; medidor de contexto; Agent Focus Mode (Sessions | Chat | Specs/Diffs); chats paralelos com aviso de conflito.

### 4.6 Crew (referência, fora do escopo do IDE)
- Bots (memória, objetivos, check-ins, dashboard), workers, schedules (cron com fuso, jitter, skip dates), webhooks, heartbeat, Apps SDK, memória/lições (formato de steering), 8 camadas de segurança, Slack/Discord/Telegram/Teams/Webex, instâncias remotas por SSH. Roda sobre Kiro CLI + ACP; skills de outros padrões abertos funcionam sem modificação.

### 4.7 Leitura dos prints
- **Print 1 (Specs)**: stepper `coupon-codes 1 Requirements > 2 Design > 3 Task list`; `tasks.md` com `✓ Task completed | ↺ View changes`, gutter verde, `_Requirements: 1.1_`, tarefa PBT com `Property 1` e `Validates`; transcript com `7 tool calls`, `Counter-example`/`Error`, cards `Replace in File`/`Write File`, regra salva em steering.
- **Print 2 (Workflows)**: `WORKFLOW RUNS` (runs com idade e sub-itens) e `RECIPES` (Global) com `▷`; aba `feature-pipeline · 6 steps · review-loop max 2 · ✓ Completed`; steps com papel (`wf-coder`, `wf-design`, `wf-design-reviewer`, `wf-planner`, `semantic_reviewer`, `wf-review-aggregator`); badges `loop ×2`, `pass 2 of 2`, `parallel`, `Approved`, `Passed`.
- **Prints 3/4 (Sessions/Crew)**: `Sessions` com busca, filtros, `+ New ⌄`; cards `perfil · repo` + hora; `🔒 1 sub-agent needs approval`; `Weekly digest · Posted to #team`; transcript com `2 steps`, `Spawned 1 sub-agent`, `Ran ... × 20 · 3 failed`, `Edited ...`; composer `(/command · @file · $skill)`.

### 4.8 Frontier Engineering (leitura direta de `kiro.dev/topics/frontier-engineering/*`)
Síntese dos 10 princípios operacionais do Kiro e como cada um se traduz em primitivas concretas no **Tarot IDE (BYOA)**:
- **Arquitetura, Direção e Código Descartável** (*Princípios 1, 5, 6*): investir em intenção clara (Specs EARS), prototipar 2 designs em paralelo quando houver dúvida e tratar implementação/testes unitários acoplados como descartáveis — preservando **testes de fronteira/contrato** (integração, E2E, PBT de invariantes) como contrato imutável em `design.md`/`tasks.md` (M3.6.6/M3.6.7).
- **Paralelismo Real & Autonomia** (*Princípio 2*): isolar sessões e ondas paralelas de tasks com **Git Worktrees gerenciados** (`git/worktreeManager.ts`, M3.6.7/M3.8c/M3.9a) para rodar agentes sem conflito de arquivos e comparar abordagens lado a lado.
- **Fast Feedback Loop & AI Reviewer Pré-PR** (*Princípios 3, 4, 7*): módulos de lógica pura testáveis em milissegundos (`node --test`, sem `vscode`), documentação de decisões como memória persistente entre sessões e ação **Pre-PR Review (BYOA)** na *Review Queue* usando um CLI diferente do autor + **Evidence Summary** (testes, lint, PBT, diff) antes da revisão humana (M3.8c/M3.9a).
- **Confiar nas Fronteiras, Não no Agente** (*Princípio 8*): além de `permissions.yaml`, presets built-in de **guardrails determinísticos** via Hooks (*secret/credential scanning*, lint/typecheck) e distinção visual entre ações reversíveis e irreversíveis nos cartões de aprovação (M3.7/M3.8a).
- **Ajuste Contínuo do Setup** (*Princípios 9, 10*): compartilhar o mesmo steering/tools em tarefas além de código e oferecer **Audit / Prune Steering** (M3.10) para podar regras/workarounds obsoletos quando o usuário troca de modelo ou CLI.
