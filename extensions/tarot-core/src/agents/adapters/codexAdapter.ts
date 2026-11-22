/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { execSimple, resolveBinaryPath, spawnStreaming } from '../processRunner';
import { buildEffectivePrompt } from '../promptBuilder';
import { AgentAdapter, AgentEvent, AgentModelOption, AgentRunRequest, AgentStatus } from '../types';

export class CodexAdapter implements AgentAdapter {
	readonly id = 'codex' as const;
	readonly displayName = 'OpenAI Codex CLI';
	readonly binary = 'codex';
	readonly installHint = 'npm install -g @openai/codex';

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
		return [
			{ id: 'gpt-5-codex', label: 'GPT-5 Codex' },
			{ id: 'o3', label: 'OpenAI o3' },
			{ id: 'o4-mini', label: 'OpenAI o4-mini' },
		];
	}

	async run(request: AgentRunRequest, onEvent: (event: AgentEvent) => void, token: vscode.CancellationToken): Promise<void> {
		const resolvedPath = await resolveBinaryPath(this.binary, this.getConfiguredPath());
		if (!resolvedPath) {
			onEvent({ type: 'error', content: vscode.l10n.t("OpenAI Codex CLI ('codex') not found on PATH. Install with: {0}", this.installHint) });
			onEvent({ type: 'done' });
			return;
		}

		const prompt = buildEffectivePrompt(request);
		const args = ['exec', '--json'];
		if (request.model && request.model !== 'auto') {
			args.push('-m', request.model);
		}
		args.push(prompt);
		let emittedText = false;
		const stderrLines: string[] = [];

		onEvent({ type: 'status', content: vscode.l10n.t('Running OpenAI Codex CLI...') });

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
					if (this.handleJsonLine(trimmed, onEvent)) {
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
					content: stderrLines.join('\n') || vscode.l10n.t('Codex exited with code {0}.', exitCode ?? vscode.l10n.t('unknown')),
				});
			}
		} catch (err) {
			onEvent({ type: 'error', content: err instanceof Error ? err.message : String(err) });
		} finally {
			onEvent({ type: 'done' });
		}
	}

	private handleJsonLine(line: string, onEvent: (event: AgentEvent) => void): boolean {
		if (!line.startsWith('{')) {
			return false;
		}
		try {
			const payload = JSON.parse(line) as Record<string, unknown>;
			const type = typeof payload.type === 'string' ? payload.type : '';
			const item = payload.item as { type?: string; text?: string; command?: string } | undefined;

			if (type === 'item.completed' && item) {
				if (item.type === 'agent_message' && item.text) {
					onEvent({ type: 'text', content: item.text });
					return true;
				}
				if (item.type === 'command_execution' && item.command) {
					// Codex only reports `item.completed`, so by the time Tarot hears about this
					// tool call it has already finished — start/end fire back to back.
					const toolName = `shell: ${item.command}`;
					onEvent({ type: 'tool_start', toolName });
					onEvent({ type: 'tool_end', toolName });
				}
			}

			if (type === 'error' && typeof payload.message === 'string') {
				onEvent({ type: 'error', content: payload.message });
				return true;
			}

			return false;
		} catch {
			return false;
		}
	}
}
