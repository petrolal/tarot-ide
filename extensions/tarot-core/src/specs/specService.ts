/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseTasksMarkdown, SpecTask, SpecTaskSummary } from './taskParser';

export type SpecCreationKind = 'feature-requirements-first' | 'feature-design-first' | 'bugfix';
export type SpecKind = 'feature' | 'bugfix';
export type SpecPhase = 'requirements' | 'bugfix' | 'design' | 'tasks';

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
			`## Correctness & Property-Based Testing (PBT)\n` +
			`- **Property 1**: ...\n` +
			`- **Edge Cases**: ...\n`,
			'utf8',
		);
		await fs.writeFile(
			tasksPath,
			`# Tasks — ${slug}\n\n` +
			`- [ ] 1. Definir contratos, tipos e estrutura base\n` +
			`- [ ] 2. Implementar lógica principal e integração na UI/API\n` +
			`- [ ] 3. Adicionar testes unitários / PBT e validar critérios EARS\n`,
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
			`Execute ONLY Task #${task.index}: "${task.title}"\n\n` +
			`Follow the Spec documents below strictly, keep changes focused on this task, and verify with build/tests when applicable.\n\n` +
			`${spec.contextText}`
		);
	}

	buildPhaseAdvancePrompt(spec: LoadedSpecContext, targetPhase: SpecPhase): string {
		const relDir = `.tarot/specs/${spec.slug}`;
		if (targetPhase === 'design') {
			return (
				`[Tarot Spec Phase — Design]\n` +
				`Based on the approved \`${spec.kind === 'bugfix' ? 'bugfix.md' : 'requirements.md'}\` in \`${relDir}/\`, ` +
				`update \`${relDir}/design.md\` with a concrete architecture, component interfaces, and Correctness / Property-Based Testing (PBT) invariants.\n\n` +
				`${spec.contextText}`
			);
		}
		if (targetPhase === 'tasks') {
			return (
				`[Tarot Spec Phase — Tasks]\n` +
				`Based on the approved design in \`${relDir}/design.md\`, ` +
				`update \`${relDir}/tasks.md\` with a discrete, dependency-ordered Markdown checklist (\`- [ ] 1. ...\`) ready to run task-by-task.\n\n` +
				`${spec.contextText}`
			);
		}
		if (targetPhase === 'requirements') {
			return (
				`[Tarot Spec Phase — Requirements (EARS)]\n` +
				`Refine \`${relDir}/requirements.md\` using strict EARS notation (WHEN ... THE SYSTEM SHALL ...) aligned with \`${relDir}/design.md\`.\n\n` +
				`${spec.contextText}`
			);
		}
		return (
			`[Tarot Spec Phase — Bugfix (EARS)]\n` +
			`Refine \`${relDir}/bugfix.md\` with the 3 EARS sections (Current Behavior, Expected Behavior, Unchanged Behavior).\n\n` +
			`${spec.contextText}`
		);
	}
}
