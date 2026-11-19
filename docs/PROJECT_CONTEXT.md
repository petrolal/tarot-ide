# Tarot IDE — Contexto do Projeto

> Documento de contexto arquitetural e operacional do **Tarot IDE**, um editor de código baseado no núcleo open-source do Visual Studio Code (`microsoft/vscode` / Code - OSS) e Electron.

---

## 1. Visão Geral e Identidade do Produto

| Propriedade | Valor configurado |
| --- | --- |
| **Nome do Produto (`nameShort` / `nameLong`)** | `Tarot IDE` |
| **Binário / CLI (`applicationName`)** | `tarot` |
| **Protocolo de URL (`urlProtocol`)** | `tarot://` |
| **Diretório de Dados (`dataFolderName`)** | `.tarot-ide` (`~/.tarot-ide`) |
| **Diretório Compartilhado (`sharedDataFolderName`)** | `.tarot-ide-shared` |
| **Servidor / Túnel** | `tarot-server` (`.tarot-ide-server`) / `tarot-tunnel` |
| **Bundle ID macOS (`darwinBundleIdentifier`)** | `com.tarot.ide` |
| **Desktop / Ícone Linux (`linuxDesktopName` / `linuxIconName`)** | `com.tarot.ide` / `tarot-ide` |
| **Identidade Windows (`win32DirName` / `win32AppUserModelId`)** | `Tarot IDE` / `Tarot.TarotIDE` |
| **Marketplace de Extensões** | **Open VSX Registry** (`https://open-vsx.org/vscode/gallery`) |
| **Tema Padrão** | **Tarot Arcana Dark** (`#0A0A16` / `#1D1135` / `#4B0082` / `#D4AF37` / `#4FD1C5`) |
| **Tema de Ícones Padrão** | **Tarot Arcana Icons** (`tarot-arcana-icons` — 46 SVGs de pastas e arquivos) |
| **Telemetria Microsoft** | **Desativada** (`"enableTelemetry": false`) |

---

## 2. Base Técnica e Ambiente

- **Repositório upstream**: `https://github.com/microsoft/vscode.git`
- **Versão base do Code - OSS**: `1.148.0`
- **Commit base (`upstream/main`)**: `6cb9b401f8e7209fecb7ffe4d45dcb490e5dbb87` (2026-11-19)
- **Runtime Electron**: `43.8.10` (definido em `package.json -> nativeBuild.target`)
- **Node.js requerido (`.nvmrc`)**: `24.22.1` (mesma major `24`, validado em `build/npm/preinstall.ts`)
- **Gerenciador de pacotes**: **`pnpm@12.16.0`** (obrigatório nesta versão do VS Code; `npm install` é bloqueado pelo `preinstall.ts`)
- **Dependências de sistema (Linux / Ubuntu 24.04)**:
  - `git`, `python3`, `build-essential` (`g++`, `make`), `pkg-config`
  - Headers nativos para módulos C++/Electron: `libx11-dev`, `libxkbfile-dev`, `libsecret-1-dev`, `libkrb5-dev`

---

## 3. Estratégia de Git e Branches

O repositório local em `/home/lucas.petrola/Projects/Personal/tarot-ide` segue separação estrita entre código da Microsoft e customizações do Tarot IDE:

- **Remote `upstream`**: aponta para `https://github.com/microsoft/vscode.git` (somente leitura/sincronização).
- **Remote `origin`** *(a configurar)*: apontará para o repositório próprio do Tarot IDE.
- **Branch `main`**: mantida limpa, espelhando `upstream/main`. Nunca commitar alterações do Tarot diretamente nela.
- **Branch `tarot-main`**: branch principal de desenvolvimento do Tarot IDE.

---

## 4. Superfície de Alterações no Núcleo (Diff Mínimo)

Para manter atualizações futuras do `microsoft/vscode` simples e com risco mínimo de conflito, a superfície de arquivos modificados no núcleo é deliberadamente enxuta:

