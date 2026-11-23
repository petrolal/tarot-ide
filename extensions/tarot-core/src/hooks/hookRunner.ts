/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'node:child_process';

export interface HookRunContext {
	readonly hook_event_name: string;
	readonly cwd: string;
	readonly session_id?: string;
	readonly file_path?: string;
	readonly tool_name?: string;
	readonly user_prompt?: string;
	/** Extra trigger-specific fields (e.g. Spec task info) merged into the STDIN JSON verbatim. */
	readonly extra?: Readonly<Record<string, unknown>>;
}

export type HookCommandOutcome =
	| { readonly kind: 'ok'; readonly stdout: string }
	| { readonly kind: 'block'; readonly stderr: string }
	| { readonly kind: 'warn'; readonly stderr: string; readonly exitCode: number | null }
	| { readonly kind: 'timeout' };

/**
 * Runs one hook `command` action: the context (`hook_event_name`, `cwd`, session/file/tool info)
 * is piped as JSON on STDIN, following the exit-code contract from `AGENTS.md`/`MIGRATION_PLAN.md`:
 * `exit 0` → stdout feeds the agent's context, `exit 2` → blocks (PreToolUse/PromptSubmit) or
 * cancels (PreCompaction), any other code → a warning. The command runs through the platform
 * shell (`sh -c` / `cmd.exe /c`) rather than Node's shell-true spawn option, since hook authors
 * write ordinary shell one-liners (pipes, env vars) — this is distinct from, and does not relax,
 * the `spawn(bin, args, { shell: false })` rule for the BYOA agent CLIs themselves (AGENTS.md §2d).
 */
export function runHookCommand(command: string, context: HookRunContext, timeoutSeconds: number): Promise<HookCommandOutcome> {
	return new Promise(resolve => {
		const isWindows = process.platform === 'win32';
		const shellBin = isWindows ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
		const shellArgs = isWindows ? ['/d', '/s', '/c', command] : ['-c', command];

		const child = cp.spawn(shellBin, shellArgs, {
			cwd: context.cwd,
			shell: false,
			stdio: ['pipe', 'pipe', 'pipe'],
			env: process.env,
		});

		let stdout = '';
		let stderr = '';
		let settled = false;
		let timer: NodeJS.Timeout | undefined;

		const finish = (outcome: HookCommandOutcome) => {
			if (settled) {
				return;
			}
			settled = true;
			if (timer) {
				clearTimeout(timer);
			}
			resolve(outcome);
		};

		if (timeoutSeconds > 0) {
			timer = setTimeout(() => {
				try {
					child.kill('SIGTERM');
				} catch {
					// Already exited
				}
				finish({ kind: 'timeout' });
			}, timeoutSeconds * 1000);
		}

		child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
		child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

		child.on('error', err => {
			finish({ kind: 'warn', stderr: err.message, exitCode: null });
		});

		child.on('close', exitCode => {
			if (exitCode === 0) {
				finish({ kind: 'ok', stdout: stdout.trim() });
			} else if (exitCode === 2) {
				finish({ kind: 'block', stderr: stderr.trim() });
			} else {
				finish({ kind: 'warn', stderr: stderr.trim(), exitCode });
			}
		});

		// A fast command (e.g. `echo ok` or `exit 1`) can exit before reading STDIN, causing an
		// async EPIPE error event on `child.stdin` that `try/catch` around `.write()` cannot catch.
		child.stdin.on('error', () => { /* ignore EPIPE if process exited early */ });
		try {
			const { extra, ...rest } = context;
			child.stdin.write(JSON.stringify({ ...rest, ...extra }), 'utf8');
			child.stdin.end();
		} catch {
			// Process may have already exited
		}
	});
}
