/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import { HookFileV1 } from './hookTypes';

/** Pre-M3.6.6 legacy single-hook-per-file shape, before the `v1` schema was introduced. */
export interface LegacyHookFile {
	readonly trigger?: unknown;
	readonly glob?: unknown;
	readonly agent?: unknown;
	readonly prompt?: unknown;
	readonly name?: unknown;
}

const LEGACY_TRIGGER_MAP: Record<string, string> = {
	onSave: 'PostFileSave',
	onCreate: 'PostFileCreate',
	onDelete: 'PostFileDelete',
};

/**
 * Translates a legacy glob (`*.ts`, `src/**\/*.tsx`) into the regex source string the `v1` schema's
 * `matcher` field expects (`hookEngine.selectHooksForTrigger` always does `new RegExp(matcher,
 * 'i')`). The legacy format copied the glob into `matcher` verbatim — `new RegExp("*.ts")` throws
 * `SyntaxError` ("Nothing to repeat"), silently caught and treated as "never matches", so every
 * migrated hook with a `*` in its glob stopped firing forever with no visible error.
 */
function globToMatcherRegex(glob: string): string {
	let out = '';
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === '*' && glob[i + 1] === '*') {
			const consumeSlash = glob[i + 2] === '/';
			out += '.*';
			i += consumeSlash ? 2 : 1;
			continue;
		}
		if (ch === '*') {
			out += '[^/]*';
			continue;
		}
		if (ch === '?') {
			out += '[^/]';
			continue;
		}
		out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	}
	// A plain filename pattern (`*.ts`, no `/`) is left unanchored at the start so it still
	// matches at any depth (`src/foo.ts`, `a/b/foo.ts`, ...) — the same "match anywhere, anchor
	// only the end" style as the v1 schema's own documented example (`"\\.(ts|tsx)$"`). A pattern
	// that names a directory (`src/**/*.tsx`) is anchored from the start, since the user clearly
	// meant a specific location, not "anywhere a path happens to contain this".
	const anchorStart = glob.includes('/') ? '^' : '';
	return `${anchorStart}${out}$`;
}

/**
 * Some legacy hook files already hand-wrote a regex into `glob` (`\.md$`) rather than true glob
 * syntax — `matcher` has always been documented as regex, so that already worked and must keep
 * working unchanged. Only a value that is not valid regex syntax at all (a bare `*.ts`, which
 * throws `SyntaxError: Nothing to repeat`) is actually broken and needs translating.
 */
function migrateLegacyMatcher(glob: string): string {
	try {
		const probe = new RegExp(glob);
		void probe;
		return glob;
	} catch {
		return globToMatcherRegex(glob);
	}
}

/**
 * Upconverts a legacy `{ trigger: "onSave", glob, agent, prompt }` hook file (single hook, no
 * `version`/`hooks` wrapper) into the `v1` schema in memory. Returns `undefined` when `raw`
 * doesn't look like the legacy shape at all (including when it is already `v1`).
 */
export function migrateLegacyHookFile(raw: unknown): HookFileV1 | undefined {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return undefined;
	}
	const obj = raw as LegacyHookFile & { version?: unknown };
	if (obj.version !== undefined) {
		return undefined;
	}
	if (typeof obj.trigger !== 'string') {
		return undefined;
	}
	const trigger = LEGACY_TRIGGER_MAP[obj.trigger];
	if (!trigger) {
		return undefined;
	}

	return {
		version: 'v1',
		hooks: [
			{
				name: typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : 'legacy-hook',
				description: 'Migrated automatically from the legacy single-hook format.',
				enabled: true,
				trigger,
				matcher: typeof obj.glob === 'string' && obj.glob.trim() ? migrateLegacyMatcher(obj.glob.trim()) : undefined,
				timeout: 60,
				action: {
					type: 'agent',
					prompt: typeof obj.prompt === 'string' ? obj.prompt : '',
				},
			},
		],
	};
}
