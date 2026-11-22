/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentRuntimeManager } from '../agents/runtimeManager';
import { AgentStatus } from '../agents/types';
import { DiscoveredHookFile, TarotHookEngine } from '../hooks/hookEngine';
import { HookDefinition } from '../hooks/hookTypes';
import { TarotSpecService } from '../specs/specService';
import { SteeringDocument, TarotSteeringService } from '../steering/steeringService';

function getWorkspaceRoot(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function arcanaIcon(extensionUri: vscode.Uri, fileName: string): { light: vscode.Uri; dark: vscode.Uri } {
	return {
		light: vscode.Uri.joinPath(extensionUri, 'icons', 'arcana', 'light', fileName),
		dark: vscode.Uri.joinPath(extensionUri, 'icons', 'arcana', fileName),
	};
}

class SimpleTreeItem extends vscode.TreeItem {
	constructor(
		label: string,
		collapsibleState: vscode.TreeItemCollapsibleState,
		readonly resourcePath?: string,
		readonly children?: SimpleTreeItem[],
	) {
		super(label, collapsibleState);
	}
}

export class LocalAgentsTreeProvider implements vscode.TreeDataProvider<AgentStatus>, vscode.Disposable {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<AgentStatus | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly runtimeManager: AgentRuntimeManager,
		private readonly extensionUri: vscode.Uri,
	) {
		this.disposables.push(
			this._onDidChangeTreeData,
			this.runtimeManager.onDidChangeAgents(() => this._onDidChangeTreeData.fire(undefined)),
			this.runtimeManager.onDidChangeActiveAgent(() => this._onDidChangeTreeData.fire(undefined)),
		);
	}

	getTreeItem(status: AgentStatus): vscode.TreeItem {
		const isActive = status.id === this.runtimeManager.getActiveAgentId();
		const item = new vscode.TreeItem(status.displayName, vscode.TreeItemCollapsibleState.None);
		item.description = status.available
			? `${isActive ? vscode.l10n.t('★ Active · ') : ''}${status.version ?? vscode.l10n.t('installed')}`
			: vscode.l10n.t('Not installed');
		item.tooltip = status.available
			? `${status.displayName}\n${vscode.l10n.t('Path: {0}', status.resolvedPath ?? status.binary)}\n${vscode.l10n.t('Version: {0}', status.version ?? 'ok')}`
			: `${vscode.l10n.t('{0} not found on PATH.', status.displayName)}\n${status.installHint ?? ''}`;
		item.iconPath = status.available
			? arcanaIcon(this.extensionUri, '01-the-magician.svg')
			: new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
		item.command = {
			command: 'tarot.agents.selectById',
			title: vscode.l10n.t('Select Agent'),
			arguments: [status.id],
		};
		return item;
	}

	getChildren(): AgentStatus[] {
		return [...this.runtimeManager.getStatuses()];
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}

class HookTreeItem extends SimpleTreeItem {
	constructor(
		label: string,
		readonly hook: HookDefinition,
	) {
		super(label, vscode.TreeItemCollapsibleState.None, hook.sourceFile);
	}
}

export class HooksTreeProvider implements vscode.TreeDataProvider<SimpleTreeItem>, vscode.Disposable {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<SimpleTreeItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly hookEngine: TarotHookEngine,
		private readonly extensionUri: vscode.Uri,
	) {
		const watcher = vscode.workspace.createFileSystemWatcher('**/.tarot/hooks/*.json');
		this.disposables.push(
			this._onDidChangeTreeData,
			watcher,
			watcher.onDidCreate(() => this.refresh()),
			watcher.onDidChange(() => this.refresh()),
			watcher.onDidDelete(() => this.refresh()),
		);
	}

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: SimpleTreeItem): vscode.TreeItem {
		return element;
	}

	private toHookItem(file: DiscoveredHookFile, hook: HookDefinition): HookTreeItem {
		const item = new HookTreeItem(hook.name, hook);
		item.description = `${hook.trigger}${hook.enabled ? '' : vscode.l10n.t(' (disabled)')}`;
		item.iconPath = hook.enabled
			? arcanaIcon(this.extensionUri, '10-wheel-of-fortune.svg')
			: new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
		item.tooltip = [
			`${hook.name} (${file.scope})`,
			vscode.l10n.t('Trigger: {0}', hook.trigger),
			hook.matcher ? vscode.l10n.t('Matcher: {0}', hook.matcher) : undefined,
			hook.description,
			vscode.l10n.t('Action: {0}', hook.action.type),
			vscode.l10n.t('Path: {0}', hook.sourceFile),
		].filter(Boolean).join('\n');
		item.contextValue = hook.enabled ? 'tarotHookEnabled' : 'tarotHookDisabled';
		item.command = {
			command: 'vscode.open',
			title: vscode.l10n.t('Open Hook File'),
			arguments: [vscode.Uri.file(hook.sourceFile)],
		};
		return item;
	}

	async getChildren(element?: SimpleTreeItem): Promise<SimpleTreeItem[]> {
		if (element?.children) {
			return element.children;
		}
		const root = getWorkspaceRoot();
		const files = await this.hookEngine.discoverFiles(root);
		if (files.length === 0) {
			return [];
		}

		const groups: SimpleTreeItem[] = [];
		for (const scope of ['workspace', 'global'] as const) {
			const scopedFiles = files.filter(f => f.scope === scope);
			const hookItems = scopedFiles.flatMap(f => f.hooks.map(h => this.toHookItem(f, h)));
			if (hookItems.length === 0) {
				continue;
			}
			const group = new SimpleTreeItem(
				scope === 'workspace' ? vscode.l10n.t('Workspace') : vscode.l10n.t('Global'),
				vscode.TreeItemCollapsibleState.Expanded,
				undefined,
				hookItems,
			);
			group.description = scope === 'workspace' ? `.tarot/hooks (${hookItems.length})` : `~/.tarot/hooks (${hookItems.length})`;
			group.iconPath = new vscode.ThemeIcon(scope === 'workspace' ? 'folder' : 'globe');
			groups.push(group);
		}
		return groups;
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}

