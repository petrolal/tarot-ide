/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { execSimple, resolveBinaryPath, spawnStreaming } from '../processRunner';
import { buildEffectivePrompt } from '../promptBuilder';
import { AgentAdapter, AgentEvent, AgentModelOption, AgentRunRequest, AgentStatus } from '../types';

export class ClaudeCodeAdapter implements AgentAdapter {
	readonly id = 'claude' as const;
	readonly displayName = 'Claude Code';
	readonly binary = 'claude';
	readonly installHint = 'npm install -g @anthropic-ai/claude-code';

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
			{ id: 'sonnet', label: 'Claude Sonnet' },
			{ id: 'opus', label: 'Claude Opus' },
			{ id: 'haiku', label: 'Claude Haiku' },
		];
	}

	async run(request: AgentRunRequest, onEvent: (event: AgentEvent) => void, token: vscode.CancellationToken): Promise<void> {
		const resolvedPath = await resolveBinaryPath(this.binary, this.getConfiguredPath());
		if (!resolvedPath) {
			onEvent({ type: 'error', content: vscode.l10n.t("Claude Code CLI ('claude') not found on PATH. Install with: {0}", this.installHint) });
			onEvent({ type: 'done' });
			return;
		}

		const prompt = buildEffectivePrompt(request);
		const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
		if (request.model && request.model !== 'auto') {
			args.push('--model', request.model);
		}
		if (request.effort && request.effort !== 'auto') {
			const claudeEffort = request.effort === 'xhigh' ? 'high' : request.effort;
			args.push('--effort', claudeEffort);
		}
		let emittedText = false;
		const stderrLines: string[] = [];
		const pendingToolUses = new Map<string, string>();

		onEvent({ type: 'status', content: vscode.l10n.t('Running Claude Code...') });

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
					if (this.handleStreamJsonLine(trimmed, onEvent, pendingToolUses)) {
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
					content: stderrLines.join('\n') || vscode.l10n.t('Claude Code exited with code {0}.', exitCode ?? vscode.l10n.t('unknown')),
				});
			}
		} catch (err) {
			onEvent({ type: 'error', content: err instanceof Error ? err.message : String(err) });
		} finally {
			onEvent({ type: 'done' });
		}
	}

	private handleStreamJsonLine(line: string, onEvent: (event: AgentEvent) => void, pendingToolUses: Map<string, string>): boolean {
		if (!line.startsWith('{')) {
			return false;
		}
		try {
			const payload = JSON.parse(line) as Record<string, unknown>;
			const type = typeof payload.type === 'string' ? payload.type : '';

			if (type === 'assistant') {
				const message = payload.message as { content?: Array<{ type?: string; text?: string; name?: string; id?: string }> } | undefined;
				let produced = false;
				for (const block of message?.content ?? []) {
					if (block.type === 'text' && block.text) {
						onEvent({ type: 'text', content: block.text });
						produced = true;
					} else if (block.type === 'tool_use' && block.name) {
						if (block.id) {
							pendingToolUses.set(block.id, block.name);
						}
						onEvent({ type: 'tool_start', toolName: block.name });
					}
				}
				return produced;
			}

			if (type === 'user') {
				const message = payload.message as { content?: Array<{ type?: string; tool_use_id?: string; is_error?: boolean }> } | undefined;
				for (const block of message?.content ?? []) {
					if (block.type === 'tool_result' && block.tool_use_id) {
						const toolName = pendingToolUses.get(block.tool_use_id);
						pendingToolUses.delete(block.tool_use_id);
						if (toolName) {
							onEvent({ type: 'tool_end', toolName, metadata: { isError: !!block.is_error } });
						}
					}
				}
				return false;
			}

			if (type === 'content_block_delta') {
				const delta = payload.delta as { text?: string } | undefined;
				if (delta?.text) {
					onEvent({ type: 'text', content: delta.text });
					return true;
				}
			}

			if (type === 'result') {
				const resultText = typeof payload.result === 'string' ? payload.result : '';
				if (payload.is_error && resultText) {
					onEvent({ type: 'error', content: resultText });
					return true;
				}
				return resultText.length > 0;
			}

			return false;
		} catch {
			return false;
		}
	}
}
