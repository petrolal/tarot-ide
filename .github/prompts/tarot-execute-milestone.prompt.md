---
description: Executa o próximo marco pendente do docs/MIGRATION_PLAN.md (hoje M3.6.6) em extensions/tarot-core/, com testes, compilação e atualização de status.
agent: agent
---

# Executar o próximo marco do Tarot IDE

Marco alvo: `${input:milestone:Deixe vazio para o próximo pendente (hoje: M3.6.6)}`. Se vazio, escolha o **primeiro marco não concluído** da Fase 3 em `docs/MIGRATION_PLAN.md` (ordem: M3.6.6 → M3.6.7 → M3.7 → M3.8a → M3.8b → M3.8c → M3.9a → M3.9b → M3.9c → M3.10).

## 1. Ler antes de codar (obrigatório)
1. `AGENTS.md` e `docs/PROJECT_CONTEXT.md` (invariantes, Seção 3, Seção 5, Seção 6).
2. A seção completa do marco em `docs/MIGRATION_PLAN.md` (**Objetivo, Arquivos-alvo, Especificação, DoD**) e a tabela *Divergências Kiro × Tarot*.
3. `docs/KIRO_ARCHITECTURE_REFERENCE.md` (Seção 3 e Seção 4 correspondente ao tema do marco).
4. `.github/instructions/tarot-ide.instructions.md` e o código existente que o marco estende (`extensions/tarot-core/src/**`).
Confirme `git branch --show-current` = `tarot-main` e `git status` limpo (ou entenda as mudanças pendentes). Se o marco depender de outro não concluído, **pare e avise**.

## 2. Planejar
Liste (curto) os arquivos a criar/alterar, os contratos novos e como cada item do DoD será verificado. Se algo exigir `src/vs/`, justifique por que a Extension API não basta (regra Extension-First) — senão implemente em `extensions/tarot-core/`.

## 3. Implementar (modular, em `extensions/tarot-core/`)
- Módulos pequenos e coesos; lógica pura **sem importar `vscode`** (testável); serviços com dependências no construtor; `Disposable` e `CancellationToken`.
- Segurança BYOA: `spawn(bin, args, { shell: false })`; checar `vscode.workspace.isTrusted` antes de ler/executar `.tarot/`; Webviews com CSP + `nonce`, sem `innerHTML` com saída de LLM/CLI; nunca logar credenciais.
- UI: tokens `--vscode-*` e paleta Tarot Arcana Dark; strings de UI localizáveis quando aplicável.
- Registrar comandos/views/settings em `extensions/tarot-core/package.json` (e `package.nls.json`).
- Respeitar as divergências Kiro × Tarot (permissões *enforced* vs *advisory*, `send_message`/resume por adaptador, etc.).

## 4. Testes
- Crie/atualize testes unitários para a lógica pura do marco em `extensions/tarot-core/src/test/` (convenção: `*.test.ts`, executados com `node --test`; sem dependência de `vscode`). No M3.6.6 estabeleça a convenção e o comando de execução e documente-os em `docs/PROJECT_CONTEXT.md` (Seção 7).
- Cubra casos felizes, bordas e falhas (parsers, grafos, políticas, validadores).

## 5. Verificar
```bash
pnpm exec gulp compile-extension:tarot-core
node --test extensions/tarot-core/src/test/   # quando existir suíte
rg "innerHTML|shell:\s*true" extensions/tarot-core/src extensions/tarot-core/media
```
Valide JSON/manifestos alterados. Se tocou `src/vs/`: `node build/next/index.ts transpile` + `pnpm run typecheck-client` e registre o diff em `docs/PROJECT_CONTEXT.md` (Seção 5) e na matriz de `docs/MIGRATION_PLAN.md`. Valide visualmente com `./scripts/code.sh` quando houver mudança de UI e o ambiente permitir.

## 6. Fechar o marco
1. Em `docs/MIGRATION_PLAN.md`: marque cada item do DoD (`- [x]`), adicione `— ✅ Concluído` ao título do marco e atualize a tabela *Mapa Geral de Fases* (marcos concluídos / próximo marco).
2. Atualize `AGENTS.md` (status e "próximo marco") e, se aplicável, `docs/PROJECT_CONTEXT.md` (Seções 5–7, UCs).
3. Commit atômico em `tarot-main` (código em Inglês, ex.: `feat(tarot-core): implement M3.6.6 ...`); docs em PT-BR. **Não** faça push sem pedido.
4. Responda com: resumo do que foi feito, itens do DoD atendidos, comandos rodados e pendências/riscos.
