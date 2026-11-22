/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import { migrateLegacyHookFile } from './hookMigration';

/**
 * Canonical trigger names of the `v1` Agent Hooks schema. `PromptSubmit`/`Stop` are the
 * canonical spellings; `UserPromptSubmit`/`AgentStop` are accepted aliases (see {@link TRIGGER_ALIASES}).
 */
export type HookTrigger =
	| 'PromptSubmit'
	| 'Stop'
	| 'SessionStart'
	| 'SessionEnd'
	| 'PreCompaction'
	| 'PostCompaction'
	| 'PreToolUse'
	| 'PostToolUse'
	| 'PermissionRequest'
	| 'PostFileCreate'
	| 'PostFileSave'
	| 'PostFileDelete'
	| 'PreTaskExecution'
	| 'PostTaskExecution';

const KNOWN_TRIGGERS = new Set<string>([
	'PromptSubmit', 'Stop', 'SessionStart', 'SessionEnd', 'PreCompaction', 'PostCompaction',
	'PreToolUse', 'PostToolUse', 'PermissionRequest', 'PostFileCreate', 'PostFileSave',
	'PostFileDelete', 'PreTaskExecution', 'PostTaskExecution',
]);

const TRIGGER_ALIASES: Record<string, HookTrigger> = {
	UserPromptSubmit: 'PromptSubmit',
	AgentStop: 'Stop',
};

export function normalizeTrigger(raw: string): HookTrigger | undefined {
	const aliased = TRIGGER_ALIASES[raw] ?? raw;
	return KNOWN_TRIGGERS.has(aliased) ? (aliased as HookTrigger) : undefined;
}

export interface HookConfirmOption {
	readonly id: string;
	readonly label: string;
	/** Shell command line that replaces `action.command` when this option is chosen. */
	readonly run?: string;
}

export interface HookConfirmConfig {
	readonly question: string;
	readonly options: readonly HookConfirmOption[];
	/** Shell command whose stdout JSON (`{"skip": true}` or dynamic question/options) overrides the static `confirm`. */
	readonly confirmCommand?: string;
}

export interface HookAction {
	readonly type: 'command' | 'agent';
	/** Shell command line, for `type: "command"`. */
	readonly command?: string;
	/** Prompt sent to the active agent, for `type: "agent"`. */
	readonly prompt?: string;
	/** Only meaningful on a `Stop`/`AgentStop` hook whose action is `command`. */
	readonly confirm?: HookConfirmConfig;
}

export interface HookDefinition {
	/** Stable identity for TreeView selection and toggling: `${sourceFile}#${name}`. */
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly enabled: boolean;
	readonly trigger: HookTrigger;
	/** Regex tested against the file path (file triggers) or the tool name (Pre/PostToolUse). */
	readonly matcher?: string;
	/** Seconds; `0` disables the timeout. */
	readonly timeout: number;
	readonly action: HookAction;
	readonly scope: 'workspace' | 'global';
	readonly sourceFile: string;
}

export interface HookFileV1 {
	readonly version: 'v1';
	readonly hooks: readonly RawHookEntry[];
}

export interface RawHookEntry {
	readonly name?: unknown;
	readonly description?: unknown;
	readonly enabled?: unknown;
	readonly trigger?: unknown;
	readonly matcher?: unknown;
	readonly timeout?: unknown;
	readonly action?: unknown;
}

export interface ParsedHookFile {
	readonly hooks: readonly HookDefinition[];
	readonly errors: readonly string[];
	/** `true` when the file was in the pre-M3.6.6 legacy single-hook shape and was upconverted in memory. */
	readonly migrated: boolean;
}

