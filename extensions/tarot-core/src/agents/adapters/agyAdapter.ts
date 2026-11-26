/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { execSimple, resolveBinaryPath, spawnStreaming } from '../processRunner';
import { buildEffectivePrompt } from '../promptBuilder';
import { AgentAdapter, AgentEvent, AgentModelOption, AgentRunRequest, AgentStatus } from '../types';
import { createAgyStreamParseState, parseAgyStreamLine } from './agyStreamParser';

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
		if (request.mode === 'plan') {
			args.push(
				'--mode', 'plan',
				'--settings', JSON.stringify({
					permissions: {
						allow: ['command(ls *)', 'command(find *)', 'command(cat *)', 'command(rg *)', 'command(git status*)', 'command(git diff*)', 'command(git log*)'],
						deny: ['command(rm *)'],
					},
				}),
			);
		} else if (request.autonomy === 'approveForMe') {
			args.push('--dangerously-skip-permissions');
		} else {
			// On hosts without terminal sandbox, `agy --mode auto` silently falls back to
			// `request-review` and auto-denies `run_command` in headless `--print` mode.
			// Passing session-scoped `--settings` mirrors `claudeAdapter.ts` (`acceptEdits` +
			// denying `rm *`) while Tarot's own post-turn file-write gate & checkpoints protect edits.
			args.push(
				'--mode', 'accept-edits',
				'--settings', JSON.stringify({
					permissions: {
						allow: ['command(*)'],
						deny: ['command(rm *)'],
					},
				}),
			);
		}
		args.push(`--print=${prompt}`);

		const parseState = createAgyStreamParseState();
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
					if (trimmed.startsWith('{')) {
						const parsedEvents = parseAgyStreamLine(trimmed, parseState);
						for (const ev of parsedEvents) {
							onEvent(ev);
						}
						return;
					}
					parseState.emittedText = true;
					onEvent({ type: 'text', content: `${line}\n` });
				},
				onStderrLine: line => {
					if (line.trim()) {
						stderrLines.push(line);
					}
				},
			});

			if (token.isCancellationRequested) {
				onEvent({ type: 'status', content: vscode.l10n.t('Execution cancelled.') });
			} else if (exitCode !== 0 && !parseState.emittedText) {
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
}
