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
| **Temas Padrão** | **Tarot Arcana Dark** (`#0A0A16` / `#1D1135` / `#4B0082` / `#D4AF37` / `#4FD1C5`) e **Tarot Arcana Light** (`#FAF9FD` / `#F4F1FA` / `#4B0082` / `#8F6B0A` / `#0D7377`) |
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
| **Extensível (Custom / ACP)** | Configurável em `tarot.agents.custom` ou via **ACP** (`agy acp`, etc.) | Permite descobrir e orquestrar dinamicamente qualquer CLI compatível via catálogo declarativo ou **Agent Client Protocol (ACP)** (M3.8b), sem hardcode de adaptadores por CLI |

### 2.3 Compatibilidade Desktop & Web (`tarot-server`)
| Modo de execução | O que herda do Tarot IDE | Limites |
| --- | --- | --- |
| **Desktop (Electron)** | 100% — UI, tema Arcana, ícones, Open VSX, `tarot-core` e BYOA local (`claude`, `codex`, `agy`). | Nenhum. |
| **Web remoto (`tarot-server` / `tarot-tunnel`)** | 100% — o navegador renderiza a UI (TreeViews + Webview do `Tarot Agent`) enquanto `tarot-core` roda no **Extension Host Node.js do servidor** com acesso aos CLIs BYOA, Git e `.tarot/`. | Requer `extensionKind: ["workspace"]` e assets via `webview.asWebviewUri`. |
| **Web puro (somente browser, sem backend Node)** | Identidade visual (tema Arcana, ícones, `nls.ts`), Open VSX e ocultação do Copilot/Agents Window. | **Sem BYOA local** (browser não possui `child_process.spawn` nem acesso ao `PATH`/filesystem local); agentes nesse modo dependem de adaptador remoto/ACP futuro (Fase 5). |

---

## 3. Regras e Guardrails do Projeto (Obrigatório para Agentes)