function parseAction(raw: unknown, hookName: string, errors: string[]): HookAction | undefined {
	if (!raw || typeof raw !== 'object') {
		errors.push(`Hook "${hookName}": missing "action".`);
		return undefined;
	}
	const obj = raw as Record<string, unknown>;
	const type = obj.type === 'command' || obj.type === 'agent' ? obj.type : undefined;
	if (!type) {
		errors.push(`Hook "${hookName}": action.type must be "command" or "agent".`);
		return undefined;
	}
	if (type === 'command' && typeof obj.command !== 'string') {
		errors.push(`Hook "${hookName}": action.type "command" requires a string "command".`);
		return undefined;
	}
	if (type === 'agent' && typeof obj.prompt !== 'string') {
		errors.push(`Hook "${hookName}": action.type "agent" requires a string "prompt".`);
		return undefined;
	}

	let confirm: HookConfirmConfig | undefined;
	if (obj.confirm && typeof obj.confirm === 'object') {
		const c = obj.confirm as Record<string, unknown>;
		const options = Array.isArray(c.options)
			? c.options
				.filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
				.map(o => ({
					id: typeof o.id === 'string' ? o.id : String(o.label ?? ''),
					label: typeof o.label === 'string' ? o.label : String(o.id ?? ''),
					run: typeof o.run === 'string' ? o.run : undefined,
				}))
				.filter(o => o.label.length > 0)
			: [];
		if (typeof c.question === 'string' && options.length > 0) {
			confirm = { question: c.question, options, confirmCommand: typeof c.confirmCommand === 'string' ? c.confirmCommand : undefined };
		}
	}

	return {
		type,
		command: typeof obj.command === 'string' ? obj.command : undefined,
		prompt: typeof obj.prompt === 'string' ? obj.prompt : undefined,
		confirm,
	};
}

function parseHookEntry(raw: RawHookEntry, scope: 'workspace' | 'global', sourceFile: string, errors: string[]): HookDefinition | undefined {
	const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : undefined;
	if (!name) {
		errors.push('A hook entry is missing its "name".');
		return undefined;
	}
	const triggerRaw = typeof raw.trigger === 'string' ? raw.trigger : undefined;
	const trigger = triggerRaw ? normalizeTrigger(triggerRaw) : undefined;
	if (!trigger) {
		errors.push(`Hook "${name}": unknown or missing "trigger" ("${String(raw.trigger)}").`);
		return undefined;
	}
	const action = parseAction(raw.action, name, errors);
	if (!action) {
		return undefined;
	}

	return {
		id: `${sourceFile}#${name}`,
		name,
		description: typeof raw.description === 'string' ? raw.description : undefined,
		enabled: raw.enabled !== false,
		trigger,
		matcher: typeof raw.matcher === 'string' && raw.matcher.length > 0 ? raw.matcher : undefined,
		timeout: typeof raw.timeout === 'number' && raw.timeout >= 0 ? raw.timeout : 60,
		action,
		scope,
		sourceFile,
	};
}

/**
 * Validates and normalizes one `.tarot/hooks/*.json` (or `~/.tarot/hooks/*.json`) file into the
 * `v1` schema, transparently upconverting the pre-M3.6.6 legacy single-hook shape in memory.
 * Pure (no filesystem/vscode access) so it is unit-testable.
 */
export function parseHookFile(raw: unknown, sourceFile: string, scope: 'workspace' | 'global'): ParsedHookFile {
	const errors: string[] = [];
	let fileV1: HookFileV1 | undefined;
	let migrated = false;

	if (raw && typeof raw === 'object' && (raw as Record<string, unknown>).version === 'v1' && Array.isArray((raw as Record<string, unknown>).hooks)) {
		fileV1 = raw as HookFileV1;
	} else {
		const legacy = migrateLegacyHookFile(raw);
		if (legacy) {
			fileV1 = legacy;
			migrated = true;
		}
	}

	if (!fileV1) {
		return { hooks: [], errors: [`"${sourceFile}" is not a recognized Agent Hooks v1 (or legacy) file.`], migrated: false };
	}

	const hooks: HookDefinition[] = [];
	for (const entry of fileV1.hooks) {
		const parsed = parseHookEntry(entry, scope, sourceFile, errors);
		if (parsed) {
			hooks.push(parsed);
		}
	}

	return { hooks, errors, migrated };
}
