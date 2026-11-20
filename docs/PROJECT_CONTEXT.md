# Tarot IDE — Contexto, Stack, Regras e Casos de Uso

> **Fonte única de verdade (Single Source of Truth)** para engenheiros e agentes de IA (`claude-code`, `codex`, `agy`, etc.) que atuam no desenvolvimento do **Tarot IDE**.
> Leia este documento, `docs/KIRO_ARCHITECTURE_REFERENCE.md` (paridade oficial com o Kiro IDE) e `docs/MIGRATION_PLAN.md` antes de planejar ou alterar qualquer arquivo do repositório.

---

## 1. Visão do Produto & Identidade

O **Tarot IDE** é uma IDE **100% agêntica**, inspirada no **layout e workflow do Kiro IDE** (*Spec-Driven Development*, *Agent Steering*, *Agent Hooks* e *Painel Agêntico Dedicado*), construída sobre o núcleo open-source do Visual Studio Code (`microsoft/vscode` / Code - OSS) e Electron.

**Diferencial central (BYOA — Bring Your Own Agents):**
Em vez de amarrar o usuário a um único modelo proprietário em nuvem ou ao GitHub Copilot, o Tarot IDE **detecta e orquestra diretamente as ferramentas agênticas de IA já instaladas na máquina do usuário** — com suporte nativo inicial a **`claude-code`** (`claude`), **`codex`** (`codex`) e **`agy`** (`agy`).

| Propriedade | Valor configurado |
| --- | --- |
| **Nome do Produto (`nameShort` / `nameLong`)** | `Tarot IDE` |
| **Binário / CLI (`applicationName`)** | `tarot` |
| **Protocolo de URL (`urlProtocol`)** | `tarot://` |
| **Diretório de Dados do Usuário** | `.tarot-ide` (`~/.tarot-ide`) / compartilhado: `.tarot-ide-shared` |
| **Diretório de Artefatos do Workspace** | `.tarot/` (`specs/`, `steering/`, `hooks/`, `workflows/`, `sessions/`, `checkpoints/`, `settings/mcp.json`) + `AGENTS.md` na raiz *(permissões de workspace ficam fora do repo em `~/.tarot-ide/workspace-roots/<hash>/permissions.yaml`)* |
| **Servidor / Túnel** | `tarot-server` (`.tarot-ide-server`) / `tarot-tunnel` |
| **Bundle IDs** | macOS: `com.tarot.ide` · Linux: `com.tarot.ide` (`tarot-ide`) · Windows: `Tarot.TarotIDE` |
| **Marketplace de Extensões** | **Open VSX Registry** (`https://open-vsx.org/vscode/gallery`) |
| **Tema Padrão** | **Tarot Arcana Dark** (`#0A0A16` / `#1D1135` / `#4B0082` / `#D4AF37` / `#4FD1C5`) |
| **Tema de Ícones Padrão** | **Tarot Arcana Icons** (`tarot-arcana-icons` — 46 SVGs de pastas e arquivos) |
| **Repositório Oficial (`origin`)** | `https://github.com/petrolal/tarot-ide.git` |
| **Licença & Copyright** | **GNU GPL v3.0** (`LICENSE` / `LICENSE.txt`) · **Copyright (c) 2026 Lucas Petrola** (`NOTICE.md`, atribuição obrigatória em forks + suporte a dual-licensing comercial; MIT do upstream preservada em `LICENSE-VSCODE-MIT.txt`) |
| **Copilot / Telemetria Microsoft** | **Desativados** (`enableTelemetry: false`, sem `defaultChatAgent`, `--disable-extension=GitHub.copilot-chat`) |

---

## 2. Stack Técnica

