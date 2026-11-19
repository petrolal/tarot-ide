# Tarot IDE — Plano de Migração e Evolução

> Roteiro estruturado de migração a partir do `microsoft/vscode` (Code - OSS) até um produto completo e distribuível (**Tarot IDE**), incluindo a estratégia contínua de sincronização com o upstream.

---

## Visão Geral das Fases

| Fase | Escopo | Status |
| --- | --- | --- |
| **Fase 1** | Setup do ambiente, fork base, rebranding inicial (`product.json`) e esqueleto `tarot-core` | ✅ Concluída *(validada e commitada em `tarot-main`)* |
| **Fase 2** | Rebranding visual completo (ícones, tema padrão, ícones de arquivo, textos UI, walkthrough, desativação do Copilot) | ✅ Concluída *(pendente apenas conectar `origin` e URLs do repo)* |
| **Fase 3** | Arquitetura 100% Agêntica (layout e workflow Kiro: Specs, Hooks, Steering e painel multi-agente local `claude-code`, `codex`, `agy`) | ⏳ Próxima |
| **Fase 4** | Empacotamento de produção, CLI `tarot`, instaladores (`.deb`/`.rpm`/AppImage/Win/Mac) e CI/CD | 📋 Planejada |
| **Contínuo** | Processo de sincronização e atualização com novas releases do `microsoft/vscode` | 🔄 Recorrente |

---

## Fase 1 — Fundação e Setup Inicial (Concluída ✅)

### O que já foi entregue
- [x] Verificação de pré-requisitos (Git, Node.js `v24.22.2` compatível com `.nvmrc` `24.22.1`, Python 3.12, `g++`/`make`/`pkg-config`, `pnpm`).
- [x] Instalação dos headers nativos Linux (`libx11-dev`, `libxkbfile-dev`, `libsecret-1-dev`, `libkrb5-dev`).
- [x] Clonagem do `microsoft/vscode` (`1.148.0`) em `tarot-ide`, configuração do remote `upstream` e criação da branch `tarot-main`.
- [x] Rebranding inicial em `product.json` (identidade `Tarot IDE`, CLI `tarot`, `.tarot-ide`, Open VSX Registry, `"enableTelemetry": false`, remoção de `agentsTelemetryAppName` e `voiceWsUrl`).
- [x] Criação da extensão built-in `extensions/tarot-core` integrada em `build/gulpfile.extensions.ts`, `pnpm-workspace.yaml` e `build/npm/dirs.ts`.
- [x] Execução de `pnpm install` (57 projetos do workspace) e validação de compilação isolada (`pnpm exec gulp compile-extension:tarot-core` com 0 erros).

### Fechamento da Fase 1
- [x] Rodar `pnpm run compile` / `pnpm run watch` + `./scripts/code.sh` (com ajuste de permissão do `chrome-sandbox` no Ubuntu 24.04) e validar abertura com tema **Tarot Arcana Dark**.
- [x] Registrar os commits iniciais estruturados na branch `tarot-main`.
- [ ] Adicionar o repositório remoto próprio (`git remote add origin <url-do-repo-tarot>`).

---

## Fase 2 — Rebranding Visual e Experiência Inicial

Objetivo: eliminar a aparência genérica de "Code - OSS" e dar identidade própria ao Tarot IDE sem criar dívida de merge no núcleo.