export class SteeringTreeProvider implements vscode.TreeDataProvider<SimpleTreeItem>, vscode.Disposable {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<SimpleTreeItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly steeringService: TarotSteeringService,
		private readonly extensionUri: vscode.Uri,
	) {
		const steeringWatcher = vscode.workspace.createFileSystemWatcher('**/.tarot/steering/**/*.md');
		const agentsMdWatcher = vscode.workspace.createFileSystemWatcher('**/AGENTS.md');
		this.disposables.push(
			this._onDidChangeTreeData,
			steeringWatcher,
			agentsMdWatcher,
			steeringWatcher.onDidCreate(() => this.refresh()),
			steeringWatcher.onDidChange(() => this.refresh()),
			steeringWatcher.onDidDelete(() => this.refresh()),
			agentsMdWatcher.onDidCreate(() => this.refresh()),
			agentsMdWatcher.onDidChange(() => this.refresh()),
			agentsMdWatcher.onDidDelete(() => this.refresh()),
		);
	}

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: SimpleTreeItem): vscode.TreeItem {
		return element;
	}

	private toDocItem(doc: SteeringDocument): SimpleTreeItem {
		const item = new SimpleTreeItem(doc.fileName, vscode.TreeItemCollapsibleState.None, doc.filePath);
		const badge = doc.inclusion === 'fileMatch' && doc.fileMatchPattern
			? `fileMatch · ${doc.fileMatchPattern}`
			: doc.inclusion;
		item.description = badge;
		item.iconPath = arcanaIcon(this.extensionUri, '02-high-priestess.svg');
		item.tooltip = [
			`${doc.fileName} (${doc.scope})`,
			vscode.l10n.t('Inclusion: {0}', badge),
			doc.description ? vscode.l10n.t('Description: {0}', doc.description) : undefined,
			vscode.l10n.t('Path: {0}', doc.filePath),
		].filter(Boolean).join('\n');
		item.command = {
			command: 'vscode.open',
			title: vscode.l10n.t('Open Steering'),
			arguments: [vscode.Uri.file(doc.filePath)],
		};
		return item;
	}

	async getChildren(element?: SimpleTreeItem): Promise<SimpleTreeItem[]> {
		if (element?.children) {
			return element.children;
		}
		const root = getWorkspaceRoot();
		const docs = await this.steeringService.discover(root);
		if (docs.length === 0) {
			return [];
		}

		const agentsDocs = docs.filter(d => d.scope === 'agentsMd');
		const workspaceDocs = docs.filter(d => d.scope === 'workspace');
		const globalDocs = docs.filter(d => d.scope === 'global');

		const groups: SimpleTreeItem[] = [];

		if (agentsDocs.length > 0) {
			const group = new SimpleTreeItem(
				'AGENTS.md',
				vscode.TreeItemCollapsibleState.Expanded,
				undefined,
				agentsDocs.map(d => this.toDocItem(d)),
			);
			group.description = vscode.l10n.t('root');
			group.iconPath = new vscode.ThemeIcon('root-folder');
			groups.push(group);
		}

		if (workspaceDocs.length > 0) {
			const group = new SimpleTreeItem(
				vscode.l10n.t('Workspace'),
				vscode.TreeItemCollapsibleState.Expanded,
				undefined,
				workspaceDocs.map(d => this.toDocItem(d)),
			);
			group.description = `.tarot/steering (${workspaceDocs.length})`;
			group.iconPath = new vscode.ThemeIcon('folder');
			groups.push(group);
		}

		if (globalDocs.length > 0) {
			const group = new SimpleTreeItem(
				vscode.l10n.t('Global'),
				vscode.TreeItemCollapsibleState.Expanded,
				undefined,
				globalDocs.map(d => this.toDocItem(d)),
			);
			group.description = `~/.tarot/steering (${globalDocs.length})`;
			group.iconPath = new vscode.ThemeIcon('globe');
			groups.push(group);
		}

		return groups;
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}