### 2.1 Base & Runtime
| Camada | Tecnologia / Versão | Notas |
| --- | --- | --- |
| **Core Editor** | `microsoft/vscode` (`Code - OSS`) `1.148.0` | Commit upstream base: `6cb9b401f8e7209fecb7ffe4d45dcb490e5dbb87` |
| **Shell Desktop** | **Electron `43.8.10`** | Configurado em `package.json -> nativeBuild.target` |
| **Node.js** | **Node `24.22.x`** (`.nvmrc`: `24.22.1`) | Validado em `build/npm/preinstall.ts` |
| **Gerenciador de Pacotes** | **`pnpm@12.16.0`** | **Obrigatório.** `npm install` é bloqueado pelo `preinstall.ts`. |
| **Linguagem Principal** | **TypeScript** (`strict: true`, `ES2024`) | `extensions/tsconfig.base.json` (`noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`) |
| **Build & Bundling** | `build/next/index.ts` (transpile), `gulp`, `esbuild` | `extensions/tarot-core/esbuild.mts` gera bundle de produção (`dist/extension.js`) |
| **UI de Extensões** | VS Code Extension API (`src/vscode-dts/vscode.d.ts`), `WebviewView`, `TreeView`, `DiffEditor` | Estilização aderente aos CSS tokens `--vscode-*` / paleta Arcana |
| **Orquestração de Agentes Locais** | `node:child_process`, `node-pty` / streams NDJSON, `FileSystemWatcher`, MCP | Sem acoplamento a SDK proprietário de um único fornecedor |
| **Toolchain Linux (Ubuntu 24.04)** | `git`, `python3`, `build-essential`, `pkg-config`, `libx11-dev`, `libxkbfile-dev`, `libsecret-1-dev`, `libkrb5-dev` | Obrigatórios para compilação de módulos nativos |

### 2.2 Runtimes Agênticos Locais Alvo (BYOA)
| Agente | Binário esperado no `PATH` | Papel no Tarot IDE |
| --- | --- | --- |
| **Claude Code** | `claude` | Execução agêntica (edição, terminal, planejamento, modo headless/JSON stream) |
| **OpenAI Codex CLI** | `codex` | Execução agêntica local via CLI / modo não-interativo |
| **Antigravity CLI (`agy`)** | `agy` | Execução agêntica local via CLI / workflows |
| **Extensível (Custom)** | Configurável em `tarot.agents.custom` | Permite ao usuário registrar qualquer outro CLI agêntico compatível |

---

## 3. Regras e Guardrails do Projeto (Obrigatório para Agentes)

### 3.1 Regras Arquiteturais (Extension-First)
1. **Regra de Ouro (90%+ em `extensions/tarot-core/`)**: toda nova feature do Tarot IDE (Painel Agêntico, Specs, Hooks, Steering, detectores/adaptadores de CLIs, comandos, configurações `tarot.*`) **DEVE** ser implementada dentro de `extensions/tarot-core/` (ou extensões irmãs `extensions/tarot-*`).
2. **Núcleo (`src/vs/`) sob restrição estrita**: só modificar `src/vs/` quando for tecnicamente impossível via Extension API (ex.: layout default do workbench ou guards de remoção do Copilot). Toda alteração em `src/vs/` deve ter o menor diff possível e ser imediatamente registrada na Seção 5 deste documento e na matriz de conflitos de `docs/MIGRATION_PLAN.md`.
3. **Nunca deletar `extensions/copilot/` do Git**: o Copilot é desativado via `product.json` + `--disable-extension=GitHub.copilot-chat` + `excludedExtensions`. Deletar a pasta quebraria `pnpm-lock.yaml` e criaria conflitos massivos em merges com `upstream`.
4. **Nunca fazer find-and-replace global de "VS Code" em `src/vs/` ou `extensions/*/package.nls.json`**: o rebranding de textos da UI do core já é feito de forma centralizada e segura em `src/vs/nls.ts` (`_rebrandMessage`).

### 3.2 Regras de Git e Versionamento
5. **Branch de desenvolvimento**: trabalhar sempre em `tarot-main` (ou feature branches criadas a partir dela). **Nunca** commitar na branch `main` (reservada exclusivamente para espelhar `upstream/main`).
6. **Commits atômicos e verificados**: antes de commitar, validar JSON/XML modificados, rodar `pnpm exec gulp compile-extension:tarot-core` e, se tocou em `src/vs/`, rodar `node build/next/index.ts transpile` e `pnpm run typecheck-client`.
7. **Manter docs sincronizadas**: qualquer novo arquivo em `src/vs/`, novo script em `package.json`, ou entrega de marco da Fase 3/4 deve atualizar `docs/PROJECT_CONTEXT.md` e `docs/MIGRATION_PLAN.md` no mesmo ciclo.

