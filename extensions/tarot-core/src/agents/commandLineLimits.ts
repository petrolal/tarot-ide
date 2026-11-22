/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

/**
 * Conservative, platform-aware ceilings for a child process's full command line (binary path +
 * argv), well under the real OS limits: Windows' `CreateProcess` caps a command line at 32,767
 * UTF-16 code units; POSIX's `ARG_MAX` is typically 128 KB-2 MB but is shared with the inherited
 * environment (`processRunner.buildSafeEnv` forwards the full `process.env`), which is not sized
 * here. Every agent adapter builds its prompt (`promptBuilder.ts`, unbounded steering/attachment
 * content) into a single CLI argument — exceeding either limit produces an opaque native
 * `E2BIG`/`ENAMETOOLONG` failure well after the user already waited for the agent to "start", so
 * `checkCommandLineLength` lets callers fail fast with an actionable message instead.
 */
const WINDOWS_COMMAND_LINE_LIMIT = 30_000;
const POSIX_COMMAND_LINE_LIMIT = 400_000;

export interface CommandLineCheck {
	readonly ok: boolean;
	readonly totalChars: number;
	readonly limit: number;
}

export function checkCommandLineLength(
	binaryPath: string,
	args: readonly string[],
	platform: NodeJS.Platform = process.platform,
): CommandLineCheck {
	const limit = platform === 'win32' ? WINDOWS_COMMAND_LINE_LIMIT : POSIX_COMMAND_LINE_LIMIT;
	// +1 per argument for the separating space (or NUL, on POSIX argv) the OS itself adds.
	const totalChars = binaryPath.length + args.reduce((sum, arg) => sum + arg.length + 1, 0);
	return { ok: totalChars <= limit, totalChars, limit };
}
