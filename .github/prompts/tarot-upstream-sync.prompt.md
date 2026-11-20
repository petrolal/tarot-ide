---
description: Sincroniza o fork com uma tag do microsoft/vscode aplicando a Matriz de Conflitos de docs/MIGRATION_PLAN.md e validando a identidade Tarot.
agent: agent
---

# Sincronização com o Upstream (`microsoft/vscode`)

Tag alvo: `${input:tag:Tag do upstream, ex.: 1.149.0}`

Fonte autoritativa: seções **"Protocolo Contínuo de Sincronização com o Upstream"** e **"Matriz de Conflitos por Arquivo"** de `docs/MIGRATION_PLAN.md`. Se este prompt divergir do documento, **o documento vence**.

## 0. Pré-checagens
- `git branch --show-current` deve ser `tarot-main` e `git status` **limpo** (senão pare e avise).
- Remotes esperados: `origin` = `https://github.com/petrolal/tarot-ide.git`; `upstream` = `https://github.com/microsoft/vscode.git` (`git remote add upstream ...` se faltar).
- Leia `AGENTS.md`, `docs/PROJECT_CONTEXT.md` (Seções 3 e 5) e a matriz de conflitos.

## 1. Protocolo
```bash
git fetch upstream tag <TAG> --depth=100        # na primeira vez em clone shallow: --unshallow ou --depth
git checkout main && git merge --ff-only upstream/main   # main só espelha o upstream; NUNCA commitar nela
git checkout tarot-main && git checkout -b sync/vscode-<TAG>
git merge <TAG>
```
Resolva os conflitos conforme a matriz abaixo; depois:
```bash
pnpm install
pnpm run compile-tarot
pnpm run typecheck-client
node --test build/lib/test/nlsMessages.test.ts build/lib/test/nlsMetadata.test.ts build/next/test/resources.test.ts
pnpm exec gulp compile-extension:tarot-core
./scripts/code.sh        # validação visual quando o ambiente permitir
git checkout tarot-main && git merge --no-ff sync/vscode-<TAG>
```

## 2. Matriz de Conflitos (aplicar exatamente)
| Arquivo | Risco | Regra |
| --- | --- | --- |
| `product.json` | Médio-Alto | Preservar identidade Tarot, Open VSX, `enableTelemetry: false` e ausência de `defaultChatAgent`/`GitHub.copilot-chat`; aceitar atualizações upstream de `builtInExtensions` (`js-debug`) e `webviewContentExternalBaseUrlTemplate`. |
| `pnpm-lock.yaml` | Alto | **Nunca resolver manualmente**: `git checkout --theirs pnpm-lock.yaml && pnpm install`. |
| `pnpm-workspace.yaml`, `build/npm/dirs.ts` | Baixo | Manter `extensions/tarot-core` em ordem alfabética. |
| `build/gulpfile.extensions.ts` | Baixo | Manter `'extensions/tarot-core/tsconfig.json'` em `compilations`. |
| `package.json`, `scripts/code.{sh,bat}` | Muito baixo | Manter scripts `*-tarot*` e `--disable-extension=GitHub.copilot-chat`. |
| `src/vs/nls.ts` | Muito baixo | Manter `_rebrandMessage` em `_format` antes da interpolação de `args`. |
| `src/vs/workbench/services/themes/common/workbenchThemeService.ts` | Muito baixo | Manter `COLOR_THEME_DARK = 'Tarot Arcana Dark'` e `FILE_ICON_THEME = 'tarot-arcana-icons'`. |
| `src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts` e `src/vs/workbench/services/chat/common/chatEntitlementService.ts` | Muito baixo | Manter `chat.disableAIFeatures: true`, `copilotCliCommand`/`titleBar.signIn`/`welcomePage.signIn: false` e `ChatEntitlementContextKeys.Setup.hidden = true` quando `!productService.defaultChatAgent`. |
| `onboardingVariationA.ts`, `defaultAccount.ts`, `extensionGalleryService.ts`, `extensionsWorkbenchService.ts`, `abstractExtensionManagementService.ts` | Muito baixo | Manter os guards contra `defaultChatAgent === undefined`. |
| `vs_code_editor_walkthrough.ts`, SVGs internos (`code-icon.svg`, `vscode-icon.svg`, `letterpress-*.svg`), `resources/**` | Muito baixo | Manter a versão Tarot (`git checkout --ours`). |
| `extensions/tarot-core/**`, `resources/tarot/**`, `docs/**`, `LICENSE`, `LICENSE-VSCODE-MIT.txt`, `NOTICE.md` | Nulo | Arquivos exclusivos do Tarot (em `LICENSE.txt` manter a GPL-3.0 do Tarot com `--ours`). |

## 3. Invariantes pós-merge (verificar antes de integrar)
- `product.json`: Open VSX em `extensionsGallery`; sem `defaultChatAgent`, `aiConfig`, `tasConfig`, `enableTelemetry: true`; sem URLs do Visual Studio Marketplace (`rg "marketplace.visualstudio|defaultChatAgent|enableTelemetry" product.json`).
- `extensions/copilot/` **continua no Git** (nunca deletar).
- Arquivos de contexto do fork preservados: `AGENTS.md`, bloco *Fork Override* no topo de `.github/copilot-instructions.md`, `.github/instructions/tarot-ide.instructions.md`, `.github/prompts/tarot-*.prompt.md`. Se o upstream alterou `AGENTS.md`/`copilot-instructions.md`, **mescle mantendo o override Tarot no topo** e o conteúdo novo da Microsoft abaixo.
- Se surgirem **novos** pontos de `src/vs/` que referenciem `defaultChatAgent`/Copilot sem guard, aplique o menor guard possível e registre em `docs/PROJECT_CONTEXT.md` (Seção 5) e na matriz.

## 4. Fechamento
- Atualize `docs/MIGRATION_PLAN.md` (versão base do Code - OSS, novos conflitos/regras aprendidos) e `docs/PROJECT_CONTEXT.md` (versão `1.xxx.x` e commit upstream base) em PT-BR.
- `git merge --no-ff` em `tarot-main`; **sem push** sem pedido. Remova a branch `sync/vscode-<TAG>` somente se o usuário pedir.
- Responda com: tag aplicada, conflitos resolvidos (arquivo → regra usada), comandos de validação executados e pendências.
