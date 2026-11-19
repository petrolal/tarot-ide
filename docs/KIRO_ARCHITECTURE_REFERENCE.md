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
| **Autonomia** | **Autopilot** (aplica edições automaticamente) vs **Supervised** (aprovação passo a passo) | Toggle no composer controlando flags de permissão/aprovação do adaptador e revisão por diff |
| **Context Providers (`#`)** | `#File`, `#Folder`, `#Codebase`, `#Problems`, `#Terminal`, `#Git Diff`, `#Steering`, `#MCP` | Menu popup `#` no composer resolvendo contexto via VS Code APIs (`diagnostics`, `git`, `terminal`, `fs`) e injetando no `promptBuilder` |
| **Checkpoints** | Auto-save por turno no chat com rollback de arquivos em 1 clique preservando conversa | Snapshots leves por turno em `.tarot/checkpoints/` (ou `git stash/tree` seguro) com botão **Restore Checkpoint** em cada turno |
| **Specs** | `.kiro/specs/<slug>/` — Feature (`requirements.md` em **EARS**, `design.md`, `tasks.md`) e Bugfix (`bugfix.md` → `design.md` → `tasks.md`); fluxos *Requirements-First* e *Design-First*; *Spec Correctness* (PBT) | `.tarot/specs/<slug>/` com templates Feature & Bugfix (notação EARS), aprovação entre fases e CodeLens **Run Task** em `tasks.md` escolhendo qual CLI local executa cada item |
| **Steering** | `.kiro/steering/*.md` (`product.md`, `tech.md`, `structure.md`), `AGENTS.md` na raiz e `~/.kiro/steering/`; 4 modos de inclusão (`always`, `fileMatch`, `auto`, `manual`) | `.tarot/steering/*.md` + `AGENTS.md` + `~/.tarot/steering/`; suporte aos 4 modos de inclusão injetados em qualquer agente (`claude`, `agy`, `codex`) |
| **Agent Hooks** | `.kiro/hooks/*.json` + `~/.kiro/hooks/*.json` (schema `v1`); triggers `PostFileCreate`, `PostFileSave`, `PostFileDelete`, `Stop`, `SessionStart`, `SessionEnd`, `Manual`; ações `command` e `agent` | `.tarot/hooks/*.json` + `~/.tarot/hooks/*.json` compatível com o schema `v1` (respeitando `vscode.workspace.isTrusted`) |
| **MCP & Powers** | `.kiro/settings/mcp.json` + `~/.kiro/settings/mcp.json` e **Powers** (pacotes MCP + boas práticas ativados sob demanda por keywords, evitando *MCP sprawl*) | `.tarot/settings/mcp.json` + `~/.tarot/settings/mcp.json` sincronizável com os CLIs locais + catálogo leve de **Powers** sob demanda |
| **Permissões** | Evolução de `trustedCommands` (0.x) para **Capability-Based Permissions** (`permissions.yaml`: `shell`, `fs_read`, `fs_write`, `network`, `mcp` com `allow`/`deny`/`ask`/`evaluate`) | `.tarot/permissions.yaml` governando execução de Hooks, comandos shell e nível de autonomia dos agentes locais |

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
  - Ciclo de vida da sessão/agente: `Stop` (fim de turno do agente), `SessionStart`, `SessionEnd`
  - Sob demanda: `Manual` (botão *Play* na TreeView Agent Hooks)
- **Ações**: `type: "command"` (shell/linter/testes rápidos) ou `type: "agent"` (envia `prompt` para `claude`, `agy` ou `codex`).

---

### 2.4 Chat Context Providers (`#`), Autonomia e Checkpoints
- **Menu `#` empilhável no composer** (ex.: `#git diff #problems revise minhas alterações`):
  - `#File` — conteúdo de um arquivo específico do workspace
  - `#Folder` — listagem/resumo de um diretório
  - `#Codebase` — busca/índice amplo no repositório
  - `#Problems` — erros e warnings ativos do painel *Problems* (`vscode.languages.getDiagnostics`)
  - `#Terminal` — saída recente do terminal integrado
  - `#Git Diff` — diff atual (working tree / staged) via `git diff`
  - `#Steering` — arquivos de steering em modo `manual`
  - `#MCP` — recursos expostos por servidores MCP configurados
- **Autopilot vs. Supervised**:
  - **Autopilot**: aplica alterações diretamente no workspace com mínima interrupção.
  - **Supervised**: pausa para revisão/aprovação incremental antes de confirmar edições ou comandos.
- **Checkpoints**:
  - Marcação automática antes de cada turno com escrita de arquivos, permitindo **Restore Checkpoint** em 1 clique sem perder a conversa.

---

### 2.5 MCP, Powers, Plan Subagent & Permissões (`permissions.yaml`)
- **MCP**: hierarquia `Agent Config → .tarot/settings/mcp.json → ~/.tarot/settings/mcp.json`.
- **Powers**: bundles sob demanda (MCP + instruções) ativados por palavras-chave no prompt para evitar estourar a janela de contexto (*MCP sprawl*).
- **Plan Subagent (`Shift+Tab` ou `/plan`)**: modo somente-leitura para explorar a codebase e desenhar planos sem alterar arquivos.
- **Permissões baseadas em capacidades (`.tarot/permissions.yaml`)**: regras declarativas para `shell`, `fs_read`, `fs_write`, `network` e `mcp` com efeitos `allow` | `deny` | `ask`.