| Arquivo | Tipo | Finalidade |
| --- | --- | --- |
| `product.json` | Modificado | Rebranding completo para Tarot IDE, tema `Tarot Arcana Dark` em `onboardingThemes`, Open VSX Registry, `"enableTelemetry": false` e remoção de `agentsTelemetryAppName` e `voiceWsUrl`. |
| `src/vs/nls.ts` | Modificado (~15 linhas) | Normalização centralizada de strings UI (`_rebrandMessage` em `_format`) antes da interpolação de `args`: rebranda `"Visual Studio Code"`, `"VS Code"` e `"Code - OSS"` para `"Tarot IDE"` em toda a UI do core (inclusive Language Packs PT-BR), preservando URLs, argumentos de usuário e exceções legítimas (keymaps/importação do VS Code). |
| `src/vs/workbench/contrib/welcomeWalkthrough/browser/editor/vs_code_editor_walkthrough.ts` | Modificado (6 trechos) | Atualiza as menções de marca no playground interativo em Markdown (fora de `localize`). |
| `src/vs/workbench/services/themes/common/workbenchThemeService.ts` | Modificado (2 linhas) | Define `COLOR_THEME_DARK = 'Tarot Arcana Dark'` e `FILE_ICON_THEME = 'tarot-arcana-icons'` como padrões na primeira inicialização. |
| `src/vs/workbench/browser/media/code-icon.svg`, `src/vs/sessions/browser/media/vscode-icon.svg`, `src/vs/workbench/browser/parts/editor/media/letterpress-*.svg` | Modificados | Substituição dos ícones SVG internos do workbench (barra de título `.window-appicon`, Welcome/Getting Started, banners, Sessions e marca d'água do editor vazio) pelo emblema vetorial da carta Tarot IDE. |
| `resources/linux/{code.png,code.desktop,code.appdata.xml}`, `resources/win32/{code.ico,code_70x70.png,code_150x150.png,VisualElementsManifest.xml}`, `resources/darwin/code.icns`, `resources/server/{favicon.ico,code-192.png,code-512.png,manifest.json}` | Modificados | Substituição dos ícones, metadados de desktop/AppStream e manifestos Windows/PWA pela identidade oficial do Tarot IDE. |
| `resources/tarot/**` | Novo | Assets mestres de marca (`logo.png`, `splash.png` e ícones 64..1024px). |
| `build/gulpfile.extensions.ts` | Modificado | Registro de `extensions/tarot-core/tsconfig.json` no array `compilations` (compilação e `watch` automáticos). |
| `pnpm-workspace.yaml` | Modificado | Inclusão de `extensions/tarot-core` como membro do workspace pnpm. |
| `build/npm/dirs.ts` | Modificado | Inclusão de `extensions/tarot-core` em `workspaceMembers` (mantido sincronizado com `pnpm-workspace.yaml`). |
| `extensions/tarot-core/**` | Novo | Extensão built-in exclusiva do Tarot IDE (desacoplada do core `src/vs/`). |
| `docs/**` | Novo | Documentação de contexto e plano de migração (pasta inexistente no upstream). |

> **Observação sobre `defaultChatAgent`**: o bloco `defaultChatAgent` (Copilot) em `product.json` foi preservado inicialmente para minimizar conflitos até que a estratégia de IA/chat do Tarot IDE seja definida (ver `docs/MIGRATION_PLAN.md`).

---

## 5. Arquitetura de Extensibilidade (`extensions/tarot-core`)

### Regra de Ouro do Projeto
Concentrar **90%+ das funcionalidades exclusivas do Tarot IDE** dentro de `extensions/tarot-core/` (ou extensões built-in irmãs em `extensions/tarot-*`), utilizando a API oficial do VS Code (`vscode.d.ts`) e *Proposed APIs* (`enabledApiProposals`) quando necessário.

Alterações em `src/vs/` devem ocorrer **apenas** quando for tecnicamente impossível implementar o requisito via extensão (ex.: mudanças estruturais de layout do workbench ou chrome nativo).

### Por que `tarot-core` não está em `product.json -> builtInExtensions`?
No sistema de build do VS Code:
- `product.json -> builtInExtensions` destina-se exclusivamente a extensões **externas** baixadas de outros repositórios/Marketplace durante o build (via `repo` + `sha256`, como `ms-vscode.js-debug`).
- Extensões built-in **locais** em `extensions/*/` são descobertas automaticamente em runtime (Extension Host) e no empacotamento via `glob.sync('extensions/*/package.json')` em `build/lib/extensions.ts`.

### Estrutura atual de `extensions/tarot-core/`
```text
extensions/tarot-core/
├── .vscodeignore                       # Exclusões para empacotamento de produção
├── esbuild.mts                         # Bundler de produção (gera dist/extension.js)
├── icons/
│   ├── tarot-arcana-icon-theme.json    # Tema de ícones de pastas/arquivos "Tarot Arcana Icons"
│   └── svg/*.svg                       # 46 SVGs temáticos na paleta Arcana
├── media/
│   ├── icon.png                        # Ícone 128x128 da extensão Tarot Core
│   ├── logo.png                        # Logotipo horizontal "TAROT IDE — ARCANA CODE ENVIRONMENT"
│   └── splash.png                      # Arte splash 800x600 ("Divining Clean Code...")
├── package.json                        # Manifesto (publisher: "tarot", tema, ícones, walkthrough e comando tarot.welcome)
├── package.nls.json                    # Strings localizáveis
├── themes/
│   └── tarot-dark-color-theme.json     # Tema oficial "Tarot Arcana Dark" (UI + TextMate + Semantic)
├── tsconfig.json                       # Estende ../tsconfig.base.json + src/vscode-dts/vscode.d.ts
└── src/
    └── extension.ts                    # Entry point (activate / deactivate + OutputChannel + tarot.welcome)
```

---

## 6. Marketplace e Privacidade

### Open VSX Registry
Configurado em `product.json -> extensionsGallery`:
- `serviceUrl`: `https://open-vsx.org/vscode/gallery`
- `itemUrl`: `https://open-vsx.org/vscode/item`
- `resourceUrlTemplate`: `https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}`
- `controlUrl`: `""`
- `nlsBaseUrl`: `""`

Essa configuração evita o uso do Marketplace proprietário da Microsoft (cujos termos restringem o uso fora dos binários oficiais da Microsoft) e habilita ícones, READMEs e extensões web do Open VSX.

### Telemetria
- `"enableTelemetry": false` em `product.json` desativa a coleta de telemetria diretamente na verificação central de `src/vs/platform/telemetry/common/telemetryUtils.ts`.
- Removidos `agentsTelemetryAppName` e o endpoint proprietário `voiceWsUrl` (`falcon-caas.mai.microsoft.com`).

---

## 7. Comandos do Dia a Dia

```bash
# 1. Instalar/atualizar dependências do workspace (obrigatório usar pnpm)
pnpm install

# 2. Iniciar compilação contínua (core + todas as extensões + tarot-core)
pnpm run watch
# Alternativa em background daemon:
pnpm run watchd

# 3. Compilar apenas a extensão tarot-core (validação rápida ~1s)
pnpm exec gulp compile-extension:tarot-core

# 4. Executar o Tarot IDE em modo desenvolvimento (após o primeiro "Finished compilation")
./scripts/code.sh
```

### Troubleshooting conhecido (Ubuntu 24.04)
- **Erro `chrome-sandbox` ao rodar `./scripts/code.sh`**: com `kernel.apparmor_restrict_unprivileged_userns = 1`, o Electron exige que o helper SUID pertença ao `root`:
  ```bash
  sudo chown root:root .build/electron/chrome-sandbox && sudo chmod 4755 .build/electron/chrome-sandbox
  ```
- **Limite de watchers (`ENOSPC`) no `pnpm run watch`**: caso ocorra em sessões longas, aumente `fs.inotify.max_user_watches`:
  ```bash
  sudo sysctl fs.inotify.max_user_watches=524288
  ```
