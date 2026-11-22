/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import { PermissionRule } from './permissionTypes';

/**
 * Named rule bundles a user can drop into `permissions.yaml` (`preset: <name>` is expanded to
 * this array by `permissionsService`). Per M3.8a, `approve-for-me`'s `evaluate` effect depends on
 * a risk classifier Tarot does not ship yet — until one exists, `evaluate` rules contribute no
 * decision (`policyEngine` skips them), so this preset behaves like "no extra rules" today.
 */
export type PresetName =
	| 'allow-all'
	| 'edit-workspace'
	| 'read-workspace'
	| 'read-all'
	| 'read-only-shell'
	| 'dev-shell'
	| 'approve-for-me';

export const PRESET_NAMES: readonly PresetName[] = [
	'allow-all', 'edit-workspace', 'read-workspace', 'read-all', 'read-only-shell', 'dev-shell', 'approve-for-me',
];

const READ_ONLY_SHELL_MATCH: readonly string[] = [
	'git status*', 'git log*', 'git diff*', 'git show*', 'git branch*', 'git remote*',
	'ls*', 'cat *', 'grep *', 'rg *', 'find *', 'pwd', 'echo *', 'which *', 'node --version*', 'pnpm --version*',
];

const DEV_SHELL_MATCH: readonly string[] = [
	'git *', 'pnpm *', 'node *', 'gulp *', 'python *', 'pytest*', 'make *', 'go *', 'cargo *',
];

const PRESETS: Readonly<Record<PresetName, readonly PermissionRule[]>> = {
	'allow-all': [
		{ capability: 'all', effect: 'allow', reason: 'Preset: allow-all' },
	],
	'edit-workspace': [
		{ capability: 'fs_read', effect: 'allow', match: ['**'], reason: 'Preset: edit-workspace' },
		{ capability: 'fs_write', effect: 'allow', match: ['**'], reason: 'Preset: edit-workspace' },
	],
	'read-workspace': [
		{ capability: 'fs_read', effect: 'allow', match: ['**'], reason: 'Preset: read-workspace' },
		{ capability: 'fs_write', effect: 'ask', match: ['**'], reason: 'Preset: read-workspace' },
	],
	'read-all': [
		{ capability: 'fs_read', effect: 'allow', match: ['**'], reason: 'Preset: read-all' },
	],
	'read-only-shell': [
		{ capability: 'shell', effect: 'allow', match: READ_ONLY_SHELL_MATCH, reason: 'Preset: read-only-shell' },
	],
	'dev-shell': [
		{ capability: 'shell', effect: 'allow', match: DEV_SHELL_MATCH, reason: 'Preset: dev-shell' },
	],
	'approve-for-me': [
		{ capability: 'all', effect: 'evaluate', reason: 'Preset: approve-for-me (requires a risk classifier)' },
	],
};

export function getPreset(name: string): readonly PermissionRule[] | undefined {
	return (PRESETS as Record<string, readonly PermissionRule[] | undefined>)[name];
}