### 3.3 Regras de Privacidade, Segurança e Execução de Agentes
8. **Telemetria zero da Microsoft**: nunca reintroduzir `enableTelemetry: true`, `aiConfig`, `tasConfig`, `defaultChatAgent` ou endpoints proprietários Microsoft no `product.json`.
9. **Marketplace livre**: manter `extensionsGallery` apontando exclusivamente para o **Open VSX Registry**.
10. **Segurança na orquestração de CLIs locais**:
    - Executar sempre com `spawn(binary, args, { shell: false })` (nunca concatenar prompts do usuário em strings de shell).
    - Nunca logar ou persistir tokens/credenciais do usuário em `.tarot/` ou OutputChannels.
    - Respeitar *Workspace Trust* (`vscode.workspace.isTrusted`) antes de disparar Agent Hooks automáticos ou comandos de escrita no disco.
    - Em Webviews, aplicar CSP estrita (`nonce`), nunca usar `innerHTML` com conteúdo não sanitizado de saída de LLMs/CLIs.

### 3.4 Regras de Build e Validação
11. **Usar sempre `pnpm`** (nunca `npm`). Preferir os scripts leves `pnpm run watch-tarot`, `pnpm run watch-tarot-fast`, `pnpm run watch-tarot-core` e `pnpm run compile-tarot`.
12. **`tarot-core` não vai em `product.json -> builtInExtensions`**: aquele campo é apenas para extensões externas baixadas via GitHub/Marketplace; extensões locais em `extensions/` são registradas em `build/gulpfile.extensions.ts`, `pnpm-workspace.yaml` e `build/npm/dirs.ts`.
13. **Workspace Trust amplo**: nada em `.tarot/` (agents, steering, skills, MCP, workflows, hooks) é carregado/executado em workspace não confiável; permissões do workspace ficam **fora do repositório** e o agente nunca escreve nos próprios arquivos de permissões/settings (ver M3.8a).

### 3.5 Regras de Idioma e Localização

14. **Divisão de idioma (decidido)**: o *chrome* da UI (títulos de comando, mensagens de aviso/erro, placeholders, tooltips, rótulos de TreeView, texto do painel agêntico) é **em Inglês** e **sempre externalizado** com `vscode.l10n.t()`; já os **prompts enviados aos agentes** e os **templates de documentos gerados** (`.tarot/specs/**`, `.tarot/steering/**`, hooks criados por `tarot.hooks.create`) permanecem **em PT-BR**. Docs em PT-BR; identificadores e comentários técnicos em Inglês (ver `AGENTS.md` §2e).
15. **Mecanismo único**: use `vscode.l10n.t()` (e `package.nls.json` para strings de manifesto) — convenção das extensões built-in deste repositório. **Não** introduza `vscode-nls`.
16. **Webviews**: o host renderiza o HTML estático com o catálogo de `views/panelStrings.ts` e injeta o mesmo catálogo na webview como `window.__tarotL10n` (dentro de `<script nonce="...">`, com `<` escapado). `media/webview/panel.js` consome esse catálogo via helper `t(key, ...args)` — nunca duplique literais de UI no JS.
17. **Traduções (`l10n/bundle.l10n.<locale>.json`)**: deliberadamente **não** versionadas ainda. `vscode.l10n.t()` faz fallback para a mensagem-fonte (Inglês), que é o idioma padrão escolhido; a extração/geração de bundles fica para a Fase 4 (empacotamento), junto da decisão de publicar locales adicionais.

---

## 4. Casos de Uso Principais (Workflow Kiro + BYOA)

### UC-01 — Descoberta e Configuração de Agentes Locais
- **Ator**: Desenvolvedor abrindo o Tarot IDE.
- **Fluxo**: Ao ativar `tarot-core`, o `AgentRuntimeManager` escaneia o `PATH` (e caminhos configurados em `tarot.agents.*`) para detectar `claude`, `codex` e `agy`, consultando disponibilidade e versão (`--version`).
- **Resultado**: A view **Agents** exibe os motores disponíveis (verde = pronto, cinza = não instalado com instrução rápida) e permite definir o agente padrão global ou por sessão.

