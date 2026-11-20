---
description: Fluxo para implementar uma nova funcionalidade isolada em extensions/tarot-core/ respeitando BYOA, CSP, Workspace Trust e as divergências Kiro × Tarot.
agent: agent
---

# Nova funcionalidade do Tarot IDE (isolada em `extensions/tarot-core/`)

Funcionalidade: `${input:feature:Descreva a funcionalidade (ex.: comando, view, adaptador, provedor #)}`

## 1. Contexto e enquadramento
1. Leia `AGENTS.md`, `docs/PROJECT_CONTEXT.md` (Seção 3) e `.github/instructions/tarot-ide.instructions.md`.
2. Verifique se a funcionalidade já está prevista em `docs/MIGRATION_PLAN.md`. Se pertencer a um marco pendente, **use o prompt `tarot-execute-milestone`** em vez deste.
3. Se espelha um recurso do Kiro, leia a seção correspondente em `docs/KIRO_ARCHITECTURE_REFERENCE.md` e a tabela *Divergências Kiro × Tarot* (BYOA: o Tarot só impõe o que passa por ele; o resto é *advisory*).

## 2. Regra Extension-First
- Implemente **somente** em `extensions/tarot-core/` (módulo novo em `src/<área>/` + registro em `extension.ts` e `package.json`).
- **Não** toque em `src/vs/`. Se for tecnicamente impossível via Extension API, pare, explique e proponha o menor diff possível; ele deve ser registrado em `docs/PROJECT_CONTEXT.md` (Seção 5) e na matriz de `docs/MIGRATION_PLAN.md`.

## 3. Requisitos de segurança (não negociáveis)
- **BYOA/CLIs**: `spawn(bin, args, { shell: false })` via `agents/processRunner.ts`; sem concatenar entrada do usuário em shell; cancelamento com `vscode.CancellationToken`; sem log/persistência de credenciais.
- **Workspace Trust**: antes de ler/executar qualquer coisa de `.tarot/` (hooks, agentes, steering, skills, MCP, workflows) cheque `vscode.workspace.isTrusted`; em não confiável, não carregue e informe ao usuário.
- **Permissões**: ações de escrita/shell passam pela política (`deny > ask > allow > evaluate`) quando o marco M3.8a existir; até lá, peça confirmação explícita para ações destrutivas.
- **Webviews**: CSP estrita com `nonce`; `textContent`/DOM seguro; **nunca `innerHTML`** com saída de LLM/CLI; recursos via `webview.asWebviewUri`.
- **Privacidade**: nada de telemetria Microsoft, `defaultChatAgent` ou URLs do Visual Studio Marketplace.

## 4. Implementação
- Lógica pura separada (sem `vscode`) + camada fina de integração; dependências por construtor; `Disposable`.
- UI: tokens `--vscode-*`, paleta Tarot Arcana Dark apenas como fallback; comandos prefixados `tarot.`; settings em `tarot.*` com schema em `package.json`; strings localizáveis em `package.nls.json`.
- Artefatos de usuário ficam em `.tarot/` (agnósticos de fornecedor).
- Escreva testes unitários da lógica pura (`extensions/tarot-core/src/test/*.test.ts`, `node --test`).

## 5. Verificar
```bash
pnpm exec gulp compile-extension:tarot-core
rg "innerHTML|shell:\s*true" extensions/tarot-core/src extensions/tarot-core/media
python3 -m json.tool extensions/tarot-core/package.json > /dev/null
```
Teste manual com `./scripts/code.sh` quando houver UI (sandbox do Chrome no Ubuntu 24.04: ver `docs/PROJECT_CONTEXT.md` Seção 7).

## 6. Documentar e entregar
- Atualize `docs/PROJECT_CONTEXT.md` (estrutura da Seção 6, casos de uso se aplicável) e `docs/MIGRATION_PLAN.md` quando a funcionalidade alterar o plano — em PT-BR.
- Commit atômico em `tarot-main` (código/commit em Inglês). Sem push sem pedido.
- Responda com: arquivos criados/alterados, como usar a funcionalidade, verificações executadas e limitações (*advisory*, dependências de CLI).
