/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TarotWorkflowRunStore } from '../workflows/runStore';
import { WorkflowRunState } from '../workflows/workflowTypes';
import { classifyRunGroup, filterWorkflowRuns, WorkflowRunGroupKey } from '../workflows/workflowViewHelpers';

export { classifyRunGroup, filterWorkflowRuns, WorkflowRunGroupKey };

class RunTreeItem extends vscode.TreeItem {
	constructor(
		label: string,
		collapsibleState: vscode.TreeItemCollapsibleState,
		readonly children?: RunTreeItem[],
		readonly run?: WorkflowRunState,
	) {
		super(label, collapsibleState);
	}
}

function arcanaIcon(extensionUri: vscode.Uri, fileName: string): { light: vscode.Uri; dark: vscode.Uri } {
	return {
		light: vscode.Uri.joinPath(extensionUri, 'icons', 'arcana', 'light', fileName),
		dark: vscode.Uri.joinPath(extensionUri, 'icons', 'arcana', fileName),
	};
}

/**
 * `WORKFLOW RUNS` TreeView (MIGRATION_PLAN.md M3.9b): groups persisted runs by status with
 * "Needs you" first, shows timestamp + step sub-items (`✓ validate`), and supports live search.
 */
export class WorkflowRunsTreeProvider implements vscode.TreeDataProvider<RunTreeItem>, vscode.Disposable {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<RunTreeItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private readonly disposables: vscode.Disposable[] = [];
	private searchQuery = '';

	constructor(
		private readonly runStore: TarotWorkflowRunStore,
		private readonly extensionUri: vscode.Uri,
	) {
		const watcher = vscode.workspace.createFileSystemWatcher('**/.tarot/workflows/runs/*.json');
		this.disposables.push(
			this._onDidChangeTreeData,
			watcher,
			watcher.onDidCreate(() => this.refresh()),
			watcher.onDidChange(() => this.refresh()),
			watcher.onDidDelete(() => this.refresh()),
			vscode.workspace.onDidGrantWorkspaceTrust(() => this.refresh()),
		);
	}

	setSearchQuery(query: string): void {
		this.searchQuery = query.trim();
		this.refresh();
	}

	getSearchQuery(): string {
		return this.searchQuery;
	}

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: RunTreeItem): vscode.TreeItem {
		return element;
	}

	private toRunItem(run: WorkflowRunState): RunTreeItem {
		const steps = Object.values(run.stepStates);
		const stepItems = steps.map(step => {
			const icon = step.status === 'completed' ? '✓'
				: step.status === 'failed' ? '✗'
					: step.status === 'paused' ? '⏸'
						: step.status === 'running' ? '●'
							: '○';
			const child = new RunTreeItem(`${icon} ${step.id}`, vscode.TreeItemCollapsibleState.None);
			child.description = step.agent ?? step.status;
			child.command = {
				command: 'tarot.workflows.openRun',
				title: vscode.l10n.t('Open Workflow Run'),
				arguments: [run.id, step.id],
			};
			return child;
		});

		const item = new RunTreeItem(
			run.recipeName,
			stepItems.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
			stepItems,
			run,
		);
		const ts = new Date(run.updatedAt || run.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		const doneCount = steps.filter(s => s.status === 'completed').length;
		item.description = `${run.status}${run.pauseReason ? ` (${run.pauseReason})` : ''} · ${doneCount}/${steps.length} · ${ts}`;
		item.iconPath = run.recipeName === 'publish-pr'
			? arcanaIcon(this.extensionUri, '17-the-star.svg')
			: arcanaIcon(this.extensionUri, '10-wheel-of-fortune.svg');
		item.tooltip = `${run.recipeName}\nID: ${run.id}\nStatus: ${run.status}${run.pauseReason ? ` (${run.pauseReason})` : ''}`;
		item.command = {
			command: 'tarot.workflows.openRun',
			title: vscode.l10n.t('Open Workflow Run'),
			arguments: [run.id],
		};
		return item;
	}

	async getChildren(element?: RunTreeItem): Promise<RunTreeItem[]> {
		if (element?.children) {
			return element.children;
		}
		if (!vscode.workspace.isTrusted) {
			return [];
		}
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root) {
			return [];
		}
		const allRuns = await this.runStore.listRuns(root);
		const runs = filterWorkflowRuns(allRuns, this.searchQuery);
		if (runs.length === 0) {
			return [];
		}

		const groupOrder: Array<{ key: WorkflowRunGroupKey; label: string; icon: string }> = [
			{ key: 'needsYou', label: vscode.l10n.t('Needs you'), icon: 'bell-dot' },
			{ key: 'running', label: vscode.l10n.t('Running'), icon: 'sync~spin' },
			{ key: 'paused', label: vscode.l10n.t('Paused'), icon: 'debug-pause' },
			{ key: 'completed', label: vscode.l10n.t('Completed'), icon: 'pass' },
			{ key: 'failed', label: vscode.l10n.t('Failed / Aborted'), icon: 'error' },
		];

		const groups: RunTreeItem[] = [];
		for (const def of groupOrder) {
			const bucket = runs.filter(r => classifyRunGroup(r) === def.key);
			if (bucket.length === 0) {
				continue;
			}
			const groupItem = new RunTreeItem(
				def.label,
				vscode.TreeItemCollapsibleState.Expanded,
				bucket.map(r => this.toRunItem(r)),
			);
			groupItem.description = `${bucket.length}`;
			groupItem.iconPath = new vscode.ThemeIcon(def.icon);
			groups.push(groupItem);
		}
		return groups;
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
