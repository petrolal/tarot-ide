/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

/** One sub-command of a composite shell line, with the operator that preceded it (`undefined` for the first). */
export interface ShellSegment {
	readonly text: string;
	readonly precedingOperator?: ';' | '&&' | '||' | '|';
}

export type ParsedShellCommand =
	| { readonly ok: true; readonly segments: readonly ShellSegment[] }
	| { readonly ok: false; readonly reason: string };

const UNPARSEABLE_PATTERNS: ReadonlyArray<{ regex: RegExp; reason: string }> = [
	{ regex: /\$\(/, reason: 'command substitution ($(...))' },
	{ regex: /`/, reason: 'backtick command substitution' },
	{ regex: /<\(/, reason: 'process substitution (<(...))' },
	{ regex: /<<[-~]?\s*\S/, reason: 'heredoc (<<)' },
];

/**
 * Splits a composite shell command on the top-level `;`, `&&`, `||` and `|` operators (per
 * `AGENTS.md`/`MIGRATION_PLAN.md` M3.8a), respecting single/double quotes and `(...)` subshell
 * grouping so operators inside them are not split. Flags constructs the policy engine cannot
 * safely reason about (command substitution, heredocs) as unparseable — callers must block these
 * and ask the agent to rewrite the command, per the M3.8a spec.
 */
export function parseShellCommand(command: string): ParsedShellCommand {
	for (const { regex, reason } of UNPARSEABLE_PATTERNS) {
		if (regex.test(command)) {
			return { ok: false, reason: `Unparseable shell construct: ${reason}.` };
		}
	}

	const segments: ShellSegment[] = [];
	let current = '';
	let pendingOperator: ShellSegment['precedingOperator'];
	let inSingle = false;
	let inDouble = false;
	let parenDepth = 0;

	const flush = (operator: ShellSegment['precedingOperator']) => {
		const text = current.trim();
		if (text.length > 0) {
			segments.push({ text, precedingOperator: pendingOperator });
		}
		current = '';
		pendingOperator = operator;
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		const next = command[i + 1];

		if (ch === '\\' && !inSingle) {
			current += ch + (next ?? '');
			i++;
			continue;
		}
		if (ch === '\'' && !inDouble) {
			inSingle = !inSingle;
			current += ch;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			current += ch;
			continue;
		}
		if (inSingle || inDouble) {
			current += ch;
			continue;
		}
		if (ch === '(') {
			parenDepth++;
			current += ch;
			continue;
		}
		if (ch === ')') {
			parenDepth = Math.max(0, parenDepth - 1);
			current += ch;
			continue;
		}
		if (parenDepth === 0) {
			if (ch === ';') {
				flush(';');
				continue;
			}
			if (ch === '&' && next === '&') {
				flush('&&');
				i++;
				continue;
			}
			if (ch === '|' && next === '|') {
				flush('||');
				i++;
				continue;
			}
			if (ch === '|') {
				flush('|');
				continue;
			}
		}
		current += ch;
	}

	if (inSingle || inDouble) {
		return { ok: false, reason: 'Unbalanced quotes.' };
	}
	if (parenDepth !== 0) {
		return { ok: false, reason: 'Unbalanced parentheses.' };
	}

	const tail = current.trim();
	if (tail.length > 0) {
		segments.push({ text: tail, precedingOperator: pendingOperator });
	}

	return { ok: true, segments };
}