### 3.1 Regras Arquiteturais (Extension-First)
1. **Regra de Ouro (90%+ em `extensions/tarot-core/`)**: toda nova feature do Tarot IDE (Painel Agêntico, Specs, Hooks, Steering, detectores/adaptadores de CLIs, comandos, configurações `tarot.*`) **DEVE** ser implementada dentro de `extensions/tarot-core/` (ou extensões irmãs `extensions/tarot-*`).
2. **Núcleo (`src/vs/`) sob restrição estrita**: só modificar `src/vs/` quando for tecnicamente impossível via Extension API (ex.: layout default do workbench ou guards de remoção do Copilot). Toda alteração em `src/vs/` deve ter o menor diff possível e ser imediatamente registrada na Seção 5 deste documento e na matriz de conflitos de `docs/MIGRATION_PLAN.md`.
3. **Nunca deletar `extensions/copilot/`, `extensions/theme-*` nem `src/vs/sessions/` do Git**: o Copilot e a Agents Window nativa são desativados via `product.json`, flags e defaults; os temas upstream (`extensions/theme-*`) permanecem como fallbacks (High Contrast, Solarized, Monokai). Deletar essas pastas quebraria `pnpm-lock.yaml` e criaria conflitos massivos em merges com `upstream`.
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
    - Respeitar *Workspace Trust* (`vscode.workspace.isTrusted`) antes de disparar Agent Hooks automáticos ou comandos de escrita no disco (`untrustedWorkspaces: "limited"` e `virtualWorkspaces: false` em `package.json`).
    - Configurações que apontam para executáveis locais (`tarot.agents.paths.*` e `tarot.agents.custom`) usam `"scope": "machine"` para impedir que um `.vscode/settings.json` clonado injete binários arbitrários; `tarot-core` declara `"extensionKind": ["workspace"]` para compatibilidade com `tarot-server`.
    - Em Webviews, aplicar CSP estrita (`nonce`), nunca usar `innerHTML` com conteúdo não sanitizado de saída de LLMs/CLIs, e escapar HTML (`&`, `"`, `<`, `>`) ao interpolar strings localizadas `l10n.t()` em templates HTML.
    - Ao importar skills via Git URL (`skillsService.ts`), restringir hosts aceitos, rejeitar nomes de branch começando com `-` (evitando *git option injection*), usar `--` antes da URL, validar que `subpath` permanece confinado em `tmpDir`, e nunca copiar `.git/` nem nomes de pasta `.`/`..`.
    - No provedor `#url` (`contextProviders.ts`), exigir `https://`, bloquear hosts locais e IPs privados/link-local (SSRF) e impor limite de bytes durante a leitura da resposta antes de bufferizar; `#spec` também deve exigir `vscode.workspace.isTrusted` antes de ler `.tarot/specs/`.
    - Ao classificar um comando `shell` como "seguro por padrão" (ex.: `git` somente-leitura em `policyEngine.ts`), **sempre checar redirecionamento não citado (`>`, `>>`, `<`) antes de liberar** — `git show ... > arquivo` é escrita, não leitura; um allowlist que olha só o subcomando permite escrita arbitrária sob o `allow` padrão (achado e corrigido em revisão de código, 2026-11-22; ver `policyEngine.ts::hasUnquotedRedirection`).
    - Nunca montar o argv de um processo com prompt de tamanho ilimitado: todo adapter BYOA passa o prompt como argumento único de CLI, e `promptBuilder.ts` injeta conteúdo de Steering/anexos sem limite — validar o tamanho total (binário+argv) **antes** do `spawn`, com limite conservador por plataforma (bem mais estrito no Windows) em vez de deixar o SO falhar com `E2BIG`/`ENAMETOOLONG` (ver `agents/commandLineLimits.ts` + cap por seção em `promptBuilder.ts`).
    - Uma regra `allow` com `match` (preset ou regra do usuário) nunca deve casar um comando `shell` com redirecionamento não citado (`>`/`>>`/`<`) escapando do que o `match` nomeia — `cat *` não é "ler o arquivo" quando o comando é `cat secrets.env > /tmp/exfil.txt` (ver `policyEngine.ts::ruleMatchesValue`/`hasUnquotedRedirection`). Uma regra sem `match` (ex. `allow-all`) é concessão deliberada e fica fora dessa checagem.
    - A capability `fs_write` precisa estar **realmente conectada** a algo que a avalie — definir o schema/presets sem nenhum call-site de `evaluate('fs_write', ...)` no runtime é o mesmo que não ter política nenhuma para escrita de arquivos (ver `agentPanelView.ts::reviewFileWritesForTurn`, que fecha esse gap para o que o diff do checkpoint consegue enxergar; `.tarot/**` só deve ficar fora desse diff quando é bookkeeping auto-referencial do próprio Tarot — `checkpoints/`, `sessions/` — nunca o `.tarot/` inteiro, senão as invariantes que protegem `.tarot/{settings,hooks,agents,workflows,powers}/**` nunca são de fato vistas).
    - Nunca presumir que "nenhuma CLI expõe canal para negar uma tool call" sem checar `<cli> --help` primeiro: `claude` expõe `--permission-mode`/`--permission-prompt-tool` de verdade, e sem passar nada o CLI roda no seu próprio padrão (`manual`), que **nega tudo** em modo `-p` headless sem host configurado — um adapter que não traduz o autonomy mode do composer para a flag nativa do CLI não é "advisory e levemente menos rico", é **sem efeito nenhum** (achado pelo usuário na prática: agente travado pedindo aprovação numa UI que não existe nesse contexto; ver `claudeAdapter.ts` e Débitos Técnicos item 19).