### UC-02 — Vibe Mode, Context Providers (`#`), Autonomia e Checkpoints
- **Ator**: Desenvolvedor querendo implementar, depurar ou revisar código rapidamente.
- **Fluxo**: No **Painel Agêntico** (Secondary Side Bar, à direita — layout Kiro), o usuário escolhe o agente (`claude`, `agy` ou `codex`), alterna entre **Vibe / Spec / Plan (`Shift+Tab`)**, define o modo de permissão (**Supervised / Accept file changes / Approve for me**, com o switch *Autopilot* como atalho para *Accept file changes*), digita `#` para empilhar provedores de contexto (`#File`, `#Folder`, `#Problems`, `#Terminal`, `#Git Diff`, `#Codebase`, `#Steering`, `#Spec`, `#MCP`) e envia com `Enter` (`Shift+Enter` quebra linha).
- **Resultado**: O adaptador executa o CLI local com contexto + Steering, transmite a resposta em tempo real e registra **Checkpoints** automáticos por turno permitindo rollback de arquivos em 1 clique preservando o histórico do chat.

### UC-03 — Spec-Driven Development (Feature & Bugfix Specs com Notação EARS)
- **Ator**: Desenvolvedor iniciando uma feature complexa ou corrigindo um bug crítico.
- **Fluxo**:
  1. **Feature Spec** (*Requirements-First* ou *Design-First*): gera `.tarot/specs/<slug>/requirements.md` em notação **EARS** (`WHEN ... THE SYSTEM SHALL ...`) ↔ `design.md` (arquitetura + propriedades de corretude/PBT) → `tasks.md` (checklist sequenciada).
  2. **Bugfix Spec**: gera `.tarot/specs/<slug>/bugfix.md` com 3 blocos EARS (*Current Behavior*, *Expected Behavior*, *Unchanged Behavior* para prevenir regressões) → `design.md` (causa raiz) → `tasks.md`.
  3. Usuário aprova cada transição e executa tarefas individualmente via CodeLens **"Run Task"** escolhendo qual agente local (`claude`, `agy`, `codex`) executa cada item.
- **Resultado**: Execução rastreável, auditável e versionada em Markdown dentro do próprio repositório.

### UC-04 — Agent Steering (`.tarot/steering/*.md`, `~/.tarot/steering/` e `AGENTS.md`)
- **Ator**: Time ou dev mantendo padrões consistentes entre diferentes agentes.
- **Fluxo**: Geração automática dos 3 arquivos fundacionais (`product.md`, `tech.md`, `structure.md`), suporte a `AGENTS.md` na raiz e 4 modos de inclusão via frontmatter (`always`, `fileMatch`, `auto`, `manual`).
- **Resultado**: Todos os agentes locais (`claude`, `agy`, `codex`) obedecem às mesmas regras do projeto com mínima poluição da janela de contexto.

### UC-05 — Agent Hooks v1 (`.tarot/hooks/*.json` e `~/.tarot/hooks/*.json`)
- **Ator**: Desenvolvedor automatizando lint, testes, revisões ou geração de boilerplate por eventos.
- **Fluxo**: Hooks no schema `v1` suportam gatilhos de arquivo (`PostFileCreate`, `PostFileSave`, `PostFileDelete` com regex `matcher`), ferramenta (`PreToolUse`, `PostToolUse`, `PermissionRequest`), prompt/turno (`PromptSubmit`, `Stop`/`AgentStop`), ciclo de vida (`SessionStart`, `SessionEnd`, `Pre/PostCompaction`, `Pre/PostTaskExecution`) e presets determinísticos (*secret scan*, lint/typecheck), executando comandos shell (`type: "command"`) ou prompts em agentes (`type: "agent"`). Execuções sob demanda manuais usam steering `manual` via `/nome`.
- **Resultado**: Automações determinísticas e agênticas respeitando `vscode.workspace.isTrusted` e a política externa de `permissions.yaml`.

### UC-06 — Troca Dinâmica de Motor / Handoff + MCP / Powers
- **Ator**: Desenvolvedor que planeja uma Spec com `claude`, executa tarefas com `agy`/`codex` e conecta ferramentas externas sem estourar tokens.
- **Fluxo**: Estado padronizado em `.tarot/` (agnóstico de fornecedor), múltiplas sessões em abas no painel direito, configuração MCP hierárquica (`.tarot/settings/mcp.json` + `~/.tarot/settings/mcp.json`) e **Powers** sob demanda ativados por palavras-chave.

