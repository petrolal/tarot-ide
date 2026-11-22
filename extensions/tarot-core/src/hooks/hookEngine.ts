/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { HookRunContext, runHookCommand } from './hookRunner';
import { HookDefinition, HookTrigger, parseHookFile } from './hookTypes';

export interface DiscoveredHookFile {
	readonly sourceFile: string;
	readonly scope: 'workspace' | 'global';
	readonly hooks: readonly HookDefinition[];
	readonly errors: readonly string[];
	readonly migrated: boolean;
}

/**
 * Selects the enabled hooks for a trigger, optionally filtering by `matcher` (a regex tested
 * against `matchInput`: the saved file's relative path for file triggers, the tool name for
 * `Pre`/`PostToolUse`). A hook with no `matcher` always matches. Pure — unit-testable.
 */
export function selectHooksForTrigger(hooks: readonly HookDefinition[], trigger: HookTrigger, matchInput?: string): HookDefinition[] {
	return hooks.filter(hook => {
		if (!hook.enabled || hook.trigger !== trigger) {
			return false;
		}
		if (!hook.matcher) {
			return true;
		}
		if (matchInput === undefined) {
			return false;
		}
		try {
			return new RegExp(hook.matcher, 'i').test(matchInput);
		} catch {
			return false;
		}
	});
}

export interface HookRunWarning {
	readonly hook: HookDefinition;
	readonly message: string;
}

export interface HookAgentAction {
	readonly hook: HookDefinition;
	readonly prompt: string;
}

export interface HookRunSummary {
	readonly blocked: boolean;
	readonly blockedBy?: HookDefinition;
	readonly blockReason?: string;
	/** Command stdout (and, for `PromptSubmit`, inline `agent`-action prompts) to fold into the turn's context. */
	readonly contextAppend: readonly string[];
	/** `agent`-action hooks to dispatch as their own prompt (every trigger except `PromptSubmit`). */
	readonly agentActions: readonly HookAgentAction[];
	readonly warnings: readonly HookRunWarning[];
}

const EMPTY_SUMMARY: HookRunSummary = { blocked: false, contextAppend: [], agentActions: [], warnings: [] };

/**
 * Runs every enabled, matching hook for `trigger` in a serial queue (per `AGENTS.md` §2d hook
 * safety rules), honoring the `exit 0`/`exit 2`/other exit-code contract. Never called when the
 * workspace is untrusted — callers must gate on `vscode.workspace.isTrusted` themselves, since
 * this module stays free of the `vscode` import to remain unit-testable.
 */
export async function runHooksForTrigger(
	hooks: readonly HookDefinition[],
	trigger: HookTrigger,
	context: Omit<HookRunContext, 'hook_event_name'>,
	options?: {
		readonly matchInput?: string;
		/** `PromptSubmit` appends `agent`-action prompts inline instead of queuing them as separate turns. */
		readonly inlineAgentPrompts?: boolean;
		readonly runCommand?: typeof runHookCommand;
	},
): Promise<HookRunSummary> {
	const selected = selectHooksForTrigger(hooks, trigger, options?.matchInput);
	if (selected.length === 0) {
		return EMPTY_SUMMARY;
	}

	const runCommand = options?.runCommand ?? runHookCommand;
	const contextAppend: string[] = [];
	const agentActions: HookAgentAction[] = [];
	const warnings: HookRunWarning[] = [];

	for (const hook of selected) {
		if (hook.action.type === 'agent') {
			const prompt = hook.action.prompt ?? '';
			if (options?.inlineAgentPrompts) {
				if (prompt) {
					contextAppend.push(`[Hook: ${hook.name}]\n${prompt}`);
				}
			} else {
				agentActions.push({ hook, prompt });
			}
			continue;
		}

		if (!hook.action.command) {
			continue;
		}
		const outcome = await runCommand(hook.action.command, { ...context, hook_event_name: trigger }, hook.timeout);
		if (outcome.kind === 'block') {
			return {
				blocked: true,
				blockedBy: hook,
				blockReason: outcome.stderr || `Hook "${hook.name}" denied this action (exit 2).`,
				contextAppend,
				agentActions,
				warnings,
			};
		}
		if (outcome.kind === 'ok' && outcome.stdout) {
			contextAppend.push(`[Hook: ${hook.name}]\n${outcome.stdout}`);
		} else if (outcome.kind === 'warn') {
			warnings.push({ hook, message: outcome.stderr || `Hook "${hook.name}" exited with code ${outcome.exitCode}.` });
		} else if (outcome.kind === 'timeout') {
			warnings.push({ hook, message: `Hook "${hook.name}" timed out after ${hook.timeout}s.` });
		}
	}

	return { blocked: false, contextAppend, agentActions, warnings };
}

export class TarotHookEngine {
	getGlobalHooksDir(): string {
		return path.join(os.homedir(), '.tarot', 'hooks');
	}

	getWorkspaceHooksDir(workspaceRoot: string): string {
		return path.join(workspaceRoot, '.tarot', 'hooks');
	}

	async discoverFiles(workspaceRoot?: string): Promise<DiscoveredHookFile[]> {
		const files: DiscoveredHookFile[] = [];
		files.push(...await this.readHooksDirectory(this.getGlobalHooksDir(), 'global'));
		if (workspaceRoot) {
			files.push(...await this.readHooksDirectory(this.getWorkspaceHooksDir(workspaceRoot), 'workspace'));
		}
		return files;
	}

	async discover(workspaceRoot?: string): Promise<HookDefinition[]> {
		const files = await this.discoverFiles(workspaceRoot);
		return files.flatMap(f => f.hooks);
	}

	private async readHooksDirectory(dirPath: string, scope: 'workspace' | 'global'): Promise<DiscoveredHookFile[]> {
		try {
			const entries = await fs.readdir(dirPath, { withFileTypes: true });
			const jsonFiles = entries.filter(e => e.isFile() && e.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name));

			const results: DiscoveredHookFile[] = [];
			for (const entry of jsonFiles) {
				const fullPath = path.join(dirPath, entry.name);
				try {
					const raw = JSON.parse(await fs.readFile(fullPath, 'utf8'));
					const parsed = parseHookFile(raw, fullPath, scope);
					results.push({ sourceFile: fullPath, scope, hooks: parsed.hooks, errors: parsed.errors, migrated: parsed.migrated });
				} catch (err) {
					results.push({ sourceFile: fullPath, scope, hooks: [], errors: [err instanceof Error ? err.message : String(err)], migrated: false });
				}
			}
			return results;
		} catch {
			return [];
		}
	}

	/** Flips a single hook's `enabled` flag in its source file. Caller must confirm the write first. */
	async setHookEnabled(sourceFile: string, hookName: string, enabled: boolean): Promise<boolean> {
		try {
			const raw = JSON.parse(await fs.readFile(sourceFile, 'utf8'));
			if (!raw || typeof raw !== 'object' || !Array.isArray(raw.hooks)) {
				return false;
			}
			let found = false;
			for (const hook of raw.hooks) {
				if (hook && typeof hook === 'object' && hook.name === hookName) {
					hook.enabled = enabled;
					found = true;
				}
			}
			if (!found) {
				return false;
			}
			await fs.writeFile(sourceFile, JSON.stringify(raw, null, 2) + '\n', 'utf8');
			return true;
		} catch {
			return false;
		}
	}
}