### 3.4 Regras de Build e Validação
11. **Usar sempre `pnpm`** (nunca `npm`). Preferir os scripts leves `pnpm run watch-tarot`, `pnpm run watch-tarot-fast`, `pnpm run watch-tarot-core` e `pnpm run compile-tarot`.
12. **`tarot-core` não vai em `product.json -> builtInExtensions`**: aquele campo é apenas para extensões externas baixadas via GitHub/Marketplace; extensões locais em `extensions/` são registradas em `build/gulpfile.extensions.ts`, `pnpm-workspace.yaml` e `build/npm/dirs.ts`.
13. **Workspace Trust amplo**: nada em `.tarot/` (agents, steering, skills, MCP, workflows, hooks, powers) é carregado/executado em workspace não confiável; permissões do workspace ficam **fora do repositório** e o agente nunca escreve nos próprios arquivos de permissões/settings (ver M3.8a). Como defesa em profundidade (`TD-16`), os serviços puros de descoberta (`TarotHookEngine`, `TarotSkillsService`, `TarotMcpConfigService`, `TarotCustomAgentService`, `TarotRecipeLoader` e `TarotPowersService`) exigem o parâmetro explícito `trusted: boolean` na assinatura de `discover`/`discoverFiles` e ignoram o diretório do workspace quando `trusted === false` — mesmo que um call-site passe `workspaceRoot` sem gate externo. Isso inclui as TreeViews que listam esse conteúdo: `HooksTreeProvider`, `SteeringTreeProvider` (que também lista o `AGENTS.md` da raiz como Steering) e `SpecsTreeProvider` só populam depois de `vscode.workspace.isTrusted` ser verdadeiro, e atualizam (`refresh()`) ao evento `onDidGrantWorkspaceTrust` em vez de ficar travadas vazias até o próximo file-watcher disparar.

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
| `product.json` | Modificado | Rebranding completo para Tarot IDE, `Tarot Arcana Dark` + `Tarot Arcana Light` no topo de `onboardingThemes`, Open VSX Registry, `"enableTelemetry": false`, remoção de `defaultChatAgent`, `GitHub.copilot-chat`, `agentsTelemetryAppName` e `voiceWsUrl`, inclusão de `bierner.markdown-mermaid` (MIT, Open VSX) em `builtInExtensions` para preview nativo de diagramas Mermaid em Markdown/Specs, e recomendações sob demanda (`extensionRecommendations`, `configBasedExtensionTips` e `exeBasedExtensionTips` passivos sem pop-up de startup) de extensões open-source do Open VSX (Python/`basedpyright`/`ruff`, Go, Rust, clangd, Java, Docker, YAML, TOML, Vue, Svelte, Tailwind, Biome/ESLint/Prettier, Prisma, Terraform, EditorConfig). |
| `package.json` | Modificado (4 scripts) | Scripts leves sem Copilot: `compile-tarot`, `watch-tarot`, `watch-tarot-fast`, `watch-tarot-core`. |
| `scripts/code.sh` & `scripts/code.bat` | Modificados (2 linhas cada) | Passam `--disable-extension=GitHub.copilot-chat` em dev. |
| `src/vs/nls.ts` | Modificado (~15 linhas) | `_rebrandMessage` em `_format` (antes da interpolação de `args`): rebranda `"Visual Studio Code"`, `"VS Code"` e `"Code - OSS"` para `"Tarot IDE"` em toda a UI do core (inclusive Language Packs), preservando URLs, argumentos e exceções legítimas (keymaps/importação). |
| `src/vs/workbench/contrib/welcomeWalkthrough/browser/editor/vs_code_editor_walkthrough.ts` | Modificado (6 trechos) | Atualiza menções de marca no playground interativo em Markdown. |
| `src/vs/workbench/contrib/chat/browser/{chat.shared.contribution,agentSessionsConfiguration}.ts`, `src/vs/workbench/services/chat/common/chatEntitlementService.ts` & `src/vs/platform/workspaces/electron-main/workspacesHistoryMainService.ts` | Modificados (~9 linhas) | Define `chat.disableAIFeatures: true`, desativa `copilotCliCommand`/`titleBar.signIn`/`welcomePage.signIn`/`titleBar.openInAgentsWindow`/`agentsWindowBanner`/`welcomePage.agentsWindowGraphic`, marca `chatSetupHidden = true` e oculta a **Agents Window** nativa (`src/vs/sessions/`) da UI e do JumpList quando `defaultChatAgent` está ausente (substituída pelo *Agent Focus Mode* do `tarot-core` em M3.9c). |
| `src/vs/workbench/contrib/welcomeOnboarding/browser/onboardingVariationA.ts`, `src/vs/workbench/services/accounts/browser/defaultAccount.ts`, `src/vs/platform/extensionManagement/common/{extensionGalleryService,abstractExtensionManagementService}.ts`, `src/vs/workbench/contrib/extensions/browser/extensionsWorkbenchService.ts` | Modificados (guards mínimos) | Protegem acessos a `productService.defaultChatAgent` contra `undefined` no boot, conta padrão e busca/instalação/remoção no Open VSX. |
| `src/vs/workbench/services/themes/common/{workbenchThemeService,themeExtensionPoints}.ts` | Modificados (~14 linhas) | Define `Tarot Arcana Dark` / `Tarot Arcana Light` e `tarot-arcana-icons` como padrões (preservando `Default High Contrast` / `Default High Contrast Light` para acessibilidade HC) e filtra demais extensões built-in `vscode.theme-*` / `vscode-theme-seti` da UI (sem deletar `extensions/theme-*`). |
| `src/vs/workbench/browser/media/code-icon.svg`, `src/vs/sessions/browser/media/vscode-icon.svg`, `src/vs/workbench/browser/parts/editor/media/letterpress-*.svg` | Modificados | Emblema vetorial da carta Tarot IDE na titlebar, banners, Welcome, Sessions e marca d'água do editor vazio. |
| `resources/{linux,win32,darwin,server}/**` | Modificados | Ícones do SO/janela/web e manifestos (`code.desktop`, `code.appdata.xml`, `VisualElementsManifest.xml`, `manifest.json`). |
| `resources/tarot/**` | Novo | Assets mestres de marca (`logo.png`, `splash.png`, ícones 64..1024px). |
| `build/gulpfile.extensions.ts`, `build/gulpfile.vscode.ts`, `build/gulpfile.vscode.linux.ts`, `pnpm-workspace.yaml`, `build/npm/dirs.ts`, `pnpm-lock.yaml` | Modificados | Registro nativo da extensão built-in `extensions/tarot-core`, lockfile correspondente (`pnpm-lock.yaml` nunca deve ser resolvido manualmente em merges) e guarda `hasDefaultChatAgent` impedindo empacotamento de Copilot SDK/shim/symlink em produção. |
| `AGENTS.md`, `README.md`, `.github/copilot-instructions.md`, `.github/{instructions,prompts}/tarot-*` | Modificados / Novos | Documentação de entrada do repositório/agentes, cabeçalho de precedência em `.github/copilot-instructions.md` e instruções/prompts reutilizáveis do Tarot. |
| `src/vs/workbench/contrib/tarotSpecStepper/browser/*` & `src/vs/workbench/workbench.common.main.ts` | Novo (2 arquivos + 1 linha import) | Stepper visual nativo (ViewZone + OverlayWidget acima da linha 1 em `.tarot/specs/*/*.md`) com pills `[1 Requirements] › [2 Design] › [3 Task list]` + botões `Analyze` e `Review` (impossível via Extension API/CodeLens). |
| `src/vs/workbench/contrib/tarotReview/browser/*` & `src/vs/workbench/workbench.common.main.ts` | Novo (2 arquivos + 1 linha import) | Inline Diff Review nativo estilo Cursor no editor único (`ViewZone` vermelha para linhas removidas, `decoration` verde para adicionadas, `ContentWidget` com pills `Accept`/`Reject` por hunk e `OverlayWidget` flutuante no rodapé `↑ 1 of N ↓ \| Reject File \| Accept File`), alimentado por `_tarot.inlineReview.setState` do `tarot-core` (impossível via Extension API). |
| `extensions/tarot-core/**` | Novo | Extensão built-in central do Tarot IDE (tema, ícones, walkthrough e engine agêntica Kiro/BYOA). |
| `src/vs/workbench/browser/parts/auxiliarybar/auxiliaryBarPart.ts` | Modificado (1 getter) | `override get snap(): boolean { return true; }`, espelhando `sidebarPart.ts`: a Secondary Side Bar (painel `Tarot Agent`) agora fecha ao ser arrastada abaixo do limite, como a Side Bar esquerda — a classe base (`paneCompositePart.ts`) só permite isso condicionalmente, o que deixava o painel direito "encavalado" em vez de colapsar. Puro comportamento de grid/sash, impossível via Extension API. |
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
│   ├── svg/*.svg                       # 46 SVGs temáticos de pastas/arquivos (preservados intactos)
│   └── arcana/*.svg                    # Adição complementar: 8 ícones vetoriais dos Arcanos Maiores (00..17) usados nos itens/comandos internos
├── media/
│   ├── icon.png                        # Ícone 128x128 da extensão Tarot Core
│   ├── logo.png                        # Logotipo "TAROT IDE — ARCANA CODE ENVIRONMENT"
│   ├── splash.png                      # Arte splash 800x600 ("Divining Clean Code...")
│   ├── tarot-activity-icon.svg         # Ícone vetorial monocromático para Activity Bar / Secondary Side Bar (preservado intacto)
│   ├── tarot-{workflows,powers,skills,crew}-icon.svg # Ícones monocromáticos dos 4 novos containers dedicados da Activity Bar (Workflows, Powers, Skills & Agents, Tarot Crew)
│   ├── arcana/{*.png,arcana-manifest.json} # Adição complementar: 8 cartas ilustradas dos Arcanos Maiores + manifesto
│   └── webview/{panel,workflow,focusMode}.{css,js} + safeMarkdown.js # UIs CSP-estritas (zero innerHTML) do Painel Agêntico, Workflow Timeline Kiro, Tarot Agent Focus Mode (3 painéis com streaming ao vivo) e renderizador Markdown DOM seguro compartilhado
├── recipes/                            # M3.9a/b — 7 recipes bundled (*.workflow.json: investigate, feature-pipeline, publish-pr, semantic-review-multi-model, autoresearch, goal, ralph)
├── package.json                        # Manifesto (tema, ícones, 5 containers na Activity Bar esquerda + Secondary Side Bar direita, comandos e settings tarot.*, submenus, keybindings, walkthrough)
├── package.nls.json                    # Strings localizáveis
├── themes/
│   ├── tarot-dark-color-theme.json     # Tema oficial "Tarot Arcana Dark" (base grafite-violeta neutra sem faixa em L + sintaxe Kiro)
│   └── tarot-light-color-theme.json    # Tema oficial "Tarot Arcana Light" (UI + TextMate + Semantic)
├── tsconfig.json                       # Estende ../tsconfig.base.json + src/vscode-dts/vscode.d.ts
└── src/
    ├── extension.ts                    # Bootstrap, composição de serviços, registro das 15 TreeViews (5 containers na Activity Bar) + WebviewView + comandos base + KeyedHookQueue
    ├── commands/                       # Registradores de comandos por domínio (`workflowCommands.ts`, `specCommands.ts`, `scheduleAndLessonsCommands.ts`, `powersAndSkillsCommands.ts`, `crewCommands.ts`)
    ├── config/tarotConfig.ts           # Leitura tipada de configurações tarot.agents.*
    ├── agents/
    │   ├── types.ts                    # Contratos AgentAdapter (com listModels), AgentStatus, AgentEvent, AgentModelOption, ReasoningEffort, ContextProviderKind
    │   ├── processRunner.ts            # Resolução segura de PATH + spawn(shell: false) + cancelamento + guarda de tamanho de linha de comando antes do spawn (commandLineLimits.ts)
    │   ├── commandLineLimits.ts        # Teto puro e testável (binário+argv) por plataforma — bem mais estrito no Windows — para falhar com erro claro em vez de E2BIG/ENAMETOOLONG do SO
    │   ├── promptBuilder.ts            # Composição de prompt (modo Vibe/Spec/Plan, autonomy, steering/skills/powers/custom-agent, Spec ativo, histórico, anexos #); cada seção truncada em 50k chars, nunca o prompt do usuário
    │   ├── sessionStore.ts             # Persistência multi-sessão agnóstica em .tarot/sessions/<id>.json + hydrateFromDisk no boot, listPersistedSessions/deletePersistedSession, forkSession e truncateBeforeCheckpoint (M3.8c)
    │   ├── sessionConcurrency.ts       # M3.9c — Classificação/filtro de cards de sessão e regras de concorrência segura (mutex Spec, paralelo Plan/custom, aviso worktree)
    │   ├── runtimeManager.ts           # Auto-detecção (claude, agy, codex, custom CLI/ACP + catálogo ACP instalado no PATH), cache de listModelsForAgent() e Status Bar enxuta (Tarot · <agente>); agente ativo persiste em globalState
    │   ├── agentCatalog.ts             # M3.8b — Catálogo declarativo de CLIs ACP (agy-acp, kiro-cli, opencode, goose)
    │   ├── customAgentService.ts       # M3.8b — Descoberta e parse de Custom Agents (.tarot/agents/*.{md,json}, ~/.tarot/agents/, suporte a subpastas team/planner) + perfis Built-in
    │   ├── subagentManager.ts          # M3.8b — Herança estrita de permissões (evaluateSubagentCapability), validação de DAG imutável/review loops e execução paralela por onda (runSubagentDag)
    │   └── adapters/                   # claudeAdapter, agyAdapter (--mode auto/accept-edits/plan + agyStreamParser), codexAdapter, customAdapter, acpAdapter + acpParser (JSON-RPC 2.0 sobre stdio)
    ├── skills/
    │   └── skillsService.ts            # M3.8b + Activity Bar — Agent Skills (SKILL.md), progressive disclosure (/nome, $nome, match por tópico), criação de scaffold e importação por pasta local ou URL GitHub/GitLab
    ├── powers/
    │   └── powersService.ts            # M3.8b + Activity Bar — Agent Plugins (plugin.json + fallback POWER.md + skills/ + mcp.json), catálogo curado offline (5 starter Powers), instalação (catálogo/Git/local), criação/desinstalação segura e ativação sob demanda (/power:<id>, #<id>, keywords)
    ├── crew/
    │   ├── crewService.ts              # Paridade Kiro Crew — Crewmates persistentes (crewmate.json, memory.md, Work Ledger ledger.jsonl), camadas de memória (preferences.md, projects.md, history/), Knowledge Library local indexada sob demanda e parser/template TASK.md
    │   ├── semanticIndex.ts            # Fase 5 — Motor de busca semântica híbrida local (BM25 + embeddings vetoriais 128d cosseno + Reciprocal Rank Fusion)
    │   ├── heartbeatService.ts         # Fase 5 — Heartbeat Daemon periódico (git-status, git-branch, comandos validados por política) com logs JSONL e alertas deduplicados
    │   ├── gatewayService.ts           # Fase 5 — Servidor local de Webhooks (127.0.0.1, HMAC-SHA256) + gateways Slack/Discord/Telegram/Teams (segredos em SecretStorage + anti-SSRF)
    │   ├── appsAndRemoteService.ts     # Fase 5 — Crew Apps SDK (.tarot/crew/apps/*/app.json) e instâncias remotas SSH (.tarot/crew/remotes.json, BatchMode=yes, shell: false)
    │   └── devServerService.ts         # Descoberta de scripts dev/start/serve/preview/watch em package.json + terminais gerenciados (`tarot.devServers.manage`)
    ├── mcp/
    │   └── mcpConfigService.ts         # M3.8b — Descoberta hierárquica (.tarot/settings/mcp.json + ~/.tarot/settings/mcp.json), stdio + remote, redação de segredos em formatMcpContext
    ├── context/
    │   ├── activeFileContext.ts        # M6.1b — Helpers puros do chip automático de arquivo ativo (*Current File* + range de seleção + deduplicação contra anexos manuais)
    │   ├── contextProviders.ts         # Provedores # completos (#File, #Folder, #Problems, #Git Diff, #Terminal, #Codebase, #Steering, #Spec, #MCP, #Current, #Code, #URL, #Repository, #Docs)
    │   ├── urlSafety.ts                # Validação pura anti-SSRF para #URL (exige https://, bloqueia loopback/RFC1918/link-local/metadata)
    │   └── compactionService.ts        # M3.8c — Medidor real de tokens (computeContextMeter), compaction estruturada (compactConversationMessages), forkSessionMessages e export Markdown/JSONL
    ├── checkpoints/
    │   └── checkpointService.ts        # Snapshots por turno em .tarot/checkpoints/<session>/<cp>/ (Git e non-Git com backup leve <= 512 KB), rollback 1-clique, classificação Git (`-uall`) e revert seletivo por arquivo (restoreCheckpointFiles)
    ├── review/                         # M6.1 + M6.7 — Cursor-style Inline Diff Review (Git & non-Git)
    │   ├── diffHunkEngine.ts           # Motor puro de diff por linha/hunk (computeDiffHunks, applyAcceptHunk, applyRejectHunk, buildInlineDiffPreviewHunks, parsePorcelainStatusLine)
    │   ├── reviewSessionModel.ts       # Máquina de estado pura da fila de revisão por arquivo
    │   └── reviewSessionService.ts     # Sessão de revisão integrada ao overlay nativo Monaco (`_tarot.inlineReview.setState`), Accept/Reject por hunk e arquivo, cards inline no chat e sincronização bidirecional com o painel
    ├── steering/
    │   ├── steeringService.ts          # Descoberta hierárquica (AGENTS.md raiz e subdiretórios, ~/.tarot/steering, .tarot/steering), 4 modos de inclusão, referências vivas #[[file:...]] e /<id>
    │   └── lessonsService.ts           # M3.10 — Lições aprendidas editáveis em `.tarot/steering/`, promoção para Skill e Audit / Prune Steering (redundância, workarounds obsoletos, frontmatter)
    ├── schedule/                       # M3.10 — Agendamento Cron & Digests
    │   ├── cronParser.ts               # Avaliador cron 5 campos puro com timezone, excludeDates e jitter
    │   └── scheduleService.ts          # Descoberta `.tarot/schedules/*.json`, logs em `runs/` e digests Markdown em `digests/`
    ├── hooks/
    │   ├── hookTypes.ts                # Schema `v1` puro: parse/validação, triggers canônicos + aliases, `*`/matcher/confirm
    │   ├── hookMigration.ts            # Upconverte em memória o formato legado de hook para `v1` traduzindo `glob` para regex válida
    │   ├── hookRunner.ts               # Executa `action.command` via `/bin/sh -c`/`cmd.exe /c` (shell: false), STDIN JSON (com guarda EPIPE), timeout, exit 0/2/outro
    │   └── hookEngine.ts               # Descoberta hierárquica com reporte deduplicado de erros (onLoadErrors), KeyedHookQueue (debounce 250ms + lock serial) e orquestração por trigger/matcher
    ├── permissions/                    # M3.8a — Permissões Baseadas em Capacidades
    │   ├── permissionTypes.ts          # Capabilities/efeitos/escopos puros + parse/validação de `permissions.yaml`
    │   ├── yamlLite.ts                 # Parser YAML zero-dependência com block scalars (`|`/`>`) e rejeição explícita de âncoras/aliases/merge keys/flow mappings/multi-doc
    │   ├── shellParser.ts              # Split de comandos compostos (`;`/`&&`/`||`/`|`) respeitando quotes/subshells; bloqueia `$()`/backtick/heredoc
    │   ├── presets.ts                  # `allow-all`/`edit-workspace`/`read-workspace`/`read-all`/`read-only-shell`/`dev-shell`/`approve-for-me`
    │   ├── policyEngine.ts             # Avaliação pura: `deny > ask > allow > evaluate`, sem precedência entre escopos, proteção contra redirecionamento não citado
    │   ├── trustService.ts             # `vscode.workspace.isTrusted` + paths externos de `permissions.yaml` (user/workspace fora do repo)
    │   └── permissionsService.ts       # Orquestra escopos tarot/user/workspace/session, aprovação e gate de hooks `command`; watcher + toast deduplicado
    ├── specs/
    │   ├── specService.ts              # Feature/Design-First/Bugfix/Quick Spec (EARS), Analyze Requirements, Sync Files e PBT parser & stepper logic
    │   ├── markdownReview.ts           # Formatação em lote de comentários inline em Specs Markdown
    │   ├── taskParser.ts               # Parser de checklists `- [ ]`/`- [x]` + opcionais `*`, `_Requirements:_`, `_Depends:_`, `**Property N**`/`**Validates:**`
    │   ├── taskGraph.ts                # Grafo de dependências puro: agrupa tasks pendentes em ondas (Kahn)
    │   ├── taskRunner.ts               # Orquestra "Run all Tasks" onda a onda, pulando dependentes de tarefas que falharam
    │   ├── taskCodeLensProvider.ts     # CodeLens ▶ Run Task / ▶ Run Task with... / ✓ Task completed / ↺ View changes / ▶ Run all Tasks / ↻ Sync Files
    │   ├── taskDecorations.ts          # Barra vertical verde na margem esquerda de blocos de tarefas concluídas (`- [x]`) em `.tarot/specs/*/tasks.md`
    │   ├── specSync.ts                 # Merge puro do Sync Files preservando tarefas concluídas via numberLabel + titleSimilarity
    │   └── specTaskCheckpoints.ts      # Sidecar `.tarot/specs/<slug>/.task-checkpoints.json` com chave estável `computeTaskCheckpointKey` (numberLabel ou `title:<sha1-10>`)
    ├── workflows/                      # M3.9a — Motor de Workflows & Recipes
    │   ├── workflowTypes.ts            # Schema oficial de recipes, nós (step/sequence/repeat/parallel/watch), runs e agentes bundled
    │   ├── recipeValidator.ts          # `validateWorkflow`: limites (<=50 steps, depth <=8), IDs únicos, jsonPath, stopWhen, ordem de templates, fileCheck no workspace
    │   ├── templateResolver.ts         # Resolução de {{input}}/{{previous.output}}/{{step.output}}/{{artifacts.*}} com delimitadores com nonce
    │   ├── recipeLoader.ts             # Precedência workspace > user > bundled, JSON vence YAML com warning, recipe inválida não esconde válida inferior
    │   ├── watchHandlers.ts            # Watch `command` (STDIN/STDOUT JSON) e `github-pr` (`gh pr view`)
    │   ├── runStore.ts                 # Persistência de runs/checkpoints em `.tarot/workflows/runs/<id>.json`
    │   ├── workflowAgentProfiles.ts    # Prompts de papel para `BUNDLED_WORKFLOW_AGENTS`, protocolo `[SEND_MESSAGE:*]` e extração `[ARTIFACT:*]`
    │   ├── workflowViewHelpers.ts      # Helpers puros de classificação/busca de runs e flattening da árvore de steps (testados via `node --test`)
    │   └── workflowEngine.ts           # Execução com checkpoint por fronteira, pause cooperativa, retomada pós-reinício e `updateWorkflow`
    ├── test/
    │   └── *.test.ts                   # 46 suítes / 146 testes unitários puros via `node --test` (sem importar `vscode`)
    ├── git/
    │   ├── gitReviewService.ts         # Review Queue (git status/diff --numstat, HEAD diff, revert) + AI Commit Message (✦)
    │   └── worktreeManager.ts          # Worktrees Git isolados com rollback automático se falhar escrita do manifesto, aplicado em Run Task / Run all Tasks e sessões em Focus Mode
    └── views/
        ├── sessionsView.ts             # M3.9c — TreeView `SESSIONS` (busca, filtros, badges repo/worktree/Needs input/parked, Older Sessions e atalhos Schedule/Agent Config/Settings)
        ├── focusModeView.ts            # M3.9c — Tarot Agent Mode / Agent Focus Mode de 3 painéis (Sessions | Transcript+Composer com repo/worktree/agente | Inspector)
        ├── tarotSidebarViews.ts        # 5 TreeViews (Specs, Hooks, Steering, Local Agents, MCP Servers) todas com gate de Workspace Trust
        ├── workflowRunsView.ts         # M3.9b — TreeView `WORKFLOW RUNS` agrupada por status ("Needs you" primeiro) com busca
        ├── recipesView.ts              # M3.9b — TreeView `RECIPES` (Workspace/Global/Bundled) com ação inline `▷`
        ├── workflowRunEditor.ts        # M3.9b — Aba WebviewPanel `Workflow: <nome>` (árvore dockada, Follow, Go to active, Pause/Resume/Stop, + Add loops, Message step)
        ├── panelStrings.ts             # Catálogo de strings do painel (l10n.t) compartilhado host ↔ webview
        ├── panelProtocol.ts            # Union discriminada tipada + guarda runtime para protocolo postMessage do painel
        ├── panelHtml.ts                # Template HTML CSP-estrito com escapeHtml e catálogo l10n/Arcana do painel
        ├── turnContextBuilder.ts       # Montagem de systemContext por turno (Custom Agent + resources, Steering, Powers, Skills, MCP) com gate Workspace Trust
        └── agentPanelView.ts           # WebviewView Kiro (abas, History, Fork, Restore arquivos+contexto, medidor real + compaction, links Markdown clicáveis, seletor agrupado de Custom Agents, Skills/Powers/Steering `/nome`, fallback de modelo morto, Pre-PR Review)
