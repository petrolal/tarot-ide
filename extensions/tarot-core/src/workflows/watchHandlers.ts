/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import { execSimple, resolveBinaryPath } from '../agents/processRunner';
import { WatchOutcomeKind, WorkflowWatchNode } from './workflowTypes';

export interface WatchPollResult {
	readonly outcome: WatchOutcomeKind;
	readonly cursor?: unknown;
	readonly payload?: unknown;
	readonly error?: string;
}

export interface WatchContext {
	readonly workspacePath: string;
	readonly cursor: unknown;
	readonly config: Readonly<Record<string, unknown>>;
}

/**
 * Executes a `command` watch poll (MIGRATION_PLAN.md M3.9a):
 * - Spawns via `/bin/sh -c` or `cmd.exe /c` with `{ shell: false }`.
 * - Sends `{ cursor, config, workspacePath }` as JSON on STDIN.
 * - Expects one JSON object `{ outcome: "idle" | "new-activity" | "terminal-state", cursor, payload }` on STDOUT.
 * - Exit codes `2`, `126`, `127` fail the watch; any other non-zero exit degrades to `idle`.
 */
export async function runCommandWatchPoll(
	command: string,
	ctx: WatchContext,
	timeoutMs = 30_000,
): Promise<WatchPollResult> {
	const isWin = process.platform === 'win32';
	const bin = isWin ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
	const args = isWin ? ['/d', '/s', '/c', command] : ['-c', command];

	return new Promise<WatchPollResult>(resolve => {
		const child = spawn(bin, args, {
			cwd: ctx.workspacePath,
			shell: false,
			windowsHide: true,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		let stdout = '';
		let stderr = '';
		let settled = false;
		const finish = (res: WatchPollResult) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve(res);
			}
		};

		const timer = setTimeout(() => {
			child.kill('SIGTERM');
			finish({ outcome: 'idle', cursor: ctx.cursor });
		}, timeoutMs);

		child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
		child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
		child.stdin.on('error', () => { /* ignore EPIPE */ });

		child.on('error', err => {
			finish({ outcome: 'idle', cursor: ctx.cursor, error: err.message });
		});

		child.on('close', exitCode => {
			if (exitCode === 2 || exitCode === 126 || exitCode === 127) {
				finish({
					outcome: 'idle',
					cursor: ctx.cursor,
					error: stderr.trim() || `Watch command failed with exit code ${exitCode}.`,
				});
				return;
			}
			if (exitCode !== 0) {
				finish({ outcome: 'idle', cursor: ctx.cursor });
				return;
			}
			try {
				const parsed = JSON.parse(stdout.trim()) as { outcome?: string; cursor?: unknown; payload?: unknown };
				const outcome: WatchOutcomeKind = parsed.outcome === 'new-activity' || parsed.outcome === 'terminal-state'
					? parsed.outcome
					: 'idle';
				finish({
					outcome,
					cursor: parsed.cursor !== undefined ? parsed.cursor : ctx.cursor,
					payload: parsed.payload,
				});
			} catch {
				finish({ outcome: 'idle', cursor: ctx.cursor });
			}
		});

		try {
			child.stdin.write(JSON.stringify(ctx), 'utf8');
			child.stdin.end();
		} catch {
			// Process exited early
		}
	});
}

/**
 * Executes a `github-pr` watch poll via the `gh` CLI (if installed): returns `terminal-state` on
 * `MERGED` or `CLOSED`, `new-activity` when new comments/reviews/failing checks appear compared
 * to the persisted cursor, or `idle`.
 */
export async function runGithubPrWatchPoll(ctx: WatchContext): Promise<WatchPollResult> {
	const ghPath = await resolveBinaryPath('gh');
	if (!ghPath) {
		return { outcome: 'idle', cursor: ctx.cursor, error: 'gh CLI not found on PATH.' };
	}
	const prRef = String(ctx.config.prRef ?? ctx.config.url ?? '').trim();
	if (!prRef) {
		return { outcome: 'idle', cursor: ctx.cursor, error: 'github-pr watch requires config.prRef or config.url.' };
	}
	const res = await execSimple(
		ghPath,
		['pr', 'view', prRef, '--json', 'state,mergeable,updatedAt,comments,reviews,statusCheckRollup'],
		20_000,
	).catch(() => undefined);
	if (!res || res.exitCode !== 0) {
		return { outcome: 'idle', cursor: ctx.cursor };
	}
	try {
		const data = JSON.parse(res.stdout) as { state?: string; updatedAt?: string; mergeable?: string };
		if (data.state === 'MERGED' || data.state === 'CLOSED') {
			return { outcome: 'terminal-state', cursor: data.updatedAt ?? ctx.cursor, payload: data };
		}
		if (data.updatedAt && data.updatedAt !== ctx.cursor) {
			return { outcome: 'new-activity', cursor: data.updatedAt, payload: data };
		}
		return { outcome: 'idle', cursor: ctx.cursor };
	} catch {
		return { outcome: 'idle', cursor: ctx.cursor };
	}
}

export async function runWatchPoll(node: WorkflowWatchNode, ctx: WatchContext): Promise<WatchPollResult> {
	if (node.handler === 'github-pr') {
		return runGithubPrWatchPoll(ctx);
	}
	const command = String(node.config.command ?? '');
	return runCommandWatchPoll(command, ctx);
}