### UC-07 — Workflows & Recipes Multi-Agente (`.tarot/workflows/*.yaml`)
- **Ator**: Desenvolvedor executando pipelines determinísticos de engenharia (ex.: `feature-pipeline`, `investigate`, `semantic-review-multi-model`, `publish-pr`).
- **Fluxo**: Seleciona uma Recipe na view **Workflows** (com etapas encadeadas, `loop`, `parallel` e `validate-gate`), acompanhando cada passo em um painel visual no editor central (com status `Running · step X of Y` e aprovação humana nos gates). Cada etapa pode rodar em um agente local diferente (`claude` para design, `agy` para implementação, `codex` para review de segurança).

### UC-08 — Extensões Livres via Open VSX
- **Ator**: Desenvolvedor instalando suporte a linguagens, linters e temas extras.
- **Fluxo**: Busca e instalação transparentes na view Extensions conectada ao Open VSX Registry, sem dependência do Marketplace da Microsoft.

### UC-09 — Skills, Custom Agents e Sub-agentes
- **Ator**: Dev/time que quer especializar o comportamento por tarefa sem inflar o contexto.
- **Fluxo**: skills em `.tarot/skills/` (progressive disclosure, `/nome`), agentes customizados em `.tarot/agents/` selecionáveis no composer, sub-agentes com contexto isolado herdando a política de permissões do pai (a mais estrita vence) e Powers ativados por keyword.

### UC-10 — Permissões, Modos de Aprovação e Workspace Trust
- **Ator**: Dev que quer controlar o que os agentes locais podem fazer.
- **Fluxo**: `permissions.yaml` (capabilities × efeitos `deny > ask > allow > evaluate`), modos *Supervised / Accept file changes / Approve for me*, workspace permissions fora do repo e carregamento de `.tarot/` (agentes, steering, skills, MCP, workflows, hooks) somente em workspace confiável. Regras traduzidas para flags nativas dos CLIs; o que não puder ser imposto é sinalizado como *advisory*.

### UC-11 — Sessões Paralelas, Agent Focus Mode e Agendamento
- **Ator**: Dev que delega trabalho em background e acompanha várias sessões.
- **Fluxo**: painel Sessions (busca, `perfil · repo`, badges *parked*), Agent Focus Mode de 3 painéis, worktree por sessão/run e, opcionalmente (M3.10), jobs cron com digest e lições aprendidas em `.tarot/steering/`.

---

## 5. Mapa de Alterações no Repositório (Diff Mínimo Auditável)

