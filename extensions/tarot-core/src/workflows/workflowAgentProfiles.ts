/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

/**
 * Role prompts for the bundled workflow agents (`BUNDLED_WORKFLOW_AGENTS`), plus
 * prompt-composition and artifact-extraction helpers for BYOA CLIs.
 * Pure — zero `vscode` import so it is unit-testable via `node --test`.
 */
export const BUNDLED_WORKFLOW_AGENT_PROMPTS: Readonly<Record<string, string>> = {
	'wf-planner': 'Você atua como **wf-planner**: quebre o objetivo em um plano claro, objetivo e verificável com passos ordenados, critérios de aceite e riscos.',
	'wf-coder': 'Você atua como **wf-coder**: implemente as alterações solicitadas com código limpo, testes determinísticos e mínimo diff necessário.',
	'wf-design': 'Você atua como **wf-design**: elabore a arquitetura técnica, contratos, fluxos de dados e invariantes antes da implementação.',
	'wf-design-reviewer': 'Você atua como **wf-design-reviewer**: revise criticamente o design procurando lacunas, casos de borda, riscos de segurança e acoplamento desnecessário.',
	'wf-review-aggregator': 'Você atua como **wf-review-aggregator**: consolide múltiplos pareceres de revisão em uma lista priorizada e sem duplicatas.',
	'wf-pr-submitter': 'Você atua como **wf-pr-submitter**: prepare o resumo de evidências e PR com clareza, sem realizar merge automático.',
	'wf-pr-responder': 'Você atua como **wf-pr-responder**: responda aos comentários/revisões do PR aplicando as correções pedidas e verificando os checks.',
	'wf-auto-researcher': 'Você atua como **wf-auto-researcher**: investigue a hipótese no código/dados reais, registre evidências objetivas e proponha próximos passos.',
	'semantic_reviewer': 'Você atua como **semantic_reviewer**: faça revisão semântica focada em corretude lógica, segurança, regressões e aderência aos requisitos.',
	'wf-workflow-creator': 'Você atua como **wf-workflow-creator**: projete ou revise recipes de workflow válidas no schema oficial do Tarot.',
};

const SEND_MESSAGE_PROTOCOL_HINT = [
	'Protocolo de sinalização de Workflow:',
	'- Se precisar de entrada ou confirmação humana para prosseguir, emita uma linha: `[SEND_MESSAGE:warning] <pergunta objetiva>`',
	'- Se encontrar erro fatal que impeça continuar, emita: `[SEND_MESSAGE:error] <motivo>`',
	'- Opcionalmente, ao concluir com sucesso, emita: `[SEND_MESSAGE:success] <resumo curto>`',
].join('\n');

export function composeWorkflowStepPrompt(
	agentId: string,
	resolvedPrompt: string,
	declaredArtifacts?: readonly string[],
): string {
	const sections: string[] = [];
	const rolePrompt = BUNDLED_WORKFLOW_AGENT_PROMPTS[agentId];
	if (rolePrompt) {
		sections.push(rolePrompt);
	}
	sections.push(resolvedPrompt);
	sections.push(SEND_MESSAGE_PROTOCOL_HINT);
	if (declaredArtifacts && declaredArtifacts.length > 0) {
		const names = declaredArtifacts.join(', ');
		sections.push(
			`Artefatos declarados para este passo (${names}): para produzir um artefato consumível por passos seguintes, envolva o conteúdo em:\n`
			+ `[ARTIFACT:<nome>]\n...\n[/ARTIFACT]`,
		);
	}
	return sections.join('\n\n');
}

/**
 * Extracts `[ARTIFACT:<name>]...[/ARTIFACT]` blocks from a workflow step's stdout so
 * downstream templates (`{{artifacts.<name>}}`) resolve at runtime.
 */
export function extractArtifactsFromOutput(
	output: string,
	declaredArtifacts?: readonly string[],
): Record<string, string> {
	const artifacts: Record<string, string> = {};
	const allowed = declaredArtifacts && declaredArtifacts.length > 0 ? new Set(declaredArtifacts) : undefined;
	const regex = /\[ARTIFACT:([a-zA-Z0-9._-]+)\]\s*\n?([\s\S]*?)\n?\[\/ARTIFACT\]/g;
	for (const match of output.matchAll(regex)) {
		const name = match[1].trim();
		const value = match[2].trim();
		if (!name || !value) {
			continue;
		}
		if (!allowed || allowed.has(name)) {
			artifacts[name] = value;
		}
	}
	return artifacts;
}
