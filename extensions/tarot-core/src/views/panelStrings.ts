/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Localized strings shared by the Tarot Agent webview.
 *
 * The host renders the static shell (`buildHtml`) and also injects this catalog into the webview
 * as `window.__tarotL10n`, so `media/webview/panel.js` can localize everything it renders at
 * runtime without duplicating source strings.
 *
 * Placeholders use the `l10n` `{0}`, `{1}` syntax and are interpolated by the webview, so entries
 * with placeholders are returned as literal messages (no substitution arguments here).
 */
export interface TarotPanelStrings {
	readonly newSession: string;
	readonly dockEditorTab: string;
	readonly toggleFocusMode: string;
	readonly closeTab: string;
	readonly refreshGitDiff: string;
	readonly fileChanged: string;
	readonly filesChanged: string;
	readonly openDiff: string;
	readonly revertFile: string;
	readonly contextProvidersTitle: string;
	readonly contextFileDesc: string;
	readonly contextFolderDesc: string;
	readonly contextSpecDesc: string;
	readonly contextProblemsDesc: string;
	readonly contextGitDiffDesc: string;
	readonly contextCodebaseDesc: string;
	readonly contextTerminalDesc: string;
	readonly contextSteeringDesc: string;
	readonly slashCommandsTitle: string;
	readonly slashSpecDesc: string;
	readonly slashQuickSpecDesc: string;
	readonly slashGenerateSpecDesc: string;
	readonly slashPlanDesc: string;
	readonly slashSteeringDesc: string;
	readonly slashReviewDesc: string;
	readonly slashFocusDesc: string;
	readonly slashClearDesc: string;
	readonly send: string;
	readonly stopExecution: string;
	readonly promptPlaceholder: string;
	readonly contextProvidersHint: string;
	readonly slashCommandsHint: string;
	readonly attachActiveFile: string;
	readonly contextUsage: string;
	readonly localAgentAria: string;
	readonly modeAria: string;
	readonly autopilotHint: string;
	readonly emptyTitle: string;
	readonly emptySubtitle: string;
	readonly modeVibeTitle: string;
	readonly modeVibeDesc: string;
	readonly modeSpecTitle: string;
	readonly modeSpecDesc: string;
	readonly modePlanTitle: string;
	readonly modePlanDesc: string;
	readonly modeBugfixTitle: string;
	readonly modeBugfixDesc: string;
	readonly modeQuickSpecTitle: string;
	readonly modeQuickSpecDesc: string;
	readonly pbtCounterExampleTitle: string;
	readonly saveRuleToSteering: string;
	readonly savedToSteering: string;
	readonly steeringDoc: string;
	readonly steeringDocs: string;
	readonly thoughtComplete: string;
	readonly toolCall: string;
	readonly toolCalls: string;
	readonly updatedTaskList: string;
	readonly approved: string;
	readonly elapsedTime: string;
	readonly restoreCheckpoint: string;
	readonly copy: string;
	readonly copied: string;
	readonly runAgentError: string;
}

