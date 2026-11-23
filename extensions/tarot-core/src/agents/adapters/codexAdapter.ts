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
		// `codex exec` defaults to a **read-only sandbox** with no flags at all (confirmed against
		// developers.openai.com/codex/noninteractive — "By default, codex exec runs in a read-only
		// sandbox") — codex could never write a single file through Tarot in any autonomy mode
		// (gap found in code review, 2026-11-22, same class as the earlier claude permission-mode
		// deadlock). It also refuses to run outside a Git repository unless told otherwise; Tarot's
		// own checkpoint system now works without git too (see checkpointService.ts's baseline
		// fingerprint), so that check is redundant here. NOTE: unlike the claude fix, this is
		// sourced from official docs only — the codex CLI was not available in this environment to
		// cross-check against its own --help, so verify against a real install before trusting it
		// blindly.
		const args = ['exec', '--json', '--skip-git-repo-check'];
		if (request.mode === 'plan') {
			// Read-only sandbox is already the default — nothing to add.
		} else if (request.autonomy === 'approveForMe') {
			args.push('--approve-for-me');
		} else {
			// Supervised/Accept File Changes: allow writes within the workspace. Tarot's own
			// post-hoc fs_write approval gate (reviewFileWritesForTurn) is what actually reviews
			// per policy — codex exec has no documented per-action pause-and-ask for unattended
			// runs to build real Supervised review on top of (same limitation as claude).
			args.push('--sandbox', 'workspace-write');
		}
		if (request.model && request.model !== 'auto') {
			args.push('-m', request.model);
		}
		if (request.effort && request.effort !== 'auto') {
			// codex has no dedicated --effort/--reasoning flag; the documented route is the
			// model_reasoning_effort config key, overridable per run via --config (confirmed
			// against developers.openai.com/codex/config-advanced). Accepted values there are
			// minimal/low/medium/high/xhigh — codex has no 'max', so Tarot's highest level maps to
			// its highest ('xhigh'). Gap found in code review, 2026-11-22: this flag was never
			// passed at all, so Reasoning Effort had zero effect on codex. Same caveat as the
			// sandbox flags above — sourced from docs only, not live-verified against the CLI.
			const codexEffort = request.effort === 'max' ? 'xhigh' : request.effort;
			args.push('--config', `model_reasoning_effort=${codexEffort}`);
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
