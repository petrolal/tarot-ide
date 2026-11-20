/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { execSimple, resolveBinaryPath } from '../agents/processRunner';
import { AgentRuntimeManager } from '../agents/runtimeManager';
import { getTarotConfig } from '../config/tarotConfig';

export interface ChangedFileInfo {
	readonly relativePath: string;
	readonly status: 'M' | 'A' | 'D' | 'U';
	readonly added: number;
	readonly removed: number;
}

export const TAROT_GIT_HEAD_SCHEME = 'tarot-git-head';

export class TarotGitHeadContentProvider implements vscode.TextDocumentContentProvider {
	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!cwd) {
			return '';
		}
		const gitBin = await resolveBinaryPath('git');
		if (!gitBin) {
			return '';
		}
		const relPath = uri.path.replace(/^\/+/, '');
		const res = await execSimple(gitBin, ['-C', cwd, 'show', `HEAD:${relPath}`], 8000);
		return res.exitCode === 0 ? res.stdout : '';
	}
}

export class TarotGitReviewService {
	async getChangedFiles(cwd: string): Promise<ChangedFileInfo[]> {
		const gitBin = await resolveBinaryPath('git');
		if (!gitBin) {
			return [];
		}

		const statusRes = await execSimple(gitBin, ['-C', cwd, 'status', '--porcelain'], 6000);
		if (statusRes.exitCode !== 0 || !statusRes.stdout.trim()) {
			return [];
		}

		const numstatMap = new Map<string, { added: number; removed: number }>();
		for (const args of [['-C', cwd, 'diff', '--numstat'], ['-C', cwd, 'diff', '--cached', '--numstat']]) {
			const res = await execSimple(gitBin, args, 6000);
			if (res.exitCode !== 0) {
				continue;
			}
			for (const line of res.stdout.split(/\r?\n/)) {
				const parts = line.split('\t');
				if (parts.length < 3) {
					continue;
				}
				const added = Number.parseInt(parts[0], 10) || 0;
				const removed = Number.parseInt(parts[1], 10) || 0;
				const file = parts[2].trim();
				const prev = numstatMap.get(file) ?? { added: 0, removed: 0 };
				numstatMap.set(file, { added: prev.added + added, removed: prev.removed + removed });
			}
		}

		const files: ChangedFileInfo[] = [];
		for (const line of statusRes.stdout.split(/\r?\n/)) {
			if (line.length < 4) {
				continue;
			}
			const code = line.slice(0, 2);
			let rel = line.slice(3).trim();
			if (rel.includes(' -> ')) {
				rel = rel.split(' -> ').pop()!.trim();
			}
			// Skip internal .tarot session/checkpoint noise
			if (rel.startsWith('.tarot/sessions/') || rel.startsWith('.tarot/checkpoints/')) {
				continue;
			}

			let status: ChangedFileInfo['status'] = 'M';
			if (code === '??') {
				status = 'U';
			} else if (code.includes('A')) {
				status = 'A';
			} else if (code.includes('D')) {
				status = 'D';
			}

			const stats = numstatMap.get(rel) ?? { added: 0, removed: 0 };
			files.push({
				relativePath: rel,
				status,
				added: stats.added,
				removed: stats.removed,
			});
		}

		return files.slice(0, 50);
	}

	async openFileDiff(cwd: string, relativePath: string, status: ChangedFileInfo['status']): Promise<void> {
		const workingUri = vscode.Uri.file(path.join(cwd, relativePath));
		if (status === 'U' || status === 'A') {
			const doc = await vscode.workspace.openTextDocument(workingUri);
			await vscode.window.showTextDocument(doc, { preview: true });
			return;
		}
		const headUri = vscode.Uri.from({
			scheme: TAROT_GIT_HEAD_SCHEME,
			path: `/${relativePath}`,
		});
		await vscode.commands.executeCommand(
			'vscode.diff',
			headUri,
			workingUri,
			`${relativePath} (HEAD ↔ Working Tree)`,
		);
	}

