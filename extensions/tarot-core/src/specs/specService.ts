/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseTasksMarkdown, SpecTask, SpecTaskSummary } from './taskParser';

export type SpecCreationKind = 'feature-requirements-first' | 'feature-design-first' | 'bugfix' | 'quick-spec';
export type SpecKind = 'feature' | 'bugfix';
export type SpecPhase = 'requirements' | 'bugfix' | 'design' | 'tasks';

export interface SpecStepperStep {
	readonly index: number;
	readonly phase: SpecPhase;
	readonly fileName: string;
	readonly label: string;
	readonly active: boolean;
}

export interface PbtCounterExampleInfo {
	readonly counterExample: string;
	readonly error?: string;
}

/**
 * Computes the ordered Kiro-style stepper phases for a Spec document.
 * Pure helper (no `vscode` dependency) for unit testing.
 */
export function computeSpecStepperSteps(
	activeFileName: string,
	kind: SpecKind,
	designFirst = false,
): readonly SpecStepperStep[] {
	const base: ReadonlyArray<{ phase: SpecPhase; fileName: string; label: string }> = kind === 'bugfix'
		? [
			{ phase: 'bugfix', fileName: 'bugfix.md', label: 'Bugfix' },
			{ phase: 'design', fileName: 'design.md', label: 'Design' },
			{ phase: 'tasks', fileName: 'tasks.md', label: 'Task list' },
		]
		: designFirst
			? [
				{ phase: 'design', fileName: 'design.md', label: 'Design' },
				{ phase: 'requirements', fileName: 'requirements.md', label: 'Requirements' },
				{ phase: 'tasks', fileName: 'tasks.md', label: 'Task list' },
			]
			: [
				{ phase: 'requirements', fileName: 'requirements.md', label: 'Requirements' },
				{ phase: 'design', fileName: 'design.md', label: 'Design' },
				{ phase: 'tasks', fileName: 'tasks.md', label: 'Task list' },
			];

	return base.map((step, idx) => ({
		...step,
		index: idx + 1,
		active: step.fileName === activeFileName,
	}));
}

/**
 * Extracts a Property-Based Testing (PBT) `Counter-example:` + optional `Error:` block
 * from an agent transcript message. Pure helper for unit testing and UI rendering.
 */
