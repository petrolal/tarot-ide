/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import * as vscode from 'vscode';
import { AcpCatalogEntry } from '../agentCatalog';
import { execSimple, resolveBinaryPath } from '../processRunner';
import { buildEffectivePrompt } from '../promptBuilder';
import { AgentAdapter, AgentEvent, AgentId, AgentRunRequest, AgentStatus } from '../types';
import { JsonRpcMessage, parseAcpSessionUpdate } from './acpParser';

/**
 * Universal Agent Client Protocol (ACP) adapter over JSON-RPC 2.0 stdio (MIGRATION_PLAN.md M3.8b).
 * Spawns any ACP-compliant CLI (`agy acp`, `kiro-cli acp`, `opencode acp`, `goose acp`, etc.)
 * with `{ shell: false }`, performs `initialize` -> `session/new` -> `session/prompt`, streams
 * `session/update` notifications, and handles `session/request_permission` requests.
 */
export class AcpAgentAdapter implements AgentAdapter {
	readonly id: AgentId;
	readonly displayName: string;
	readonly binary: string;
	readonly installHint: string;

	constructor(private readonly entry: AcpCatalogEntry) {
		this.id = entry.id;
		this.displayName = entry.displayName;
		this.binary = entry.binary;
		this.installHint = entry.installHint;
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
			const res = await execSimple(resolvedPath, this.entry.versionArgs);
			const version = (res.stdout || res.stderr).split('\n')[0]?.trim();
			return {
				id: this.id,
				displayName: this.displayName,
				binary: this.binary,
				available: res.exitCode === 0,
				resolvedPath,
				version: version ? `${version} (ACP)` : 'ACP',
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

	async run(request: AgentRunRequest, onEvent: (event: AgentEvent) => void, token: vscode.CancellationToken): Promise<void> {
		const resolvedPath = await resolveBinaryPath(this.binary);
		if (!resolvedPath) {
			onEvent({ type: 'error', content: vscode.l10n.t("ACP binary '{0}' not found on PATH.", this.binary) });
			onEvent({ type: 'done' });
			return;
		}

		const prompt = buildEffectivePrompt(request);
		onEvent({ type: 'status', content: vscode.l10n.t('Connecting to {0} via ACP...', this.displayName) });

		await new Promise<void>(resolve => {
			const child = spawn(resolvedPath, [...this.entry.acpArgs], {
				cwd: request.cwd,
				shell: false,
				windowsHide: true,
				stdio: ['pipe', 'pipe', 'pipe'],
			});

			let nextId = 1;
			let sessionId: string | undefined;
			let stdoutBuf = '';
			const stderrLines: string[] = [];
			let finished = false;
			const pending = new Map<number, { resolve: (res: Record<string, unknown>) => void; reject: (err: Error) => void }>();

			const cleanup = (emitDone = true) => {
				if (finished) {
					return;
				}
				finished = true;
				clearTimeout(timer);
				cancelSub.dispose();
				for (const p of pending.values()) {
					p.reject(new Error('ACP process closed.'));
				}
				pending.clear();
				if (emitDone) {
					onEvent({ type: 'done' });
				}
				resolve();
			};

			const sendRpc = (payload: Record<string, unknown>) => {
				try {
					child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...payload }) + '\n', 'utf8');
				} catch {
					// Process may have exited
				}
			};

			const callRpc = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
				const id = nextId++;
				return new Promise((res, rej) => {
					pending.set(id, { resolve: res, reject: rej });
					sendRpc({ id, method, params });
				});
			};

			child.stdin.on('error', () => { /* ignore EPIPE */ });

			const timer = setTimeout(() => {
				child.kill('SIGTERM');
				onEvent({ type: 'error', content: vscode.l10n.t('ACP agent timed out.') });
				cleanup();
			}, request.timeoutMs);

			const cancelSub = token.onCancellationRequested(() => {
				if (sessionId) {
					sendRpc({ method: 'session/cancel', params: { sessionId } });
				}
				child.kill('SIGTERM');
				onEvent({ type: 'status', content: vscode.l10n.t('Execution cancelled.') });
			});

			child.stderr.on('data', (chunk: Buffer) => {
				for (const line of chunk.toString('utf8').split(/\r?\n/)) {
					if (line.trim()) {
						stderrLines.push(line);
					}
				}
			});

			child.stdout.on('data', (chunk: Buffer) => {
				stdoutBuf += chunk.toString('utf8');
				let nl: number;
				while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
					const rawLine = stdoutBuf.slice(0, nl).trim();
					stdoutBuf = stdoutBuf.slice(nl + 1);
					if (!rawLine.startsWith('{')) {
						continue;
					}
					let msg: JsonRpcMessage;
					try {
						msg = JSON.parse(rawLine) as JsonRpcMessage;
					} catch {
						continue;
					}
					if (typeof msg.id === 'number' && !msg.method && pending.has(msg.id)) {
						const handler = pending.get(msg.id)!;
						pending.delete(msg.id);
						if (msg.error) {
							handler.reject(new Error(msg.error.message || `ACP error ${msg.error.code ?? ''}`));
						} else {
							handler.resolve(msg.result ?? {});
						}
						continue;
					}
					if (msg.method === 'session/update') {
						for (const ev of parseAcpSessionUpdate(msg.params)) {
							onEvent(ev);
						}
					} else if (msg.method === 'session/request_permission' && msg.id !== undefined) {
						// Respect composer autonomy mode when the ACP server requests permission mid-turn.
						const options = Array.isArray(msg.params?.options) ? msg.params!.options as Array<{ optionId?: string; kind?: string }> : [];
						const allowOpt = options.find(o => o.kind === 'allow_once' || o.kind === 'allow_always') ?? options[0];
						const rejectOpt = options.find(o => o.kind === 'reject_once' || o.kind === 'reject_always');
						const chosen = (request.mode === 'plan' || request.autonomy === 'supervised')
							? (rejectOpt ?? allowOpt)
							: allowOpt;
						sendRpc({
							id: msg.id,
							result: chosen?.optionId
								? { outcome: { outcome: 'selected', optionId: chosen.optionId } }
								: { outcome: { outcome: 'cancelled' } },
						});
					}
				}
			});

			child.on('error', err => {
				onEvent({ type: 'error', content: err.message });
				cleanup();
			});

			child.on('close', code => {
				if (!finished && code !== 0 && !token.isCancellationRequested) {
					onEvent({
						type: 'error',
						content: stderrLines.join('\n') || vscode.l10n.t('ACP agent exited with code {0}.', code ?? vscode.l10n.t('unknown')),
					});
				}
				cleanup();
			});

			void (async () => {
				try {
					await callRpc('initialize', {
						protocolVersion: 1,
						clientCapabilities: {},
						clientInfo: { name: 'tarot-ide', version: '0.2.0' },
					});
					const created = await callRpc('session/new', { cwd: request.cwd, mcpServers: [] });
					sessionId = typeof created.sessionId === 'string' ? created.sessionId : undefined;
					if (!sessionId) {
						throw new Error('ACP server did not return a sessionId.');
					}
					await callRpc('session/prompt', {
						sessionId,
						prompt: [{ type: 'text', text: prompt }],
					});
					child.kill('SIGTERM');
					cleanup();
				} catch (err) {
					if (!finished && !token.isCancellationRequested) {
						onEvent({ type: 'error', content: err instanceof Error ? err.message : String(err) });
					}
					child.kill('SIGTERM');
					cleanup();
				}
			})();
		});
	}
}