	async revertFile(cwd: string, relativePath: string, status: ChangedFileInfo['status']): Promise<boolean> {
		const answer = await vscode.window.showWarningMessage(
			`Reverter todas as alterações em "${relativePath}"?`,
			{ modal: true },
			'Reverter',
		);
		if (answer !== 'Reverter') {
			return false;
		}

		if (status === 'U') {
			await fs.rm(path.join(cwd, relativePath), { force: true });
			return true;
		}

		const gitBin = await resolveBinaryPath('git');
		if (!gitBin) {
			return false;
		}
		const res = await execSimple(gitBin, ['-C', cwd, 'checkout', '--', relativePath], 8000);
		if (res.exitCode !== 0) {
			vscode.window.showErrorMessage(`Não foi possível reverter ${relativePath}: ${res.stderr.trim()}`);
			return false;
		}
		return true;
	}

	async generateAiCommitMessage(
		cwd: string,
		runtimeManager: AgentRuntimeManager,
		outputChannel: vscode.OutputChannel,
	): Promise<void> {
		const gitBin = await resolveBinaryPath('git');
		if (!gitBin) {
			vscode.window.showWarningMessage('Git não encontrado no PATH.');
			return;
		}

		let diffRes = await execSimple(gitBin, ['-C', cwd, 'diff', '--cached'], 8000);
		let diffText = diffRes.stdout.trim();
		if (!diffText) {
			diffRes = await execSimple(gitBin, ['-C', cwd, 'diff'], 8000);
			diffText = diffRes.stdout.trim();
		}
		if (!diffText) {
			vscode.window.showInformationMessage('Nenhuma alteração Git encontrada para gerar mensagem de commit.');
			return;
		}

		const agentId = runtimeManager.getActiveAgentId();
		const adapter = runtimeManager.getAdapter(agentId);
		if (!adapter) {
			vscode.window.showWarningMessage('Nenhum agente local instalado (claude, agy, codex) para gerar commit message.');
			return;
		}

		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.SourceControl,
				title: `Tarot IDE: gerando commit message com ${adapter.displayName}...`,
				cancellable: true,
			},
			async (_progress, token) => {
				let generated = '';
				const truncatedDiff = diffText.slice(0, 14_000);
				const prompt =
					`Generate a single concise Conventional Commit message (e.g. "feat(scope): summary", subject <= 72 chars) for the git diff below.\n` +
					`Return ONLY the raw commit message text with no markdown code fences or extra commentary.\n\n` +
					`${truncatedDiff}`;

				outputChannel.appendLine(`[GitReview] Generating commit message with ${adapter.id}`);
				await adapter.run(
					{
						prompt,
						mode: 'plan',
						autonomy: 'supervised',
						cwd,
						timeoutMs: Math.min(getTarotConfig().timeoutMs, 60_000),
					},
					event => {
						if (event.type === 'text' && event.content) {
							generated += event.content;
						}
					},
					token,
				);

				const cleaned = generated
					.trim()
					.replace(/^```[a-z]*\r?\n?/i, '')
					.replace(/\r?\n?```$/i, '')
					.trim();

				if (!cleaned) {
					vscode.window.showWarningMessage('O agente não retornou uma mensagem de commit.');
					return;
				}

				const gitExt = vscode.extensions.getExtension<{ getAPI(version: number): { repositories: Array<{ inputBox: { value: string } }> } }>('vscode.git');
				const repo = gitExt?.isActive ? gitExt.exports.getAPI(1).repositories[0] : undefined;
				if (repo) {
					repo.inputBox.value = cleaned;
				} else {
					await vscode.env.clipboard.writeText(cleaned);
					vscode.window.showInformationMessage(`Mensagem de commit copiada para a área de transferência: "${cleaned.split('\n')[0]}"`);
				}
			},
		);
	}
}