export function parsePbtCounterExample(text: string): PbtCounterExampleInfo | undefined {
	const ceMatch = text.match(/Counter-?example:\s*([^\n]+(?:\n(?!Error:|#|---|\n)[^\n]+)*)/i);
	if (!ceMatch) {
		return undefined;
	}
	const errMatch = text.match(/Error:\s*([^\n]+)/i);
	return {
		counterExample: ceMatch[1].trim(),
		error: errMatch?.[1]?.trim(),
	};
}

export interface SpecInfo {
	readonly slug: string;
	readonly dirPath: string;
	readonly kind: SpecKind;
	readonly files: readonly string[];
	readonly taskSummary: SpecTaskSummary;
}

export interface LoadedSpecContext {
	readonly slug: string;
	readonly dirPath: string;
	readonly kind: SpecKind;
	readonly contextText: string;
	readonly taskSummary: SpecTaskSummary;
}

export class TarotSpecService {
	getSpecsRoot(workspaceRoot: string): string {
		return path.join(workspaceRoot, '.tarot', 'specs');
	}

	async listSpecs(workspaceRoot: string): Promise<SpecInfo[]> {
		const root = this.getSpecsRoot(workspaceRoot);
		try {
			const entries = await fs.readdir(root, { withFileTypes: true });
			const dirs = entries.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
			const specs: SpecInfo[] = [];

			for (const dir of dirs) {
				const dirPath = path.join(root, dir.name);
				const candidateFiles = ['requirements.md', 'bugfix.md', 'design.md', 'tasks.md'];
				const existing: string[] = [];
				let taskSummary: SpecTaskSummary = { total: 0, done: 0, tasks: [] };

				for (const fileName of candidateFiles) {
					const fullPath = path.join(dirPath, fileName);
					try {
						const content = await fs.readFile(fullPath, 'utf8');
						existing.push(fileName);
						if (fileName === 'tasks.md') {
							taskSummary = parseTasksMarkdown(content);
						}
					} catch {
						// File optional
					}
				}

				const kind: SpecKind = existing.includes('bugfix.md') ? 'bugfix' : 'feature';
				specs.push({
					slug: dir.name,
					dirPath,
					kind,
					files: existing,
					taskSummary,
				});
			}

			return specs;
		} catch {
			return [];
		}
	}

	async createSpec(
		workspaceRoot: string,
		slug: string,
		creationKind: SpecCreationKind,
	): Promise<{ dirPath: string; entryFilePath: string }> {
		const dirPath = path.join(this.getSpecsRoot(workspaceRoot), slug);
		await fs.mkdir(dirPath, { recursive: true });

		const designPath = path.join(dirPath, 'design.md');
		const tasksPath = path.join(dirPath, 'tasks.md');

		if (creationKind === 'bugfix') {
			const bugfixPath = path.join(dirPath, 'bugfix.md');
			await fs.writeFile(
				bugfixPath,
				`# Bugfix Spec — ${slug}\n\n` +
				`## Current Behavior (Defect)\n` +
				`- WHEN [condição que dispara o bug] THEN the system [descreva o comportamento incorreto atual].\n\n` +
				`## Expected Behavior (Correct)\n` +
				`- WHEN [condição que dispara o bug] THEN the system SHALL [descreva o comportamento esperado].\n\n` +
				`## Unchanged Behavior (Regression Prevention)\n` +
				`- WHEN [fluxo existente relacionado] THEN the system SHALL CONTINUE TO [comportamento que não pode regredir].\n`,
				'utf8',
			);
			await fs.writeFile(
				designPath,
				`# Root Cause & Fix Design — ${slug}\n\n` +
				`## Root Cause Analysis\n- Módulo/arquivo afetado:\n- Causa raiz:\n\n` +
				`## Fix Strategy\n- Alterações mínimas propostas:\n\n` +
				`## Correctness & Property-Based Testing (PBT)\n` +
				`- **Invariante 1**: Para qualquer entrada válida X, o sistema deve preservar Y.\n` +
				`- **Teste de regressão**: Reproduzir o defeito antes do fix e validar que passa após o fix.\n`,
				'utf8',
			);
			await fs.writeFile(
				tasksPath,
				`# Tasks — ${slug}\n\n` +
				`- [ ] 1. Escrever teste que reproduz o defeito descrito em bugfix.md\n` +
				`- [ ] 2. Implementar a correção conforme design.md\n` +
				`- [ ] 3. Validar invariantes e garantir que o comportamento inalterado não regrediu\n`,
				'utf8',
			);
			return { dirPath, entryFilePath: bugfixPath };
		}

		const reqPath = path.join(dirPath, 'requirements.md');
		await fs.writeFile(
			reqPath,
			`# Requirements — ${slug}\n\n` +
			`## User Stories\n` +
			`- Como usuário, eu quero ..., para que ...\n\n` +
			`## Acceptance Criteria (EARS Notation)\n` +
			`- WHEN [evento / condição] THE SYSTEM SHALL [comportamento esperado mensurável].\n` +
			`- IF [condição de erro / borda] THEN THE SYSTEM SHALL [tratamento seguro esperado].\n`,
			'utf8',
		);
		await fs.writeFile(
			designPath,
			`# Technical Design — ${slug}\n\n` +
			`## Architecture & Data Flow\n- ...\n\n` +
			`## Components & Interfaces\n- ...\n\n` +
			`## Boundary & Contract Tests (PBT / Integration — preserved across rewrites)\n` +
			`- **Property 1**: ...\n` +
			`- **Integration / Edge Cases**: ...\n\n` +
			`## Implementation Unit Tests (disposable with implementation)\n` +
			`- ...\n`,
			'utf8',
		);
		await fs.writeFile(
			tasksPath,
			`# Tasks — ${slug}\n\n` +
			`- [ ] 1. Definir contratos, tipos e estrutura base\n` +
			`- [ ] 2. Implementar lógica principal e integração na UI/API\n` +
			`- [ ] 3. Adicionar testes de contrato/fronteira (PBT e integração) validando os critérios EARS\n` +
			`- [ ] 4. *Adicionar testes unitários de detalhe e documentação complementar\n`,
			'utf8',
		);

		return {
			dirPath,
			entryFilePath: creationKind === 'feature-design-first' ? designPath : reqPath,
		};
	}

	async loadSpecContext(specDir: string): Promise<LoadedSpecContext> {
		const slug = path.basename(specDir);
		const files = ['requirements.md', 'bugfix.md', 'design.md', 'tasks.md'];
		const sections: string[] = [];
		let kind: SpecKind = 'feature';
		let taskSummary: SpecTaskSummary = { total: 0, done: 0, tasks: [] };

		for (const fileName of files) {
			const fullPath = path.join(specDir, fileName);
			try {
				const content = await fs.readFile(fullPath, 'utf8');
				if (fileName === 'bugfix.md') {
					kind = 'bugfix';
				}
				if (fileName === 'tasks.md') {
					taskSummary = parseTasksMarkdown(content);
				}
				sections.push(`## ${fileName}\n${content.trim()}`);
			} catch {
				// Optional
			}
		}

		return {
			slug,
			dirPath: specDir,
			kind,
			contextText: sections.join('\n\n'),
			taskSummary,
		};
	}

	buildTaskExecutionPrompt(spec: LoadedSpecContext, task: SpecTask): string {
		return (
			`[Tarot Spec Execution — ${spec.slug} (${spec.kind})]\n` +
			`Execute APENAS a Tarefa #${task.index}: "${task.title}"\n\n` +
			`Siga estritamente os documentos da Spec abaixo, mantenha as alterações focadas nesta tarefa e valide com build/testes quando aplicável.\n\n` +
			`${spec.contextText}`
		);
	}

	buildPhaseAdvancePrompt(spec: LoadedSpecContext, targetPhase: SpecPhase): string {
		const relDir = `.tarot/specs/${spec.slug}`;
		if (targetPhase === 'design') {
			return (
				`[Tarot Spec Phase — Design]\n` +
				`Com base no \`${spec.kind === 'bugfix' ? 'bugfix.md' : 'requirements.md'}\` aprovado em \`${relDir}/\`, ` +
				`atualize \`${relDir}/design.md\` com uma arquitetura concreta, interfaces de componentes e invariantes de Corretude / Property-Based Testing (PBT).\n\n` +
				`${spec.contextText}`
			);
		}
		if (targetPhase === 'tasks') {
			return (
				`[Tarot Spec Phase — Tasks]\n` +
				`Com base no design aprovado em \`${relDir}/design.md\`, ` +
				`atualize \`${relDir}/tasks.md\` com uma checklist Markdown discreta, ordenada por dependência (\`- [ ] 1. ...\`), pronta para executar tarefa a tarefa.\n\n` +
				`${spec.contextText}`
			);
		}
		if (targetPhase === 'requirements') {
			return (
				`[Tarot Spec Phase — Requirements (EARS)]\n` +
				`Refine \`${relDir}/requirements.md\` usando notação EARS estrita (WHEN ... THE SYSTEM SHALL ...) alinhada com \`${relDir}/design.md\`.\n\n` +
				`${spec.contextText}`
			);
		}
		return (
			`[Tarot Spec Phase — Bugfix (EARS)]\n` +
			`Refine \`${relDir}/bugfix.md\` com as 3 seções EARS (Current Behavior, Expected Behavior, Unchanged Behavior).\n\n` +
			`${spec.contextText}`
		);
	}

	buildAnalyzeRequirementsPrompt(spec: LoadedSpecContext): string {
		const targetFile = spec.kind === 'bugfix' ? 'bugfix.md' : 'requirements.md';
		return (
			`[Tarot Spec — Analyze Requirements (${spec.slug})]\n` +
			`Analise criticamente \`${targetFile}\` em \`.tarot/specs/${spec.slug}/\` ANTES de avançar para o Design.\n` +
			`Identifique e liste de forma objetiva:\n` +
			`1. Inconsistências lógicas ou restrições conflitantes;\n` +
			`2. Ambiguidades nos critérios EARS (WHEN ... THE SYSTEM SHALL ...);\n` +
			`3. Lacunas de borda, segurança, tratamento de erro ou regressão;\n` +
			`4. Sugestões concretas de reescrita para cada ponto encontrado.\n\n` +
			`${spec.contextText}`
		);
	}

	buildQuickSpecPrompt(spec: LoadedSpecContext, description: string): string {
		const relDir = `.tarot/specs/${spec.slug}`;
		return (
			`[Tarot Quick Spec — ${spec.slug}]\n` +
			`Gere diretamente os 3 artefatos da Spec em \`${relDir}/\` sem aguardar portões de aprovação intermediários:\n` +
			`1. \`${relDir}/requirements.md\` (User Stories + critérios de aceite em notação EARS);\n` +
			`2. \`${relDir}/design.md\` (arquitetura, interfaces e seção separada de testes de contrato/fronteira PBT vs. testes unitários);\n` +
			`3. \`${relDir}/tasks.md\` (checklist ordenada \`- [ ] 1. ...\` pronta para execução, marcando tarefas opcionais com \`*\`).\n\n` +
			`Pedido do usuário:\n${description}\n\n` +
			`${spec.contextText}`
		);
	}

	buildSyncFilesPrompt(spec: LoadedSpecContext): string {
		const relDir = `.tarot/specs/${spec.slug}`;
		return (
			`[Tarot Spec — Sync Files (${spec.slug})]\n` +
			`\`requirements.md\`/\`design.md\` evoluíram desde a última geração de \`${relDir}/tasks.md\`. ` +
			`Atualize \`${relDir}/tasks.md\` para refletir o estado atual:\n` +
			`1. Preserve EXATAMENTE o texto das tarefas já concluídas (\`- [x] ...\`) que ainda fazem sentido, na mesma ordem relativa;\n` +
			`2. Adicione tarefas novas para requisitos/design ainda não cobertos, marcando opcionais com \`*\` (ex.: \`- [ ] 5. *Tarefa opcional\`);\n` +
			`3. Mantenha \`_Requirements: x.y_\` em cada tarefa e, quando houver dependência explícita entre tarefas independentes, anote \`_Depends: <número>_\`;\n` +
			`4. Não remova tarefas concluídas mesmo que o escopo tenha mudado — se não fizerem mais sentido, apenas deixe-as no final sob um comentário.\n\n` +
			`${spec.contextText}`
		);
	}

	buildGenerateSpecFromChatPrompt(slug: string, transcript: string): string {
		const relDir = `.tarot/specs/${slug}`;
		return (
			`[Tarot Generate Spec from Session — ${slug}]\n` +
			`Transforme o contexto da conversa abaixo em uma Spec formal em \`${relDir}/\`:\n` +
			`- Preencha \`${relDir}/requirements.md\` em notação EARS (WHEN ... THE SYSTEM SHALL ...);\n` +
			`- Preencha \`${relDir}/design.md\` separando testes de contrato/fronteira (PBT/integração) de testes unitários;\n` +
			`- Preencha \`${relDir}/tasks.md\` com checklist executável.\n\n` +
			`Contexto da sessão:\n${transcript}`
		);
	}
}