```

> **Contrato Webview ↔ Extension Host**: toda troca de estado e ações do `Tarot Agent` passa pelo protocolo `postMessage` centralizado em `src/views/agentPanelView.ts` (handler `_handleMessage` + `_postState`) e `media/webview/panel.js` (`window.addEventListener('message', ...)`). O catálogo de strings viaja no HTML inicial em `window.__tarotL10n` (ver §3.5).

---

## 7. Comandos do Dia a Dia, Testes & Troubleshooting

### 7.1 Compilação & Watch
```bash
# 0. Pré-requisito: Node 24.22.x (.nvmrc) e sempre pnpm (nunca npm)
nvm use
pnpm install

# Compilação rápida só da extensão tarot-core (~300ms — ideal no dia a dia)
pnpm exec gulp compile-extension:tarot-core

# Watch isolado da extensão tarot-core (~200ms ao salvar)
pnpm run watch-tarot-core

# Compilação completa do Tarot IDE (núcleo src/ + todas as extensões, SEM Copilot, ~1 min)
pnpm run compile-tarot

# Watch completo do Tarot IDE (SEM Copilot — recomendado quando mexer no core)
pnpm run watch-tarot

# Watch rápido (transpile + extensões, sem typecheck contínuo do core)
pnpm run watch-tarot-fast

