/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import { parseShellCommand, ShellSegment } from './shellParser';
import { Capability, Effect, effectIsMoreRestrictive, PermissionRule, PermissionScope, ruleAppliesTo } from './permissionTypes';

/**
 * Fixed, non-overridable rules (AGENTS.md §2d / MIGRATION_PLAN.md M3.8a invariants): the agent
 * never writes permission/settings files or `.tarotignore`, and every write under `.git/**`,
 * `.vscode/**`, `*.code-workspace` or the `.tarot/{agents,hooks,workflows,powers}` directories
 * always asks — regardless of any `allow` rule in a lower scope, since `deny`/`ask` always beat
 * `allow` once a rule from any scope matches.
 */
export const TAROT_INVARIANT_RULES: readonly PermissionRule[] = [
	{
		capability: 'fs_write',
		effect: 'deny',
		match: ['**/permissions.yaml', '**/.tarot/settings/**', '**/.tarotignore'],
		reason: 'Tarot invariant: the agent never writes permission/settings files.',
	},
	{
		capability: 'fs_write',
		effect: 'ask',
		match: [
			'.git/**', '.vscode/**', '*.code-workspace',
			'.tarot/agents/**', '.tarot/hooks/**', '.tarot/workflows/**', '.tarot/powers/**',
		],
		reason: 'Tarot invariant: always ask before writing here.',
	},
];

export interface PermissionDecision {
	readonly effect: Effect;
	readonly scope?: PermissionScope['id'];
	readonly reason?: string;
	readonly matchedRule?: PermissionRule;
	/** `true` when no rule matched and the default policy (read-only allow / ask, headless → deny) applied. */
	readonly defaulted: boolean;
}

export interface EvaluationOptions {
	/** Automatic, unattended triggers (e.g. a file-save hook) cannot show a blocking prompt: `ask` becomes `deny`. */
	readonly headless?: boolean;
}

function globToRegExp(pattern: string): RegExp {
	let out = '';
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === '*' && pattern[i + 1] === '*') {
			const consumeSlash = pattern[i + 2] === '/';
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
		if (ch === '{') {
			const close = pattern.indexOf('}', i);
			if (close > i) {
				const alts = pattern.slice(i + 1, close).split(',').map(a => a.replace(/[.+^${}()|[\]\\]/g, '\\$&'));
				out += `(?:${alts.join('|')})`;
				i = close;
				continue;
			}
		}
		out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	}
	return new RegExp(`^${out}$`);
}

function simpleWildcardToRegExp(pattern: string): RegExp {
	const escaped = pattern.split('*').map(part => part.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('.*');
	return new RegExp(`^${escaped}$`);
}

function matchesPattern(capability: Capability, pattern: string, value: string): boolean {
	if (capability === 'fs_read' || capability === 'fs_write') {
		return globToRegExp(pattern).test(value);
	}
	return simpleWildcardToRegExp(pattern).test(value);
}

function ruleMatchesValue(rule: PermissionRule, capability: Capability, value: string | undefined): boolean {
	if (!rule.match || rule.match.length === 0) {
		if (rule.exclude && value !== undefined && rule.exclude.some(p => matchesPattern(capability, p, value))) {
			return false;
		}
		return true;
	}
	if (value === undefined) {
		return false;
	}
	if (!rule.match.some(p => matchesPattern(capability, p, value))) {
		return false;
	}
	if (rule.exclude && rule.exclude.some(p => matchesPattern(capability, p, value))) {
		return false;
	}
	// A `match`-scoped `allow` rule (e.g. presets.ts's read-only-shell/dev-shell, or any
	// user-written `match: ['cat *', ...]`) only looks safe because of what its glob names —
	// `cat secrets.env > ~/.bashrc` still matches `cat *` but is a write, not a read. An
	// unscoped `{ capability: 'all'|'shell', effect: 'allow' }` with no `match` (e.g. the
	// allow-all preset) is a deliberate blanket grant and is deliberately NOT narrowed here.
	if (capability === 'shell' && rule.effect === 'allow' && hasUnquotedRedirection(value)) {
		return false;
	}
	return true;
}

const READ_ONLY_GIT_SUBCOMMANDS = ['status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse', 'describe', 'ls-files', 'blame'];

/**
 * `true` if `command` contains a `<` or `>` outside single/double quotes. `shellParser` only
 * splits segments on `;`/`&&`/`||`/`|`, so a redirection like `git show HEAD:f > ~/.bashrc`
 * reaches here as one untouched segment — it is still `git show`, but it is not read-only.
 */
function hasUnquotedRedirection(command: string): boolean {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === '\\' && !inSingle) {
			i++;
			continue;
		}
		if (ch === '\'' && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (!inSingle && !inDouble && (ch === '<' || ch === '>')) {
			return true;
		}
	}
	return false;
}