/** Builds the localized webview string catalog for the current UI language. */
export function getPanelStrings(): TarotPanelStrings {
	return {
		newSession: vscode.l10n.t('New Session'),
		dockEditorTab: vscode.l10n.t('Open Session in Editor Tab (Dockable Tab)'),
		toggleFocusMode: vscode.l10n.t('Toggle Agent Focus Mode'),
		closeTab: vscode.l10n.t('Close Tab'),
		refreshGitDiff: vscode.l10n.t('Refresh Git Diff'),
		fileChanged: vscode.l10n.t('file changed'),
		filesChanged: vscode.l10n.t('files changed'),
		openDiff: vscode.l10n.t('Open diff: {0}'),
		revertFile: vscode.l10n.t('Revert {0}'),
		contextProvidersTitle: vscode.l10n.t('Context Providers (#)'),
		contextFileDesc: vscode.l10n.t('Pick a file from the workspace'),
		contextFolderDesc: vscode.l10n.t('List a project directory'),
		contextSpecDesc: vscode.l10n.t('Attach a Spec from .tarot/specs/'),
		contextProblemsDesc: vscode.l10n.t('Active errors and warnings'),
		contextGitDiffDesc: vscode.l10n.t('Current changes (git diff HEAD)'),
		contextCodebaseDesc: vscode.l10n.t('Workspace file map'),
		contextTerminalDesc: vscode.l10n.t('Active terminal context'),
		contextSteeringDesc: vscode.l10n.t('Steering document (workspace/global)'),
		slashCommandsTitle: vscode.l10n.t('Slash Commands (/)'),
		slashSpecDesc: vscode.l10n.t('Create a new Feature or Bugfix Spec (EARS)'),
		slashQuickSpecDesc: vscode.l10n.t('Generate requirements, design and tasks in one pass (no gates)'),
		slashGenerateSpecDesc: vscode.l10n.t('Convert the current Vibe session into a Spec'),
		slashPlanDesc: vscode.l10n.t('Switch to Plan Mode (read-only)'),
		slashSteeringDesc: vscode.l10n.t('Generate Steering docs (product/tech/structure)'),
		slashReviewDesc: vscode.l10n.t('Review #Git Diff + #Problems with the agent'),
		slashFocusDesc: vscode.l10n.t('Toggle Agent Focus Mode'),
		slashClearDesc: vscode.l10n.t('Start a clean new session'),
		send: vscode.l10n.t('Send (Enter)'),
		stopExecution: vscode.l10n.t('Stop Execution'),
		promptPlaceholder: vscode.l10n.t('Ask a question or describe a task...'),
		contextProvidersHint: vscode.l10n.t('Context Providers (#)'),
		slashCommandsHint: vscode.l10n.t('Slash Commands (/)'),
		attachActiveFile: vscode.l10n.t('Attach Active File (Ctrl+L)'),
		contextUsage: vscode.l10n.t('Estimated context usage: {0}%'),
		localAgentAria: vscode.l10n.t('Local agent'),
		modeAria: vscode.l10n.t('Mode (Shift+Tab)'),
		autopilotHint: vscode.l10n.t('Autopilot applies edits directly; disabled enables Supervised mode'),
		emptyTitle: vscode.l10n.t("Let's build"),
		emptySubtitle: vscode.l10n.t('Choose a workflow or type # to attach context.'),
		modeVibeTitle: vscode.l10n.t('Vibe'),
		modeVibeDesc: vscode.l10n.t('Quick chat to explore, edit and debug code.'),
		modeSpecTitle: vscode.l10n.t('Spec'),
		modeSpecDesc: vscode.l10n.t('Plan requirements (EARS), design and tasks before coding.'),
		modePlanTitle: vscode.l10n.t('Plan'),
		modePlanDesc: vscode.l10n.t('Read-only investigation and architecture planning.'),
		modeBugfixTitle: vscode.l10n.t('Bug Fix'),
		modeBugfixDesc: vscode.l10n.t('Capture defect, root cause and regression checks.'),
		modeQuickSpecTitle: vscode.l10n.t('Quick Spec'),
		modeQuickSpecDesc: vscode.l10n.t('Generate requirements, design and tasks directly without approval gates.'),
		pbtCounterExampleTitle: vscode.l10n.t('PBT Counter-example'),
		saveRuleToSteering: vscode.l10n.t('Save rule to steering'),
		savedToSteering: vscode.l10n.t('✓ Saved to steering'),
		steeringDoc: vscode.l10n.t('1 steering doc'),
		steeringDocs: vscode.l10n.t('{0} steering docs'),
		thoughtComplete: vscode.l10n.t('Thought complete'),
		toolCall: vscode.l10n.t('1 tool call'),
		toolCalls: vscode.l10n.t('{0} tool calls'),
		updatedTaskList: vscode.l10n.t('Updated task list'),
		approved: vscode.l10n.t('✓ Approved · {0}'),
		elapsedTime: vscode.l10n.t('Elapsed time: {0}'),
		restoreCheckpoint: vscode.l10n.t('↺ Restore Checkpoint'),
		copy: vscode.l10n.t('Copy'),
		copied: vscode.l10n.t('Copied!'),
		runAgentError: vscode.l10n.t('Failed to run the agent.'),
	};
}
