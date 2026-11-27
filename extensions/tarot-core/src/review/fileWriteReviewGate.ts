/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { evaluateSubagentCapability } from '../agents/subagentManager';
import { AutonomyMode, FileWriteApprovalGate } from '../agents/types';
import { CheckpointDiffEntry, TarotCheckpointService } from '../checkpoints/checkpointService';
import { ChangedFileInfo } from '../git/gitReviewService';
import { TarotPermissionsService } from '../permissions/permissionsService';
import { PermissionRule } from '../permissions/permissionTypes';

export interface FileWriteReviewDeps {
	readonly checkpointService: TarotCheckpointService;
	readonly permissionsService: TarotPermissionsService;
	readonly outputChannel: vscode.OutputChannel;
}

export interface FileWriteReviewParams {
	readonly cwd: string;
	readonly sessionId: string;
	readonly checkpointId: string;
	/** Active agent profile's own permission rules, if any (narrower than the parent scopes). */
	readonly profilePermissions?: readonly PermissionRule[];
	readonly autonomy: AutonomyMode;
	/**
	 * `true` for unattended runs (Schedule/Crew/Subagent DAG) with no human to answer an `ask`
	 * decision — downgrades `ask` to `deny` (and auto-reverts) instead of silently treating the
	 * CLI's own auto-approval as sufficient review (TD-02, AGENTS.md §2d).
	 */
	readonly headless: boolean;
}

export interface FileWriteReviewResult {
	readonly gate?: FileWriteApprovalGate;
	readonly changedFiles: ChangedFileInfo[];
	readonly diffEntries: CheckpointDiffEntry[];
}

/**
 * Re-checks every file a turn just wrote against the configured `fs_write` permission policy,
 * reverting anything a `deny` rule covers (and, in headless contexts, anything that would
 * otherwise require asking a human). This is the single enforcement point shared by the
 * interactive chat panel, Scheduled jobs, Tarot Crew runs and Subagent DAG runs — an agent CLI's
 * own `acceptEdits`/auto-approve mode is never treated as sufficient review on its own (TD-02).
 */
export async function reviewFileWritesForTurn(
	deps: FileWriteReviewDeps,
	params: FileWriteReviewParams,
): Promise<FileWriteReviewResult | undefined> {
	const { cwd, sessionId, checkpointId, profilePermissions, autonomy, headless } = params;
	const diff = await deps.checkpointService.getCheckpointDiff(cwd, sessionId, checkpointId);
	if (diff.length === 0) {
		return undefined;
	}
	const options = headless ? { headless: true } : undefined;
	const parentScopes = profilePermissions?.length ? await deps.permissionsService.loadScopes() : undefined;
	const denied: string[] = [];
	const asked: string[] = [];
	for (const entry of diff) {
		const decision = parentScopes
			? evaluateSubagentCapability(parentScopes, profilePermissions, 'fs_write', entry.relativePath, options)
			: await deps.permissionsService.evaluate('fs_write', entry.relativePath, options);
		if (decision.effect === 'deny') {
			denied.push(entry.relativePath);
		} else if (decision.effect === 'ask') {
			if (!decision.defaulted || autonomy === 'supervised') {
				asked.push(entry.relativePath);
			}
		}
	}
	if (denied.length > 0) {
		const result = await deps.checkpointService.restoreCheckpointFiles(cwd, sessionId, checkpointId, denied);
		deps.outputChannel.appendLine(`[Permissions] fs_write denied, auto-reverted: ${result.reverted.join(', ') || '(none)'}`);
		if (result.skipped.length > 0) {
			deps.outputChannel.appendLine(`[Permissions] fs_write denied but could NOT be reverted (no backup): ${result.skipped.join(', ')}`);
			if (!headless) {
				vscode.window.showWarningMessage(vscode.l10n.t(
					'{0} file(s) were written against denied permissions but could not be auto-reverted (no backup available): {1}',
					result.skipped.length, result.skipped.join(', '),
				));
			}
		}
	}
	const deniedSet = new Set(denied);
	const diffEntries = diff.filter(entry => !deniedSet.has(entry.relativePath));
	const changedFiles: ChangedFileInfo[] = diffEntries.map(entry => ({
		relativePath: entry.relativePath,
		status: entry.status === 'added' ? 'A' : entry.status === 'deleted' ? 'D' : 'M',
		added: 0,
		removed: 0,
	}));
	return {
		gate: asked.length > 0 ? { sessionId, checkpointId, files: asked } : undefined,
		changedFiles,
		diffEntries,
	};
}