function isReadOnlyGitCommand(command: string): boolean {
	const trimmed = command.trim();
	const match = /^git\s+(\S+)/.exec(trimmed);
	return !!match && READ_ONLY_GIT_SUBCOMMANDS.includes(match[1]) && !hasUnquotedRedirection(trimmed);
}

function defaultDecision(capability: Capability, value: string | undefined, options: EvaluationOptions | undefined): PermissionDecision {
	if (capability === 'fs_read') {
		return { effect: 'allow', defaulted: true, reason: 'Default: workspace reads are allowed.' };
	}
	if (capability === 'shell' && value !== undefined && isReadOnlyGitCommand(value)) {
		return { effect: 'allow', defaulted: true, reason: 'Default: read-only git commands are allowed.' };
	}
	const effect: Effect = options?.headless ? 'deny' : 'ask';
	return { effect, defaulted: true, reason: options?.headless ? 'Default: headless triggers deny what they cannot ask about.' : 'Default: ask when no rule matches.' };
}

/**
 * Evaluates `capability` against every scope's rules with **no precedence between scopes** — the
 * most restrictive matching effect wins (`deny > ask > allow`), per M3.8a. Rules with effect
 * `evaluate` are skipped: Tarot ships no risk classifier yet, so they contribute no decision
 * (`presets.ts::approve-for-me`).
 */
export function evaluateCapability(
	scopes: readonly PermissionScope[],
	capability: Capability,
	value?: string,
	options?: EvaluationOptions,
): PermissionDecision {
	let best: PermissionDecision | undefined;
	for (const scope of scopes) {
		for (const rule of scope.rules) {
			if (rule.effect === 'evaluate') {
				continue;
			}
			if (!ruleAppliesTo(rule, capability)) {
				continue;
			}
			if (!ruleMatchesValue(rule, capability, value)) {
				continue;
			}
			if (!best || effectIsMoreRestrictive(rule.effect, best.effect)) {
				best = { effect: rule.effect, scope: scope.id, reason: rule.reason, matchedRule: rule, defaulted: false };
			}
		}
	}
	if (best) {
		if (best.effect === 'ask' && options?.headless) {
			return { ...best, effect: 'deny', reason: `${best.reason ?? ''} (headless: ask → deny)`.trim() };
		}
		return best;
	}
	return defaultDecision(capability, value, options);
}

export interface ShellSegmentDecision {
	readonly segment: ShellSegment;
	readonly decision: PermissionDecision;
}

export type ShellEvaluationResult =
	| { readonly ok: true; readonly decision: PermissionDecision; readonly segments: readonly ShellSegmentDecision[] }
	| { readonly ok: false; readonly decision: PermissionDecision; readonly reason: string };

/**
 * Splits `command` into its composite segments (`shellParser`) and evaluates the `shell`
 * capability per segment, returning the most restrictive outcome. Unparseable commands (command
 * substitution, heredocs, unbalanced quotes) are always denied with a rewrite request — the
 * engine cannot reason about what they would do.
 */
export function evaluateShellCommand(
	scopes: readonly PermissionScope[],
	command: string,
	options?: EvaluationOptions,
): ShellEvaluationResult {
	const parsed = parseShellCommand(command);
	if (!parsed.ok) {
		return {
			ok: false,
			reason: parsed.reason,
			decision: { effect: 'deny', defaulted: false, reason: `${parsed.reason} Ask the agent to rewrite this as simple commands.` },
		};
	}
	const segments: ShellSegmentDecision[] = parsed.segments.map(segment => ({
		segment,
		decision: evaluateCapability(scopes, 'shell', segment.text, options),
	}));
	let worst: PermissionDecision = { effect: 'allow', defaulted: true, reason: 'No segments to evaluate.' };
	for (const { decision } of segments) {
		if (effectIsMoreRestrictive(decision.effect, worst.effect)) {
			worst = decision;
		}
	}
	return { ok: true, decision: worst, segments };
}

export type EnforcementKind = 'enforced' | 'advisory';

/**
 * Tarot's own actions (hook `command` actions, git operations, checkpoints) run through this
 * extension's own `spawn`/API calls, so their policy decisions are genuinely **enforced**. A
 * BYOA agent's *internal* tool calls run inside the `claude`/`codex`/`agy` process itself — no
 * CLI exposes a channel to deny a tool call already dispatched (⚠ Risco BYOA, MIGRATION_PLAN.md
 * M3.8a) — so those are always **advisory**: translated into native CLI flags when one exists.
 */
export const TAROT_BUILTIN_ACTOR = 'tarot';

const AGENT_FLAG_TRANSLATION: Readonly<Record<string, string>> = {
	agy: '--mode accept-edits / --mode plan',
};

export function getEnforcementKind(actorId: string): EnforcementKind {
	return actorId === TAROT_BUILTIN_ACTOR ? 'enforced' : 'advisory';
}

export function describeAdvisoryTranslation(agentId: string): string | undefined {
	return AGENT_FLAG_TRANSLATION[agentId];
}
