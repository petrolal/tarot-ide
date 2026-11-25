/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { execSimple, resolveBinaryPath, spawnStreaming } from '../processRunner';
import { buildEffectivePrompt } from '../promptBuilder';
import { AgentAdapter, AgentEvent, AgentModelOption, AgentRunRequest, AgentStatus } from '../types';
import { parseClaudeStreamJsonLine } from './claudeStreamParser';

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
			// `claude --help` lists --effort as (low, medium, high, xhigh, max) natively — no
			// downgrade needed (gap found in code review, 2026-11-22: this used to silently send
			// 'high' whenever the user picked 'xhigh' in the Reasoning Effort popover).
			args.push('--effort', request.effort);
		}
		// Without an explicit --permission-mode, `claude -p` runs in its own default ("manual"):
		// with no interactive terminal and no --permission-prompt-tool configured, every file edit
		// and non-read-only Bash command is denied outright — Accept File Changes/Approve For Me
		// were previously pure UI state with no effect on the actual CLI run (gap found in code
		// review, 2026-11-22; confirmed against `claude --help`'s own --permission-mode/
		// --permission-prompts documentation). `acceptEdits` also auto-approves a few Bash
		// commands beyond file edits (mkdir/touch/mv/cp/rm/rmdir/sed) — rm is explicitly denied
		// here since "accept file changes" should not silently extend to "accept file deletion".
		if (request.mode === 'plan') {
			args.push('--permission-mode', 'plan');
		} else if (request.autonomy === 'approveForMe') {
			args.push('--permission-mode', 'auto', '--permission-prompts', 'none');
		} else {
			// Supervised and Accept File Changes both apply edits via acceptEdits: a real
			// pre-write, per-hunk pause-and-ask for Supervised (what Kiro's own Supervised mode
			// does) needs a bidirectional --permission-prompt-tool bridge Tarot does not build yet
			// (M3.8b/M3.9a) — `--permission-mode default` denies every edit outright with no host
			// to answer, which is not "supervised", just broken. Until that bridge exists, Tarot's
			// own post-hoc fs_write approval gate (reviewFileWritesForTurn) is what actually
			// reviews: it shows a real Keep/Revert card for every file in Supervised, vs. only for
			// explicit policy rules in Accept File Changes.
			args.push('--permission-mode', 'acceptEdits', '--disallowedTools', 'Bash(rm *)');
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
					if (parseClaudeStreamJsonLine(trimmed, onEvent, pendingToolUses, emittedText)) {
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
}
