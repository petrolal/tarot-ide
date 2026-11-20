/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { execSimple, resolveBinaryPath, spawnStreaming } from '../processRunner';
import { buildEffectivePrompt } from '../promptBuilder';
import { AgentAdapter, AgentEvent, AgentModelOption, AgentRunRequest, AgentStatus } from '../types';

export class AgyAdapter implements AgentAdapter {
	readonly id = 'agy' as const;
	readonly displayName = 'Antigravity CLI (agy)';
	readonly binary = 'agy';
	readonly installHint = 'Instale o Antigravity CLI (agy) e garanta que esteja no PATH.';

	constructor(private readonly getConfiguredPath: () => string) { }

	async detect(): Promise<AgentStatus> {
		const resolvedPath = await resolveBinaryPath(this.binary, this.getConfiguredPath());
		if (!resolvedPath) {
			return {
				id: this.id,
				displayName: this.displayName,
				binary: this.binary,
				available: false,
				installHint: this.installHint,
			};
		}

		try {
			const res = await execSimple(resolvedPath, ['--version']);
			const version = (res.stdout || res.stderr).split('\n')[0]?.trim();
			return {
				id: this.id,
				displayName: this.displayName,
				binary: this.binary,
				available: res.exitCode === 0,
				resolvedPath,
				version: version || 'installed',
				installHint: this.installHint,
				error: res.exitCode !== 0 ? (res.stderr || `Exited with code ${res.exitCode}`) : undefined,
			};
		} catch (err) {
			return {
				id: this.id,
				displayName: this.displayName,
				binary: this.binary,
				available: false,
				resolvedPath,
				installHint: this.installHint,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	async listModels(): Promise<readonly AgentModelOption[]> {
		const resolvedPath = await resolveBinaryPath(this.binary, this.getConfiguredPath());
		if (!resolvedPath) {
			return [];
		}
		try {
			const res = await execSimple(resolvedPath, ['models'], 10_000);
			if (res.exitCode !== 0) {
				return [];
			}
			const models: AgentModelOption[] = [];
			for (const rawLine of res.stdout.split('\n')) {
				const line = rawLine.trim();
				if (!line || line.toLowerCase().startsWith('fetching')) {
					continue;
				}
				const tabIdx = line.indexOf('\t');
				if (tabIdx > 0) {
					const id = line.slice(0, tabIdx).trim();
					const label = line.slice(tabIdx + 1).trim();
					if (id && label) {
						models.push({ id, label });
					}
				}
			}
			return models;
		} catch {
			return [];
		}
	}

	async run(request: AgentRunRequest, onEvent: (event: AgentEvent) => void, token: vscode.CancellationToken): Promise<void> {
		const resolvedPath = await resolveBinaryPath(this.binary, this.getConfiguredPath());
		if (!resolvedPath) {
			onEvent({ type: 'error', content: vscode.l10n.t("Antigravity CLI ('agy') not found on PATH.") });
			onEvent({ type: 'done' });
			return;
		}

		const prompt = buildEffectivePrompt(request);
		const args = ['--output-format', 'stream-json'];
		if (request.model && request.model !== 'auto') {
			args.push('--model', request.model);
		}
		if (request.effort && request.effort !== 'auto') {
			args.push('--effort', request.effort);
		}
		if (request.mode === 'plan' || request.mode === 'spec') {
			args.push('--mode', 'plan');
		} else if (request.autonomy === 'autopilot') {
			args.push('--mode', 'accept-edits');
		}
		args.push(`--print=${prompt}`);

		let emittedText = false;
		const stderrLines: string[] = [];

		onEvent({ type: 'status', content: vscode.l10n.t('Running Antigravity CLI (agy)...') });

		try {
			const exitCode = await spawnStreaming(resolvedPath, args, {
				cwd: request.cwd,
				timeoutMs: request.timeoutMs,
				token,
				onStdoutLine: line => {
					const trimmed = line.trim();
					if (!trimmed) {
						return;
					}
					if (this.handleStreamJsonLine(trimmed, onEvent)) {
						emittedText = true;
						return;
					}
					if (!trimmed.startsWith('{')) {
						emittedText = true;
						onEvent({ type: 'text', content: `${line}\n` });
					}
				},
				onStderrLine: line => {
					if (line.trim()) {
						stderrLines.push(line);
					}
				},
			});

			if (token.isCancellationRequested) {
				onEvent({ type: 'status', content: vscode.l10n.t('Execution cancelled.') });
			} else if (exitCode !== 0 && !emittedText) {
				onEvent({
					type: 'error',
					content: stderrLines.join('\n') || vscode.l10n.t('agy exited with code {0}.', exitCode ?? vscode.l10n.t('unknown')),
				});
			}
		} catch (err) {
			onEvent({ type: 'error', content: err instanceof Error ? err.message : String(err) });
		} finally {
			onEvent({ type: 'done' });
		}
	}

	private handleStreamJsonLine(line: string, onEvent: (event: AgentEvent) => void): boolean {
		if (!line.startsWith('{')) {
			return false;
		}
		try {
			const payload = JSON.parse(line) as Record<string, unknown>;
			const type = typeof payload.type === 'string' ? payload.type : '';

			if (type === 'assistant') {
				const message = payload.message as { content?: Array<{ type?: string; text?: string; name?: string }> } | undefined;
				let produced = false;
				for (const block of message?.content ?? []) {
					if (block.type === 'text' && block.text) {
						onEvent({ type: 'text', content: block.text });
						produced = true;
					} else if (block.type === 'tool_use' && block.name) {
						onEvent({ type: 'tool_start', toolName: block.name });
					}
				}
				return produced;
			}

			if (typeof payload.delta === 'string' && payload.delta.length > 0) {
				onEvent({ type: 'text', content: payload.delta });
				return true;
			}

			if (typeof payload.text === 'string' && payload.text.length > 0) {
				onEvent({ type: 'text', content: payload.text });
				return true;
			}

			if (type === 'tool_use' || type === 'tool_call') {
				const toolName = typeof payload.name === 'string' ? payload.name : (typeof payload.tool === 'string' ? payload.tool : 'tool');
				onEvent({ type: 'tool_start', toolName });
				return false;
			}

			if (type === 'error' && typeof payload.error === 'string') {
				onEvent({ type: 'error', content: payload.error });
				return true;
			}

			if (type === 'result' && typeof payload.result === 'string' && payload.result.length > 0) {
				onEvent({ type: 'text', content: payload.result });
				return true;
			}

			return false;
		} catch {
			return false;
		}
	}
}
