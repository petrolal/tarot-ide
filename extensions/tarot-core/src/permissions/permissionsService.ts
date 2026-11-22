/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { HookRunContext, HookCommandOutcome, runHookCommand } from '../hooks/hookRunner';
import { Capability, parsePermissionsDocument, PermissionRule, PermissionScope } from './permissionTypes';
import { EvaluationOptions, evaluateCapability, evaluateShellCommand, PermissionDecision, TAROT_INVARIANT_RULES } from './policyEngine';
import { getPreset } from './presets';
import { TarotTrustService } from './trustService';
import { parseYamlLite, YamlLiteError } from './yamlLite';

export interface LoadedPermissionsFile {
	readonly rules: readonly PermissionRule[];
	readonly errors: readonly string[];
}

async function loadPermissionsFile(filePath: string): Promise<LoadedPermissionsFile> {
	try {
		const text = await fs.readFile(filePath, 'utf8');
		const raw = parseYamlLite(text);
		const expanded = expandPresets(raw, filePath);
		return parsePermissionsDocument(expanded, filePath);
	} catch (err) {
		if (err instanceof YamlLiteError) {
			return { rules: [], errors: [`${filePath}: ${err.message}`] };
		}
		// File does not exist yet (or is unreadable) — treated as "no rules", not an error.
		return { rules: [], errors: [] };
	}
}

/** Expands any `{ preset: "<name>" }` rule entry in-place before schema validation. */
function expandPresets(raw: unknown, sourceFile: string): unknown {
	if (!raw || typeof raw !== 'object') {
		return raw;
	}
	const doc = raw as { rules?: unknown };
	if (!Array.isArray(doc.rules)) {
		return raw;
	}
	const expanded: unknown[] = [];
	for (const entry of doc.rules) {
		if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).preset === 'string') {
			const preset = getPreset((entry as Record<string, unknown>).preset as string);
			if (preset) {
				expanded.push(...preset);
				continue;
			}
			throw new YamlLiteError(`${sourceFile}: unknown preset "${(entry as Record<string, unknown>).preset}".`);
		}
		expanded.push(entry);
	}
	return { ...doc, rules: expanded };
}

/**
 * Orchestrates the capability-based permission policy (MIGRATION_PLAN.md M3.8a): loads the
 * `tarot` (fixed invariants), `user` (`~/.tarot/settings/permissions.yaml`) and `workspace`
 * (`~/.tarot-ide/workspace-roots/<hash>/permissions.yaml`, outside the repo) scopes, merges them
 * with the in-memory `session` scope ("Always allow/deny" answers from approval prompts), and
 * evaluates capabilities through the pure `policyEngine`. Workspace-scope rules are never loaded
 * in an untrusted workspace.
 */
