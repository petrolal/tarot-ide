/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;

export function activate(context: vscode.ExtensionContext): void {
	outputChannel = vscode.window.createOutputChannel('Tarot IDE');
	outputChannel.appendLine('Tarot Core extension activated.');

	const welcomeCommand = vscode.commands.registerCommand('tarot.welcome', () => {
		vscode.window.showInformationMessage('Bem-vindo ao Tarot IDE! Extensão interna tarot-core ativa.');
	});

	context.subscriptions.push(outputChannel, welcomeCommand);
}

export function deactivate(): void {
	outputChannel?.dispose();
	outputChannel = undefined;
}