### 2.1 Assets e Ícones do Sistema Operacional
- [x] **Linux**: `resources/linux/code.png` (1024x1024) atualizado com a carta arcana do Tarot IDE.
- [x] **macOS**: `resources/darwin/code.icns` atualizado.
- [x] **Windows**: `resources/win32/code.ico` (6 tamanhos), `code_150x150.png` e `code_70x70.png` atualizados.
- [x] **Server / Web**: `resources/server/favicon.ico`, `code-192.png`, `code-512.png` e `manifest.json` atualizados.
- [x] **Assets mestres**: `logo.png` e `splash.png` salvos em `resources/tarot/` e `extensions/tarot-core/media/`.
- [x] **Workbench SVGs & Watermark**: `src/vs/workbench/browser/media/code-icon.svg` (titlebar/banners/welcome), `src/vs/sessions/browser/media/vscode-icon.svg` e `src/vs/workbench/browser/parts/editor/media/letterpress-*.svg` (marca d'água do editor vazio) substituídos pelo emblema vetorial do Tarot IDE.
- [ ] **Pendências opcionais**: `inno-big-*.bmp` / `inno-small-*.bmp` (instalador Windows).

### 2.2 Tema Padrão e Experiência de Boas-Vindas
- [x] Tema oficial **Tarot Arcana Dark** integrado e enriquecido em `extensions/tarot-core/themes/tarot-dark-color-theme.json` (UI completa + Terminal ANSI + TextMate + Semantic Highlighting).
- [x] Registrado em `extensions/tarot-core/package.json` (`contributes.themes`), `product.json` (`onboardingThemes`) e definido como tema escuro padrão em `src/vs/workbench/services/themes/common/workbenchThemeService.ts`.
- [x] Tema de ícones de pastas e arquivos **Tarot Arcana Icons** (`extensions/tarot-core/icons/`, 46 SVGs) registrado via `contributes.iconThemes` e definido como padrão (`FILE_ICON_THEME = 'tarot-arcana-icons'`).
- [x] **Rebranding de textos UI (padrão Cursor/Kiro/Windsurf)**: camada central `_rebrandMessage` em `src/vs/nls.ts` cobrindo todas as 337 strings `localize()` do core (inclusive Language Packs) sem editar dezenas de arquivos + ajuste dos 6 textos Markdown em `src/vs/workbench/contrib/welcomeWalkthrough/browser/editor/vs_code_editor_walkthrough.ts` (extensões built-in de linguagem `extensions/*/package.nls.json` intencionalmente preservadas para zero conflito com upstream).
- [x] **Getting Started Walkthrough exclusivo**: registrado em `extensions/tarot-core/package.json` (`contributes.walkthroughs`, `featuredFor: ["*"]`) utilizando `media/splash.png` e `media/logo.png`.

### 2.3 Revisão de Endpoints e Referências Microsoft/Copilot
- [x] **Decisão Copilot executada (Desativação Limpa)**:
  - Removidos `defaultChatAgent`, `"GitHub.copilot-chat"` de `builtInExtensionsEnabledWithAutoUpdates` e entradas Copilot de `trustedExtensionAuthAccess` em `product.json`.
  - Adicionado `--disable-extension=GitHub.copilot-chat` em `scripts/code.sh` e `scripts/code.bat` (em produção, `copilot` já é excluído em `build/lib/extensions.ts -> excludedExtensions`).
  - Adicionados scripts leves `compile-tarot`, `watch-tarot`, `watch-tarot-fast` e `watch-tarot-core` em `package.json`, preservando `extensions/copilot/` no Git para evitar conflitos de merge com `upstream`.
- [ ] Atualizar URLs institucionais em `product.json` quando o repositório remoto `origin` existir (`reportIssueUrl`, `documentationUrl`, `releaseNotesUrl`).
- [ ] Avaliar a substituição de `webviewContentExternalBaseUrlTemplate` caso o Tarot IDE venha a distribuir versão Web/Server com infraestrutura própria.

---

## Fase 3 — Experiência 100% Agêntica (Layout & Workflow Kiro)

Objetivo: transformar o Tarot IDE em uma IDE 100% agêntica no modelo do **Kiro IDE**, orquestrando as ferramentas de IA já instaladas na máquina do usuário (`claude-code`, `codex`, `agy`) de forma modular dentro de `extensions/tarot-core`.

### 3.1 Pilares do Workflow (Estilo Kiro)
1. **Descoberta e Orquestração de Agentes Locais (`Agent Runtime Manager`)**:
   - Auto-detecção no `PATH` das CLIs instaladas (`claude`, `codex`, `agy`) com status, versão e seleção por sessão/tarefa.
   - Adaptadores unificados (stream JSON / PTY / subprocesso) abstraindo diferenças de flags, contexto e aprovação de ferramentas.
2. **Painel Agêntico Dedicado (Secondary Side Bar — Direita)**:
   - WebviewView nativa ocupando o painel direito (livre após desativação do Copilot), com seletor de agente (`claude-code` / `codex` / `agy`), alternância **Vibe Mode** vs **Spec Mode**, histórico de sessões, visualização de diffs e ações rápidas de aprovação.
3. **Spec-Driven Development (`Specs` — Barra Lateral Esquerda)**:
   - Fluxo estruturado `.tarot/specs/<feature>/`: `requirements.md` → `design.md` → `tasks.md` com execução incremental de tarefas pelos agentes e marcação automática de progresso.
4. **Agent Hooks & Steering (`.tarot/hooks/` e `.tarot/steering/`)**:
   - **Steering**: arquivos Markdown de contexto/regras injetados automaticamente nas sessões dos agentes.
   - **Hooks**: gatilhos em eventos do editor (`onDidSaveTextDocument`, criação/remoção de arquivos, pré-commit) que disparam um agente local automaticamente.

### 3.2 Diretrizes Arquiteturais
1. **Extensão primeiro (`extensions/tarot-core`)**:
   - Comandos, menus, barras de status, TreeViews (Specs/Hooks/Steering/Agents), WebviewView na Secondary Side Bar, integração com Diff Editor/Terminal/MCP e configurações `tarot.*`.
   - Se alguma integração exigir APIs internas do VS Code, declarar em `enabledApiProposals` no `extensions/tarot-core/package.json` e incluir o respectivo `.d.ts` no `tsconfig.json`.
2. **Core (`src/vs/`) apenas como último recurso**:
   - Quando inevitável (ex.: ajustes finos de layout inicial padrão da Secondary Side Bar), isolar com o mínimo de linhas tocadas para manter merges com `upstream` limpos.

### 3.3 Estrutura Modular Sugerida dentro de `extensions/tarot-core/src/`
```text
extensions/tarot-core/src/
├── extension.ts        # Registro central de módulos e ciclo de vida
├── agents/             # Detecção e adaptadores para claude-code, codex e agy
├── specs/              # Gerenciador de Spec-Driven Development (.tarot/specs/)
├── hooks/              # Engine de Agent Hooks (eventos do workspace → agente)
├── steering/           # Carregamento e injeção de regras (.tarot/steering/)
├── views/              # WebviewView do Painel Agêntico + TreeViews laterais
├── commands/           # Comandos tarot.*
└── config/             # Leitura tipada de configurações tarot.*
```

---

## Fase 4 — Empacotamento, CLI `tarot` e Distribuição

Objetivo: gerar instaladores finais prontos para usuários finais e automatizar releases.

### 4.1 Builds de Produção Locais (Linux)
Com `product.json` configurado (`applicationName: "tarot"`), o pipeline de build do VS Code gera automaticamente o binário CLI `tarot`, o pacote e o lançador `.desktop`:

```bash
# Build minificado da aplicação Linux x64 (gera ../VSCode-linux-x64/)
pnpm exec gulp vscode-linux-x64-min

# Gerar pacote instalável .deb (Debian/Ubuntu)
pnpm exec gulp vscode-linux-x64-build-deb

# Gerar pacote .rpm (Fedora/RHEL)
pnpm exec gulp vscode-linux-x64-build-rpm
```

### 4.2 Alvos Multiplataforma (Windows e macOS)
- **Windows**: `vscode-win32-x64-min` + instaladores Inno Setup (`vscode-win32-x64-user-setup` / `system-setup`).
- **macOS**: `vscode-darwin-arm64-min` / `vscode-darwin-x64-min` + assinatura de código (Apple Developer ID + notarização) usando `darwinBundleIdentifier: "com.tarot.ide"`.

### 4.3 Pipeline de CI/CD e Auto-Update
- [ ] Configurar GitHub Actions com matriz de builds (Linux x64/arm64, macOS arm64, Windows x64) acionada por tags `v*`.
- [ ] Publicar artefatos em GitHub Releases.
- [ ] (Opcional) Configurar `updateUrl` em `product.json` apontando para um serviço leve de atualização (compatível com o protocolo de update do VS Code / padrão VSCodium) para atualizações automáticas do cliente desktop.

---

## Estratégia de Sincronização Contínua com o Upstream (`microsoft/vscode`)

Como o repositório foi clonado inicialmente com `--depth 1` para agilizar o setup, siga este protocolo ao atualizar o Tarot IDE para novas versões estáveis da Microsoft (ex.: mensalmente, por tag de release `1.149.0`, `1.150.0`, etc.):

### Passo a Passo de Atualização
```bash
# 1. Garantir histórico suficiente do upstream (necessário apenas na primeira sincronização após clone shallow)
git fetch --unshallow upstream
# Ou buscar explicitamente uma tag estável específica:
git fetch upstream tag 1.149.0 --depth=100

# 2. Atualizar a branch main local com o upstream
git checkout main
git merge --ff-only upstream/main

# 3. Criar uma branch dedicada de sincronização a partir de tarot-main
git checkout tarot-main
git checkout -b sync/vscode-1.149.0

# 4. Mesclar a nova base da Microsoft (preferir merge a rebase em forks de longa duração)
git merge upstream/main   # ou: git merge 1.149.0

# 5. Resolver eventuais conflitos (ver matriz abaixo), atualizar dependências e validar
pnpm install
pnpm exec gulp compile-extension:tarot-core
pnpm run watch            # validar 0 erros de compilação
./scripts/code.sh         # smoke test manual

# 6. Integrar de volta em tarot-main
git checkout tarot-main
git merge --no-ff sync/vscode-1.149.0
```

### Matriz de Risco de Conflitos por Arquivo

| Arquivo | Probabilidade de Conflito | Como Resolver |
| --- | --- | --- |
| `product.json` | Média-Alta | Manter chaves de identidade Tarot, `extensionsGallery` (Open VSX), `enableTelemetry: false` e ausência de `defaultChatAgent`/`GitHub.copilot-chat`; aceitar atualizações upstream de `builtInExtensions` (ex.: `js-debug`) e `webviewContentExternalBaseUrlTemplate`. |
| `package.json` & `scripts/code.{sh,bat}` | Muito baixa | Manter scripts `*-tarot*` no `package.json` e `--disable-extension=GitHub.copilot-chat` em `scripts/code.{sh,bat}`. |
| `pnpm-workspace.yaml` & `build/npm/dirs.ts` | Baixa | Manter a linha `extensions/tarot-core` em ordem alfabética junto aos novos membros adicionados pelo upstream. |
| `build/gulpfile.extensions.ts` | Baixa | Manter `'extensions/tarot-core/tsconfig.json'` no array `compilations`. |
| `src/vs/nls.ts` | Muito baixa | Manter `_rebrandMessage` em `_format` (~15 linhas) garantindo execução antes da interpolação de `args`. |
| `src/vs/workbench/contrib/welcomeWalkthrough/browser/editor/vs_code_editor_walkthrough.ts` | Muito baixa | Manter "Tarot IDE" nos 6 trechos de texto do playground interativo. |
| `onboardingVariationA.ts`, `defaultAccount.ts`, `extensionGalleryService.ts`, `extensionsWorkbenchService.ts`, `abstractExtensionManagementService.ts` | Muito baixa | Manter os guards contra `defaultChatAgent === undefined` (garante boot limpo e busca/instalação no Open VSX sem Copilot). |
| `src/vs/workbench/services/themes/common/workbenchThemeService.ts` | Muito baixa | Manter `COLOR_THEME_DARK = 'Tarot Arcana Dark'` e `FILE_ICON_THEME = 'tarot-arcana-icons'` (2 linhas). |
| `src/vs/workbench/browser/media/code-icon.svg`, `src/vs/sessions/browser/media/vscode-icon.svg`, `src/vs/workbench/browser/parts/editor/media/letterpress-*.svg` | Muito baixa | Manter os SVGs do Tarot IDE (`git checkout --ours`) se o upstream alterar ícones. |
| `resources/{linux,win32,darwin,server}/**` | Muito baixa | Manter os ícones e manifestos do Tarot IDE (`git checkout --ours`) caso o upstream atualize assets da Microsoft. |
| `pnpm-lock.yaml` | Alta | Não resolver manualmente: aceitar a versão do upstream (`git checkout --theirs pnpm-lock.yaml`) e rodar `pnpm install` para regenerar com `extensions/tarot-core`. |
| `extensions/tarot-core/**`, `resources/tarot/**` e `docs/**` | Nula | Diretórios exclusivos do Tarot IDE; nunca conflitam com o upstream. |
