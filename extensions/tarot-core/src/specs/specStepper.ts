/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { computeSpecStepperSteps, SpecKind } from './specService';

const SPEC_FILES = new Set(['requirements.md', 'bugfix.md', 'design.md', 'tasks.md']);

/**
 * Renders a Kiro-style clickable stepper at line 0 of every Spec Markdown file:
 * `📋 <slug> | ● 1 Requirements › 2 Design › 3 Task list | 🔍 Analyze Requirements | 💬 Review`
 */
export class SpecStepperCodeLensProvider implements vscode.CodeLensProvider {
	private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

	refresh(): void {
		this._onDidChangeCodeLenses.fire();
	}

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const normalized = document.uri.fsPath.replace(/\\/g, '/');
		if (!normalized.includes('/.tarot/specs/')) {
			return [];
		}
		const fileName = path.basename(document.uri.fsPath);
		if (!SPEC_FILES.has(fileName)) {
			return [];
		}

		const specDir = path.dirname(document.uri.fsPath);
		const slug = path.basename(specDir);
		const kind: SpecKind = fs.existsSync(path.join(specDir, 'bugfix.md')) ? 'bugfix' : 'feature';
		const steps = computeSpecStepperSteps(fileName, kind, false);
		const topRange = new vscode.Range(0, 0, 0, 0);
		const lenses: vscode.CodeLens[] = [];

		for (const step of steps) {
			const targetPath = path.join(specDir, step.fileName);
			const marker = step.active ? '● ' : '';
			const prefix = step.index === 1 ? `📋 ${slug} · ` : '› ';
			lenses.push(
				new vscode.CodeLens(topRange, {
					title: `${prefix}${marker}${step.index} ${step.label}`,
					tooltip: vscode.l10n.t('Open {0} ({1})', step.fileName, slug),
					command: 'tarot.specs.openPhase',
					arguments: [targetPath],
				}),
			);
		}

		if (fileName === 'requirements.md' || fileName === 'bugfix.md') {
			lenses.push(
				new vscode.CodeLens(topRange, {
					title: vscode.l10n.t('$(search) Analyze Requirements'),
					tooltip: vscode.l10n.t('Check for logical inconsistencies, ambiguities, and gaps before Design'),
					command: 'tarot.specs.analyzeRequirements',
					arguments: [specDir],
				}),
			);
		}

		if (fileName === 'requirements.md' || fileName === 'bugfix.md' || fileName === 'design.md') {
			lenses.push(
				new vscode.CodeLens(topRange, {
					title: vscode.l10n.t('$(comment-discussion) Review'),
					tooltip: vscode.l10n.t('Add a review comment on the current selection or send queued comments to Tarot Agent'),
					command: 'tarot.specs.markdownReview.add',
				}),
			);
		}

		return lenses;
	}

	dispose(): void {
		this._onDidChangeCodeLenses.dispose();
	}
}
