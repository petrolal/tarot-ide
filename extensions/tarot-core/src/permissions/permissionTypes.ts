/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

export type Capability =
	| 'fs_read'
	| 'fs_write'
	| 'shell'
	| 'web_fetch'
	| 'web_search'
	| 'mcp'
	| 'subagent'
	| 'skill'
	| 'power'
	| 'context'
	| 'diagnostics'
	| 'sandbox_network';

export const CAPABILITIES: readonly Capability[] = [
	'fs_read', 'fs_write', 'shell', 'web_fetch', 'web_search', 'mcp',
	'subagent', 'skill', 'power', 'context', 'diagnostics', 'sandbox_network',
];

export type MetaCapability = 'all' | 'builtin' | 'filesystem';

export type Effect = 'deny' | 'ask' | 'allow' | 'evaluate';

const EFFECT_PRIORITY: Readonly<Record<Effect, number>> = { deny: 0, ask: 1, allow: 2, evaluate: 3 };

export function effectIsMoreRestrictive(a: Effect, b: Effect): boolean {
	return EFFECT_PRIORITY[a] < EFFECT_PRIORITY[b];
}

export type PermissionScopeId = 'tarot' | 'administration' | 'user' | 'workspace' | 'agent' | 'session';

export const PERMISSION_SCOPE_ORDER: readonly PermissionScopeId[] = [
	'tarot', 'administration', 'user', 'workspace', 'agent', 'session',
];

export interface PermissionRule {
	readonly capability: Capability | MetaCapability;
	readonly effect: Effect;
	readonly match?: readonly string[];
	readonly exclude?: readonly string[];
	readonly reason?: string;
}

export interface PermissionScope {
	readonly id: PermissionScopeId;
	readonly rules: readonly PermissionRule[];
	readonly sourceFile?: string;
}

export interface PermissionsFileV1 {
	readonly version: 1;
	readonly rules: readonly PermissionRule[];
}

export interface ParsedPermissionsFile {
	readonly rules: readonly PermissionRule[];
	readonly errors: readonly string[];
}

const VALID_CAPABILITIES = new Set<string>([...CAPABILITIES, 'all', 'builtin', 'filesystem']);
const VALID_EFFECTS = new Set<string>(['deny', 'ask', 'allow', 'evaluate']);

function asStringArray(value: unknown, errors: string[], label: string): readonly string[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) {
		errors.push(`${label} must be an array of strings.`);
		return undefined;
	}
	return value as string[];
}

function parseRule(raw: unknown, index: number, errors: string[]): PermissionRule | undefined {
	if (!raw || typeof raw !== 'object') {
		errors.push(`rules[${index}] must be an object.`);
		return undefined;
	}
	const entry = raw as Record<string, unknown>;
	const capability = entry.capability;
	if (typeof capability !== 'string' || !VALID_CAPABILITIES.has(capability)) {
		errors.push(`rules[${index}].capability is missing or unknown: ${String(capability)}.`);
		return undefined;
	}
	const effect = entry.effect;
	if (typeof effect !== 'string' || !VALID_EFFECTS.has(effect)) {
		errors.push(`rules[${index}].effect is missing or unknown: ${String(effect)}.`);
		return undefined;
	}
	const match = asStringArray(entry.match, errors, `rules[${index}].match`);
	const exclude = asStringArray(entry.exclude, errors, `rules[${index}].exclude`);
	const reason = typeof entry.reason === 'string' ? entry.reason : undefined;
	return {
		capability: capability as Capability | MetaCapability,
		effect: effect as Effect,
		match,
		exclude,
		reason,
	};
}

/**
 * Validates a parsed `permissions.yaml` document (already turned into a plain JS value by
 * `yamlLite`). Never throws: malformed rules are collected into `errors` and skipped, mirroring
 * `hooks/hookTypes.ts::parseHookFile`.
 */
export function parsePermissionsDocument(raw: unknown, sourceFile: string): ParsedPermissionsFile {
	const errors: string[] = [];
	if (!raw || typeof raw !== 'object') {
		return { rules: [], errors: [`${sourceFile}: document root must be a mapping.`] };
	}
	const doc = raw as Record<string, unknown>;
	if (doc.version !== 1) {
		errors.push(`${sourceFile}: unsupported or missing "version" (expected 1).`);
	}
	const rawRules = doc.rules;
	if (rawRules === undefined) {
		return { rules: [], errors };
	}
	if (!Array.isArray(rawRules)) {
		errors.push(`${sourceFile}: "rules" must be a list.`);
		return { rules: [], errors };
	}
	const rules: PermissionRule[] = [];
	rawRules.forEach((entry, index) => {
		const parsed = parseRule(entry, index, errors);
		if (parsed) {
			rules.push(parsed);
		}
	});
	return { rules, errors: errors.map(e => (e.startsWith(sourceFile) ? e : `${sourceFile}: ${e}`)) };
}

const META_EXPANSIONS: Readonly<Record<MetaCapability, readonly Capability[]>> = {
	all: CAPABILITIES.filter(c => c !== 'sandbox_network'),
	builtin: ['fs_read', 'fs_write', 'shell', 'context', 'diagnostics'],
	filesystem: ['fs_read', 'fs_write'],
};

export function expandCapability(capability: Capability | MetaCapability): readonly Capability[] {
	if (capability === 'all' || capability === 'builtin' || capability === 'filesystem') {
		return META_EXPANSIONS[capability];
	}
	return [capability];
}

export function ruleAppliesTo(rule: PermissionRule, capability: Capability): boolean {
	return expandCapability(rule.capability).includes(capability);
}