export class SpecsTreeProvider implements vscode.TreeDataProvider<SimpleTreeItem>, vscode.Disposable {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<SimpleTreeItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly specService: TarotSpecService,
		private readonly extensionUri: vscode.Uri,
	) {
		const watcher = vscode.workspace.createFileSystemWatcher('**/.tarot/specs/**');
		this.disposables.push(
			this._onDidChangeTreeData,
			watcher,
			watcher.onDidCreate(() => this.refresh()),
			watcher.onDidChange(() => this.refresh()),
			watcher.onDidDelete(() => this.refresh()),
		);
	}

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: SimpleTreeItem): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: SimpleTreeItem): Promise<SimpleTreeItem[]> {
		if (element?.children) {
			return element.children;
		}
		const root = getWorkspaceRoot();
		if (!root) {
			return [];
		}

		const specs = await this.specService.listSpecs(root);
		return specs.map(spec => {
			const children = spec.files.map(fileName => {
				const fullPath = path.join(spec.dirPath, fileName);
				const child = new SimpleTreeItem(fileName, vscode.TreeItemCollapsibleState.None, fullPath);
				child.iconPath = new vscode.ThemeIcon(fileName === 'tasks.md' ? 'checklist' : 'markdown');
				if (fileName === 'tasks.md' && spec.taskSummary.total > 0) {
					child.description = `${spec.taskSummary.done}/${spec.taskSummary.total}`;
				}
				child.command = {
					command: 'vscode.open',
					title: vscode.l10n.t('Open File'),
					arguments: [vscode.Uri.file(fullPath)],
				};
				return child;
			});

			const item = new SimpleTreeItem(
				spec.slug,
				children.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
				spec.dirPath,
				children,
			);
			const progress = spec.taskSummary.total > 0
				? `${spec.taskSummary.done}/${spec.taskSummary.total} tasks`
				: vscode.l10n.t('0 tasks');
			item.description = `${spec.kind} · ${progress}`;
			item.iconPath = arcanaIcon(
				this.extensionUri,
				spec.kind === 'bugfix' ? '16-the-tower.svg' : '05-the-hierophant.svg',
			);
			item.tooltip = `${vscode.l10n.t('Spec: {0}', spec.slug)}\n${vscode.l10n.t('Type: {0}', spec.kind)}\n${vscode.l10n.t('Progress: {0}', progress)}`;
			return item;
		});
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