# Transpile rápido e typecheck estrito do núcleo (obrigatório após alterar src/vs/)
node build/next/index.ts transpile
pnpm run typecheck-client
```

### 7.2 Bateria de Testes Automatizados & Invariantes
```bash
# 1. Suíte unitária pura do tarot-core (46 suítes / 146 testes, ~5s, sem importar vscode)
node --test "extensions/tarot-core/out/test/**/*.test.js"

# 2. Rodar um arquivo de teste específico
node --test extensions/tarot-core/out/test/scheduleService.test.js

# 3. Testes de NLS e resources do núcleo VS Code (30 testes)
node --test build/lib/test/nlsMessages.test.ts build/lib/test/nlsMetadata.test.ts build/next/test/resources.test.ts

# 4. Verificar invariantes de segurança (deve retornar 0 ocorrências)
rg "innerHTML|outerHTML|insertAdjacentHTML|shell:\s*true|eval\(|new Function" extensions/tarot-core/src extensions/tarot-core/media

# 5. Validar bundle de produção da extensão (gera extensions/tarot-core/dist/extension.js)
node extensions/tarot-core/esbuild.mts
```

### 7.3 Execução Manual & Smoke-Test na UI
```bash
# Abrir o Tarot IDE em modo desenvolvimento
./scripts/code.sh
```

Roteiro rápido de verificação manual na UI:
1. **Painel Agêntico (direita)**: abrir `Tarot Agent`, selecionar CLI local (`claude`/`agy`/`codex`), testar `#` (context providers) e `/` (slash commands).
2. **Sessions & Focus Mode (`M3.9c`)**: abrir a view **Sessions** (barra esquerda) e clicar em **Toggle Agent Focus Mode** no topo direito do editor para alternar em 1 clique para o layout de 3 painéis (testando seletor de repositório e `+ New isolated worktree`).
3. **Workflows (`M3.9a/b`)**: clicar em `▷` em **Recipes** na barra esquerda para abrir a aba `Workflow: <nome>` com árvore de steps e controles.
4. **Schedule & Lições (`M3.10`)**: clicar em **Schedule** no rodapé de **Sessions** e testar na Command Palette (`Ctrl+Shift+P`): `Tarot IDE: Record Learned Lesson` e `Tarot IDE: Audit / Prune Steering Rules`.

### 7.4 Empacotamento de Produção Linux (Fase 4)
```bash
pnpm exec gulp vscode-linux-x64-min        # binário minificado
pnpm exec gulp vscode-linux-x64-build-deb  # pacote .deb
pnpm exec gulp vscode-linux-x64-build-rpm  # pacote .rpm
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
