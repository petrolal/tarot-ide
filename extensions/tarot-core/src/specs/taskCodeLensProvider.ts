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
						title: '✓ Concluída',
						command: '',
						tooltip: `Tarefa #${task.index} concluída`,
					}),
				);
			} else {
				lenses.push(
					new vscode.CodeLens(range, {
						title: '▶ Run Task',
						command: 'tarot.specs.runTask',
						arguments: [document.uri, task.lineIndex],
						tooltip: `Executar tarefa #${task.index} com o agente local ativo`,
					}),
					new vscode.CodeLens(range, {
						title: '▶ Run Task with...',
						command: 'tarot.specs.runTaskWith',
						arguments: [document.uri, task.lineIndex],
						tooltip: `Escolher qual agente local (claude, agy, codex) executará a tarefa #${task.index}`,
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