| Arquivo | Tipo | Finalidade |
| --- | --- | --- |
| `product.json` | Modificado | Rebranding completo para Tarot IDE, tema `Tarot Arcana Dark` em `onboardingThemes`, Open VSX Registry, `"enableTelemetry": false`, remoção de `defaultChatAgent`, `GitHub.copilot-chat`, `agentsTelemetryAppName` e `voiceWsUrl`. |
| `package.json` | Modificado (4 scripts) | Scripts leves sem Copilot: `compile-tarot`, `watch-tarot`, `watch-tarot-fast`, `watch-tarot-core`. |
| `scripts/code.sh` & `scripts/code.bat` | Modificados (2 linhas cada) | Passam `--disable-extension=GitHub.copilot-chat` em dev. |
| `src/vs/nls.ts` | Modificado (~15 linhas) | `_rebrandMessage` em `_format` (antes da interpolação de `args`): rebranda `"Visual Studio Code"`, `"VS Code"` e `"Code - OSS"` para `"Tarot IDE"` em toda a UI do core (inclusive Language Packs), preservando URLs, argumentos e exceções legítimas (keymaps/importação). |
| `src/vs/workbench/contrib/welcomeWalkthrough/browser/editor/vs_code_editor_walkthrough.ts` | Modificado (6 trechos) | Atualiza menções de marca no playground interativo em Markdown. |
| `src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts` & `src/vs/workbench/services/chat/common/chatEntitlementService.ts` | Modificados (5 linhas) | Define `chat.disableAIFeatures: true`, desativa `copilotCliCommand`/`titleBar.signIn`/`welcomePage.signIn` e marca `chatSetupHidden = true` quando `defaultChatAgent` está ausente, ocultando a aba nativa `Chat`, o ícone do Copilot no rodapé e o atalho `Open Chat` do watermark. |
| `src/vs/workbench/contrib/welcomeOnboarding/browser/onboardingVariationA.ts`, `src/vs/workbench/services/accounts/browser/defaultAccount.ts`, `src/vs/platform/extensionManagement/common/{extensionGalleryService,abstractExtensionManagementService}.ts`, `src/vs/workbench/contrib/extensions/browser/extensionsWorkbenchService.ts` | Modificados (guards mínimos) | Protegem acessos a `productService.defaultChatAgent` contra `undefined` no boot, conta padrão e busca/instalação/remoção no Open VSX. |
| `src/vs/workbench/services/themes/common/workbenchThemeService.ts` | Modificado (2 linhas) | Define `COLOR_THEME_DARK = 'Tarot Arcana Dark'` e `FILE_ICON_THEME = 'tarot-arcana-icons'` como padrões. |
| `src/vs/workbench/browser/media/code-icon.svg`, `src/vs/sessions/browser/media/vscode-icon.svg`, `src/vs/workbench/browser/parts/editor/media/letterpress-*.svg` | Modificados | Emblema vetorial da carta Tarot IDE na titlebar, banners, Welcome, Sessions e marca d'água do editor vazio. |
| `resources/{linux,win32,darwin,server}/**` | Modificados | Ícones do SO/janela/web e manifestos (`code.desktop`, `code.appdata.xml`, `VisualElementsManifest.xml`, `manifest.json`). |
| `resources/tarot/**` | Novo | Assets mestres de marca (`logo.png`, `splash.png`, ícones 64..1024px). |
| `build/gulpfile.extensions.ts`, `pnpm-workspace.yaml`, `build/npm/dirs.ts` | Modificados (1 linha cada) | Registro nativo da extensão built-in `extensions/tarot-core`. |
| `extensions/tarot-core/**` | Novo | Extensão built-in central do Tarot IDE (tema, ícones, walkthrough e futura engine agêntica Kiro/BYOA). |
| `LICENSE`, `LICENSE.txt`, `LICENSE-VSCODE-MIT.txt`, `NOTICE.md` | Novo / Modificado | Licença GNU GPL v3.0 do Tarot IDE (`Copyright (c) 2026 Lucas Petrola`), atribuição obrigatória em forks (GPLv3 §7(b)), nota de dual-licensing comercial e preservação integral da MIT da Microsoft. |
| `docs/**` | Novo | Documentação de contexto (`PROJECT_CONTEXT.md`) e plano de migração (`MIGRATION_PLAN.md`). |

---

## 6. Estrutura Atual de `extensions/tarot-core/`