export class TarotPermissionsService implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangePolicy = this.changeEmitter.event;

	private scopesCache: readonly PermissionScope[] | undefined;
	private sessionRules: PermissionRule[] = [];
	private workspaceWatcher: vscode.FileSystemWatcher | undefined;
	private watchedWorkspacePath: string | undefined;
	/** Last reported errors per `permissions.yaml` path, so a toast only reappears when the errors actually change (e.g. the user fixed one typo but another rule is still malformed), not on every reload of an already-known-bad file. */
	private readonly lastReportedErrors = new Map<string, string>();

	constructor(
		private readonly trustService: TarotTrustService,
		private readonly outputChannel: vscode.OutputChannel,
	) {
		const userPath = this.trustService.getUserPermissionsPath();
		const userWatcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(vscode.Uri.file(path.dirname(userPath)), path.basename(userPath)),
		);
		this.disposables.push(
			trustService.onDidChangeTrust(() => this.invalidate()),
			this.changeEmitter,
			userWatcher,
			userWatcher.onDidCreate(() => this.invalidate()),
			userWatcher.onDidChange(() => this.invalidate()),
			userWatcher.onDidDelete(() => this.invalidate()),
		);
	}

	invalidate(): void {
		this.scopesCache = undefined;
		this.changeEmitter.fire();
	}

	private watchWorkspacePermissionsFile(workspacePath: string): void {
		if (this.watchedWorkspacePath === workspacePath) {
			return;
		}
		this.workspaceWatcher?.dispose();
		this.watchedWorkspacePath = workspacePath;
		this.workspaceWatcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(vscode.Uri.file(path.dirname(workspacePath)), path.basename(workspacePath)),
		);
		this.disposables.push(
			this.workspaceWatcher,
			this.workspaceWatcher.onDidCreate(() => this.invalidate()),
			this.workspaceWatcher.onDidChange(() => this.invalidate()),
			this.workspaceWatcher.onDidDelete(() => this.invalidate()),
		);
	}

	/**
	 * Parse errors from `permissionTypes.parsePermissionsDocument`/`yamlLite` were computed but
	 * never surfaced anywhere — a typo silently dropped rules (or the whole file), with no sign
	 * the configured policy was not actually in effect (gap found in code review, 2026-11-22).
	 * Logs every error and shows one toast per file whose error set actually changed since the
	 * last report, naming the file so the user can jump straight to fixing it.
	 */
	private reportLoadErrors(filePath: string, errors: readonly string[]): void {
		const key = errors.join('\n');
		if (errors.length === 0) {
			this.lastReportedErrors.delete(filePath);
			return;
		}
		if (this.lastReportedErrors.get(filePath) === key) {
			return;
		}
		this.lastReportedErrors.set(filePath, key);
		for (const error of errors) {
			this.outputChannel.appendLine(`[Permissions] ${error}`);
		}
		const openLabel = vscode.l10n.t('Open File');
		void vscode.window.showWarningMessage(
			vscode.l10n.t('{0} rule(s) in {1} could not be loaded — see the Tarot IDE output channel for details. The rest of your permissions policy still applies.', errors.length, path.basename(filePath)),
			openLabel,
		).then(choice => {
			if (choice === openLabel) {
				void vscode.workspace.openTextDocument(filePath).then(doc => vscode.window.showTextDocument(doc));
			}
		});
	}

	async loadScopes(): Promise<readonly PermissionScope[]> {
		if (this.scopesCache) {
			return this.scopesCache;
		}
		const scopes: PermissionScope[] = [{ id: 'tarot', rules: TAROT_INVARIANT_RULES }];

		const userPath = this.trustService.getUserPermissionsPath();
		const userFile = await loadPermissionsFile(userPath);
		this.reportLoadErrors(userPath, userFile.errors);
		scopes.push({ id: 'user', rules: userFile.rules, sourceFile: userPath });

		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (workspaceRoot && this.trustService.isWorkspaceTrusted()) {
			const workspacePath = this.trustService.getWorkspacePermissionsPath(workspaceRoot);
			this.watchWorkspacePermissionsFile(workspacePath);
			const workspaceFile = await loadPermissionsFile(workspacePath);
			this.reportLoadErrors(workspacePath, workspaceFile.errors);
			scopes.push({ id: 'workspace', rules: workspaceFile.rules, sourceFile: workspacePath });
		}

		scopes.push({ id: 'session', rules: this.sessionRules });
		this.scopesCache = scopes;
		return scopes;
	}

	async evaluate(capability: Capability, value?: string, options?: EvaluationOptions): Promise<PermissionDecision> {
		const scopes = await this.loadScopes();
		return evaluateCapability(scopes, capability, value, options);
	}

	async evaluateShellCommand(command: string, options?: EvaluationOptions) {
		const scopes = await this.loadScopes();
		return evaluateShellCommand(scopes, command, options);
	}

	/** `always: true` persists the rule to the user scope file; otherwise it only lives for this IDE session. */
	async recordDecision(rule: PermissionRule, always: boolean): Promise<void> {
		if (!always) {
			this.sessionRules = [...this.sessionRules, rule];
			this.invalidate();
			return;
		}
		const userPath = this.trustService.getUserPermissionsPath();
		await this.appendUserRule(userPath, rule);
		this.invalidate();
	}

	private async appendUserRule(filePath: string, rule: PermissionRule): Promise<void> {
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		let text: string;
		try {
			text = await fs.readFile(filePath, 'utf8');
		} catch {
			text = 'version: 1\nrules:\n';
		}
		if (!/\brules:\s*(\n|$)/.test(text)) {
			text = text.trimEnd() + '\nrules:\n';
		}
		const lines = [
			`  - capability: ${rule.capability}`,
			`    effect: ${rule.effect}`,
		];
		if (rule.match && rule.match.length > 0) {
			lines.push('    match:', ...rule.match.map(m => `      - ${JSON.stringify(m)}`));
		}
		if (rule.reason) {
			lines.push(`    reason: ${JSON.stringify(rule.reason)}`);
		}
		await fs.writeFile(filePath, text.trimEnd() + '\n' + lines.join('\n') + '\n', 'utf8');
	}

	/**
	 * Wraps `runHookCommand` with the policy engine: `deny` skips the process entirely, `ask`
	 * shows a blocking approval prompt (Allow / Always Allow / Deny / Always Deny), and `allow`
	 * runs it directly. This is the one hook action Tarot itself dispatches, so the decision is
	 * genuinely **enforced** (`policyEngine.getEnforcementKind('tarot')`), unlike a BYOA agent's
	 * own internal tool calls. `headless: true` (automatic file-trigger hooks) downgrades `ask`
	 * to a silent `deny` instead of popping a prompt on every save.
	 */
	createGatedRunCommand(outputChannel: vscode.OutputChannel, options?: { headless?: boolean }): typeof runHookCommand {
		return async (command: string, context: HookRunContext, timeoutSeconds: number): Promise<HookCommandOutcome> => {
			const result = await this.evaluateShellCommand(command, { headless: options?.headless });
			if (result.decision.effect === 'deny') {
				outputChannel.appendLine(`[Permissions] shell denied: ${command} — ${result.decision.reason ?? ''}`);
				return { kind: 'block', stderr: result.decision.reason ?? vscode.l10n.t('Denied by permissions policy.') };
			}
			if (result.decision.effect === 'ask') {
				const allowed = await this.promptApproval(command, result.decision);
				if (!allowed) {
					return { kind: 'block', stderr: vscode.l10n.t('Denied by user.') };
				}
			}
			return runHookCommand(command, context, timeoutSeconds);
		};
	}

	private async promptApproval(command: string, decision: PermissionDecision): Promise<boolean> {
		const allowLabel = vscode.l10n.t('Allow');
		const alwaysAllowLabel = vscode.l10n.t('Always Allow');
		const denyLabel = vscode.l10n.t('Deny');
		const alwaysDenyLabel = vscode.l10n.t('Always Deny');
		const choice = await vscode.window.showWarningMessage(
			vscode.l10n.t('Run this shell command?\n\n{0}\n\n{1}', command, decision.reason ?? ''),
			{ modal: true },
			allowLabel, alwaysAllowLabel, denyLabel, alwaysDenyLabel,
		);
		if (choice === alwaysAllowLabel) {
			await this.recordDecision({ capability: 'shell', effect: 'allow', match: [command] }, true);
			return true;
		}
		if (choice === alwaysDenyLabel) {
			await this.recordDecision({ capability: 'shell', effect: 'deny', match: [command] }, true);
			return false;
		}
		return choice === allowLabel;
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
