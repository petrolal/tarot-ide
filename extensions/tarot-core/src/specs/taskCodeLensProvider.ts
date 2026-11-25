/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { computeTaskCheckpointKey } from './specTaskCheckpoints';
import { parseTasksMarkdown } from './taskParser';

export class SpecTaskCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
	private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

	refresh(): void {
		this._onDidChangeCodeLenses.fire();
	}

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const summary = parseTasksMarkdown(document.getText());
		const lenses: vscode.CodeLens[] = [];

		if (summary.total > 0) {
			const topRange = new vscode.Range(0, 0, 0, 0);
			lenses.push(
				new vscode.CodeLens(topRange, {
					title: vscode.l10n.t('▶ Run all Tasks'),
					command: 'tarot.specs.runAllTasks',
					arguments: [document.uri],
					tooltip: vscode.l10n.t('Run every pending, mandatory task in dependency-ordered waves'),
				}),
				new vscode.CodeLens(topRange, {
					title: vscode.l10n.t('↻ Sync Files'),
					command: 'tarot.specs.syncFiles',
					arguments: [document.uri],
					tooltip: vscode.l10n.t('Regenerate tasks.md from requirements.md/design.md without losing completed tasks'),
				}),
			);
		}

		for (const task of summary.tasks) {
			const range = new vscode.Range(task.lineIndex, 0, task.lineIndex, 0);
			const taskKey = computeTaskCheckpointKey(task);
			if (task.completed) {
				lenses.push(
					new vscode.CodeLens(range, {
						title: vscode.l10n.t('✓ Task completed'),
						command: '',
						tooltip: vscode.l10n.t('Task #{0} completed', task.index),
					}),
					new vscode.CodeLens(range, {
						title: vscode.l10n.t('↺ View changes'),
						command: 'tarot.specs.viewTaskChanges',
						arguments: [document.uri, task.lineIndex, taskKey, String(task.index)],
						tooltip: vscode.l10n.t('Show the isolated diff produced by task #{0}', task.index),
					}),
				);
			} else {
				const optionalSuffix = task.optional ? vscode.l10n.t(' (optional)') : '';
				lenses.push(
					new vscode.CodeLens(range, {
						title: vscode.l10n.t('▶ Run Task'),
						command: 'tarot.specs.runTask',
						arguments: [document.uri, task.lineIndex],
						tooltip: vscode.l10n.t('Run task #{0}{1} with the active local agent', task.index, optionalSuffix),
					}),
					new vscode.CodeLens(range, {
						title: vscode.l10n.t('▶ Run Task with...'),
						command: 'tarot.specs.runTaskWith',
						arguments: [document.uri, task.lineIndex],
						tooltip: vscode.l10n.t('Pick which local agent (claude, agy, codex) runs task #{0}{1}', task.index, optionalSuffix),
					}),
				);
			}
		}

		return lenses;
	}

	dispose(): void {
		this._onDidChangeCodeLenses.dispose();
	}
}
