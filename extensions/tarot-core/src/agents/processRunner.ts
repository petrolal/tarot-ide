/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { checkCommandLineLength } from './commandLineLimits';

const COMMON_EXTRA_PATHS_UNIX = [
	'.local/bin',
	'.npm-global/bin',
	'.cargo/bin',
	'.volta/bin',
	'.pnpm',
];

async function isExecutable(filePath: string): Promise<boolean> {
	try {
		const stat = await fs.stat(filePath);
		if (!stat.isFile()) {
			return false;
		}
		if (process.platform === 'win32') {
			return true;
		}
		await fs.access(filePath, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function expandHome(inputPath: string): string {
	if (inputPath.startsWith('~/') || inputPath === '~') {
		return path.join(os.homedir(), inputPath.slice(1));
	}
	return inputPath;
}

/**
 * Resolves a CLI binary safely across configured overrides, PATH, and standard user bin directories.
 */
export async function resolveBinaryPath(binaryName: string, configuredPath?: string): Promise<string | undefined> {
	if (configuredPath && configuredPath.trim().length > 0) {
		const expanded = expandHome(configuredPath.trim());
		if (await isExecutable(expanded)) {
			return expanded;
		}
	}

	if (path.isAbsolute(binaryName) || binaryName.includes(path.sep)) {
		const expanded = expandHome(binaryName);
		return (await isExecutable(expanded)) ? expanded : undefined;
	}

	const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
	const home = os.homedir();
	const extraDirs = process.platform === 'win32'
		? []
		: [
			...COMMON_EXTRA_PATHS_UNIX.map(rel => path.join(home, rel)),
			'/usr/local/bin',
			'/opt/homebrew/bin',
		];

	const candidateDirs = Array.from(new Set([...pathEntries, ...extraDirs]));
	const extensions = process.platform === 'win32'
		? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
		: [''];

	for (const dir of candidateDirs) {
		for (const ext of extensions) {
			const candidate = path.join(dir, `${binaryName}${ext}`);
			if (await isExecutable(candidate)) {
				return candidate;
			}
		}
	}

	return undefined;
}

export interface SimpleExecResult {
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

/**
 * Runs a short-lived non-interactive command (e.g., `--version`) with `shell: false`.
 */
export function execSimple(binaryPath: string, args: readonly string[], timeoutMs = 5_000): Promise<SimpleExecResult> {
	return new Promise((resolve, reject) => {
		const child = cp.spawn(binaryPath, [...args], {
			shell: false,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: buildSafeEnv(),
		});

		let stdout = '';
		let stderr = '';
		let settled = false;

		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				child.kill('SIGTERM');
				reject(new Error(`Command timed out after ${timeoutMs}ms`));
			}
		}, timeoutMs);

		child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
		child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

		child.on('error', err => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				reject(err);
			}
		});

		child.on('close', exitCode => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve({ exitCode, stdout: stdout.trim(), stderr: stderr.trim() });
			}
		});
	});
}

export interface StreamingSpawnOptions {
	readonly cwd: string;
	readonly timeoutMs: number;
	readonly stdinText?: string;
	readonly token: vscode.CancellationToken;
	readonly onStdoutLine: (line: string) => void;
	readonly onStderrLine: (line: string) => void;
}

/**
 * Spawns a local AI CLI with `shell: false`, line-buffered streaming, timeout, and clean cancellation.
 */
export function spawnStreaming(binaryPath: string, args: readonly string[], options: StreamingSpawnOptions): Promise<number | null> {
	return new Promise((resolve, reject) => {
		if (options.token.isCancellationRequested) {
			resolve(null);
			return;
		}

		const lengthCheck = checkCommandLineLength(binaryPath, args);
		if (!lengthCheck.ok) {
			reject(new Error(
				`Prompt too long for this platform's command line (${lengthCheck.totalChars} chars, limit ${lengthCheck.limit}). `
				+ 'Remove some attached context or shorten the Steering docs and try again.',
			));
			return;
		}

		const child = cp.spawn(binaryPath, [...args], {
			cwd: options.cwd,
			shell: false,
			stdio: [options.stdinText !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
			env: buildSafeEnv(),
		});

		let settled = false;
		let stdoutBuf = '';
		let stderrBuf = '';
		let killTimer: NodeJS.Timeout | undefined;

		const terminateChild = () => {
			try {
				child.kill('SIGTERM');
			} catch {
				// Process already exited
			}
			killTimer = setTimeout(() => {
				try {
					child.kill('SIGKILL');
				} catch {
					// Process already exited
				}
			}, 3_000);
		};

		const cancelDisposable = options.token.onCancellationRequested(() => {
			terminateChild();
		});

		const timeoutTimer = setTimeout(() => {
			if (!settled) {
				terminateChild();
				settled = true;
				cleanup();
				reject(new Error(`Agent execution timed out after ${Math.round(options.timeoutMs / 1000)}s`));
			}
		}, options.timeoutMs);

		const cleanup = () => {
			clearTimeout(timeoutTimer);
			if (killTimer) {
				clearTimeout(killTimer);
			}
			cancelDisposable.dispose();
		};

		const flushBuffer = (buf: string, emit: (line: string) => void): string => {
			let idx = buf.indexOf('\n');
			while (idx !== -1) {
				const line = buf.slice(0, idx).replace(/\r$/, '');
				emit(line);
				buf = buf.slice(idx + 1);
				idx = buf.indexOf('\n');
			}
			return buf;
		};

		child.stdout?.on('data', (chunk: Buffer) => {
			stdoutBuf = flushBuffer(stdoutBuf + chunk.toString('utf8'), options.onStdoutLine);
		});

		child.stderr?.on('data', (chunk: Buffer) => {
			stderrBuf = flushBuffer(stderrBuf + chunk.toString('utf8'), options.onStderrLine);
		});

		if (options.stdinText !== undefined && child.stdin) {
			child.stdin.write(options.stdinText, 'utf8');
			child.stdin.end();
		}

		child.on('error', err => {
			if (!settled) {
				settled = true;
				cleanup();
				reject(err);
			}
		});

		child.on('close', exitCode => {
			if (stdoutBuf.length > 0) {
				options.onStdoutLine(stdoutBuf.replace(/\r$/, ''));
			}
			if (stderrBuf.length > 0) {
				options.onStderrLine(stderrBuf.replace(/\r$/, ''));
			}
			if (!settled) {
				settled = true;
				cleanup();
				resolve(exitCode);
			}
		});
	});
}

function buildSafeEnv(): NodeJS.ProcessEnv {
	const home = os.homedir();
	const currentPath = process.env.PATH ?? '';
	const extra = process.platform === 'win32'
		? ''
		: COMMON_EXTRA_PATHS_UNIX.map(rel => path.join(home, rel)).join(path.delimiter);
	const mergedPath = extra ? `${extra}${path.delimiter}${currentPath}` : currentPath;
	return {
		...process.env,
		PATH: mergedPath,
		NO_COLOR: '1',
	};
}