```text
extensions/tarot-core/
├── .vscodeignore                       # Exclusões para empacotamento de produção
├── esbuild.mts                         # Bundler de produção (gera dist/extension.js)
├── icons/
│   ├── tarot-arcana-icon-theme.json    # Tema de ícones "Tarot Arcana Icons"
│   └── svg/*.svg                       # 46 SVGs temáticos na paleta Arcana
├── media/
│   ├── icon.png                        # Ícone 128x128 da extensão Tarot Core
│   ├── logo.png                        # Logotipo "TAROT IDE — ARCANA CODE ENVIRONMENT"
│   ├── splash.png                      # Arte splash 800x600 ("Divining Clean Code...")
│   ├── tarot-activity-icon.svg         # Ícone vetorial monocromático para Activity Bar / Secondary Side Bar
│   └── webview/{panel.css,panel.js}    # UI do Painel Agêntico (CSP estrita + paleta Arcana)
├── package.json                        # Manifesto (tema, ícones, views Kiro, settings tarot.agents.*, walkthrough)
├── package.nls.json                    # Strings localizáveis
├── themes/
│   └── tarot-dark-color-theme.json     # Tema oficial "Tarot Arcana Dark" (UI + TextMate + Semantic)
├── tsconfig.json                       # Estende ../tsconfig.base.json + src/vscode-dts/vscode.d.ts
└── src/
    ├── extension.ts                    # Bootstrap, comandos tarot.*, registro das views
    ├── config/tarotConfig.ts           # Leitura tipada de configurações tarot.agents.*
    ├── agents/
    │   ├── types.ts                    # Contratos AgentAdapter, AgentStatus, AgentEvent, AgentSession, AutonomyMode
    │   ├── processRunner.ts            # Resolução segura de PATH + spawn(shell: false) + cancelamento
    │   ├── promptBuilder.ts            # Composição de prompt (modo Vibe/Spec/Plan, autonomy, steering, histórico, anexos #)
    │   ├── sessionStore.ts             # Persistência multi-sessão agnóstica em .tarot/sessions/<id>.json
    │   ├── runtimeManager.ts           # Auto-detecção (claude, agy, codex, custom) + Status Bar
    │   └── adapters/                   # claudeAdapter, agyAdapter, codexAdapter, customAdapter
    ├── context/
    │   └── contextProviders.ts         # Provedores # (#File, #Folder, #Problems, #Git Diff, #Terminal, #Codebase, #Steering, #Spec)
    ├── checkpoints/
    │   └── checkpointService.ts        # Snapshots por turno em .tarot/checkpoints/<session>/<cp>/ e rollback 1-clique
    ├── steering/
    │   └── steeringService.ts          # Descoberta hierárquica (AGENTS.md, ~/.tarot/steering, .tarot/steering) + 4 modos de inclusão
    ├── specs/
    │   ├── specService.ts              # Feature (Requirements/Design-First EARS) & Bugfix (bugfix.md) + prompts de fase/tarefa
    │   ├── taskParser.ts               # Parser e atualização automática de checklists `- [ ]`/`- [x]` em tasks.md
    │   └── taskCodeLensProvider.ts     # CodeLens ▶ Run Task / ▶ Run Task with... em .tarot/specs/*/tasks.md
    ├── git/
    │   └── gitReviewService.ts         # Review Queue (git status/diff --numstat, HEAD diff, revert) + AI Commit Message (✦)
    └── views/
        ├── tarotSidebarViews.ts        # 4 TreeViews esquerda (Specs Feature/Bugfix, Hooks, Steering agrupado, Local Agents)
        ├── panelStrings.ts             # Catálogo de strings do painel (l10n.t) compartilhado host ↔ webview
        └── agentPanelView.ts           # WebviewView Kiro na Secondary Side Bar + ponte postMessage ↔ media/webview/panel.js
```

> **Contrato Webview ↔ Extension Host**: toda troca de estado e ações do `Tarot Agent` passa pelo protocolo `postMessage` centralizado em `src/views/agentPanelView.ts` (handler `_handleMessage` + `_postState`) e `media/webview/panel.js` (`window.addEventListener('message', ...)`). O catálogo de strings viaja no HTML inicial em `window.__tarotL10n` (ver §3.5).

---

## 7. Comandos do Dia a Dia & Troubleshooting

```bash
# Instalar/atualizar dependências (sempre pnpm)
pnpm install

# Watch completo do Tarot IDE (SEM Copilot — recomendado)
pnpm run watch-tarot

# Watch rápido (transpile + extensões, sem typecheck contínuo do core)
pnpm run watch-tarot-fast

# Watch isolado da extensão tarot-core (~200ms)
pnpm run watch-tarot-core

# Validações pontuais (antes de commitar)
pnpm exec gulp compile-extension:tarot-core
node --test "extensions/tarot-core/src/test/**/*.test.ts"   # Node 24 executa .ts puro (sem importar vscode)
node build/next/index.ts transpile                          # somente se tocou em src/vs/
pnpm run typecheck-client                                   # somente se tocou em src/vs/

# Executar o Tarot IDE em modo desenvolvimento
./scripts/code.sh
```

### Troubleshooting (Ubuntu 24.04)
- **Erro `chrome-sandbox` no `./scripts/code.sh`**: com `kernel.apparmor_restrict_unprivileged_userns = 1`, o helper SUID precisa pertencer ao `root`:
  ```bash
  sudo chown root:root .build/electron/chrome-sandbox && sudo chmod 4755 .build/electron/chrome-sandbox
  ```
- **Erro `ENOSPC` no `watch`**: aumentar watchers do kernel:
  ```bash
  sudo sysctl fs.inotify.max_user_watches=524288
  ```
