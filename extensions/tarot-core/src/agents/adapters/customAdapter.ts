/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { execSimple, resolveBinaryPath, spawnStreaming } from '../processRunner';
import { buildEffectivePrompt } from '../promptBuilder';
import { AgentAdapter, AgentEvent, AgentRunRequest, AgentStatus, CustomAgentConfig } from '../types';

export class CustomCliAdapter implements AgentAdapter {
	readonly id: string;
	readonly displayName: string;
	readonly binary: string;
	readonly installHint: string;

	constructor(private readonly config: CustomAgentConfig) {
		this.id = config.id;
		this.displayName = config.displayName || config.id;
		this.binary = config.binary;
		this.installHint = `Configure '${config.binary}' em tarot.agents.custom`;
	}

	async detect(): Promise<AgentStatus> {
		const resolvedPath = await resolveBinaryPath(this.binary);
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
			const res = await execSimple(resolvedPath, this.config.versionArgs ?? ['--version']);
			const version = (res.stdout || res.stderr).split('\n')[0]?.trim();
			return {
				id: this.id,
				displayName: this.displayName,
				binary: this.binary,
				available: res.exitCode === 0,
				resolvedPath,
				version: version || 'installed',
				installHint: this.installHint,
			};
		} catch {
			return {
				id: this.id,
				displayName: this.displayName,
				binary: this.binary,
				available: true,
				resolvedPath,
				version: 'custom',
				installHint: this.installHint,
			};
		}
	}

	async run(request: AgentRunRequest, onEvent: (event: AgentEvent) => void, token: vscode.CancellationToken): Promise<void> {
		const resolvedPath = await resolveBinaryPath(this.binary);
		if (!resolvedPath) {
			onEvent({ type: 'error', content: vscode.l10n.t("Custom agent '{0}' ('{1}') not found.", this.displayName, this.binary) });
			onEvent({ type: 'done' });
			return;
		}

		const prompt = buildEffectivePrompt(request);
		const args = [...(this.config.args ?? []), prompt];
		const stderrLines: string[] = [];
		let emittedText = false;

		onEvent({ type: 'status', content: vscode.l10n.t('Running {0}...', this.displayName) });

		try {
			const exitCode = await spawnStreaming(resolvedPath, args, {
				cwd: request.cwd,
				timeoutMs: request.timeoutMs,
				token,
				onStdoutLine: line => {
					emittedText = true;
					onEvent({ type: 'text', content: `${line}\n` });
				},
				onStderrLine: line => {
					if (line.trim()) {
						stderrLines.push(line);
					}
				},
			});

			if (exitCode !== 0 && !emittedText && !token.isCancellationRequested) {
				onEvent({ type: 'error', content: stderrLines.join('\n') || vscode.l10n.t('{0} exited with code {1}.', this.displayName, exitCode ?? vscode.l10n.t('unknown')) });
			}
		} catch (err) {
			onEvent({ type: 'error', content: err instanceof Error ? err.message : String(err) });
		} finally {
			onEvent({ type: 'done' });
		}
	}
}
