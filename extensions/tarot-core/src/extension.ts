/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Tarot IDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
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
