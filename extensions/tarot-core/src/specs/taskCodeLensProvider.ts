/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
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

		for (const task of summary.tasks) {
			const range = new vscode.Range(task.lineIndex, 0, task.lineIndex, 0);
			if (task.completed) {
				lenses.push(
					new vscode.CodeLens(range, {
						title: vscode.l10n.t('✓ Completed'),
						command: '',
						tooltip: vscode.l10n.t('Task #{0} completed', task.index),
					}),
				);
			} else {
				lenses.push(
					new vscode.CodeLens(range, {
						title: vscode.l10n.t('▶ Run Task'),
						command: 'tarot.specs.runTask',
						arguments: [document.uri, task.lineIndex],
						tooltip: vscode.l10n.t('Run task #{0} with the active local agent', task.index),
					}),
					new vscode.CodeLens(range, {
						title: vscode.l10n.t('▶ Run Task with...'),
						command: 'tarot.specs.runTaskWith',
						arguments: [document.uri, task.lineIndex],
						tooltip: vscode.l10n.t('Pick which local agent (claude, agy, codex) runs task #{0}', task.index),
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
