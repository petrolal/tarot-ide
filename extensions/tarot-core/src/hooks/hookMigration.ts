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
				matcher: typeof obj.glob === 'string' ? obj.glob : undefined,
				timeout: 60,
				action: {
					type: 'agent',
					prompt: typeof obj.prompt === 'string' ? obj.prompt : '',
				},
			},
		],
	};
}
