/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { computeCompletedTaskLineRanges } from './taskParser';

function isSpecTasksDocument(doc: vscode.TextDocument): boolean {
	if (doc.uri.scheme !== 'file') {
		return false;
	}
	const normalized = doc.uri.fsPath.replace(/\\/g, '/');
	return normalized.includes('/.tarot/specs/') && normalized.endsWith('/tasks.md');
}

/**
 * Renders Kiro-style vertical green indicator bars on the left margin of completed task blocks
 * in `.tarot/specs/<slug>/tasks.md`. 100% Extension-First via TextEditorDecorationType.
 */
export class SpecTaskDecorator implements vscode.Disposable {
	private readonly completedDecoration: vscode.TextEditorDecorationType;
	private readonly disposables: vscode.Disposable[] = [];

	constructor() {
		this.completedDecoration = vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
			borderWidth: '0 0 0 2px',
			borderStyle: 'solid',
			borderColor: '#4ADE80',
			light: {
				borderColor: '#16A34A',
			},
		});

		this.disposables.push(
			this.completedDecoration,
			vscode.window.onDidChangeActiveTextEditor(editor => {
				if (editor) {
					this.updateEditor(editor);
				}
			}),
			vscode.window.onDidChangeVisibleTextEditors(editors => {
				for (const ed of editors) {
					this.updateEditor(ed);
				}
			}),
			vscode.workspace.onDidChangeTextDocument(ev => {
				if (!isSpecTasksDocument(ev.document)) {
					return;
				}
				for (const ed of vscode.window.visibleTextEditors) {
					if (ed.document === ev.document) {
						this.updateEditor(ed);
					}
				}
			}),
		);

		for (const ed of vscode.window.visibleTextEditors) {
			this.updateEditor(ed);
		}
	}

	private updateEditor(editor: vscode.TextEditor): void {
		if (!isSpecTasksDocument(editor.document)) {
			editor.setDecorations(this.completedDecoration, []);
			return;
		}
		const blocks = computeCompletedTaskLineRanges(editor.document.getText());
		const ranges = blocks.map(b => new vscode.Range(b.startLine, 0, b.endLine, 0));
		editor.setDecorations(this.completedDecoration, ranges);
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
