/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentRuntimeManager } from '../agents/runtimeManager';
import { AgentStatus } from '../agents/types';
import { TarotSpecService } from '../specs/specService';
import { SteeringDocument, TarotSteeringService } from '../steering/steeringService';

function getWorkspaceRoot(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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

	constructor(private readonly runtimeManager: AgentRuntimeManager) {
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
			? `${isActive ? '★ Ativo · ' : ''}${status.version ?? 'instalado'}`
			: 'Não instalado';
		item.tooltip = status.available
			? `${status.displayName}\nCaminho: ${status.resolvedPath ?? status.binary}\nVersão: ${status.version ?? 'ok'}`
			: `${status.displayName} não encontrado no PATH.\n${status.installHint ?? ''}`;
		item.iconPath = status.available
			? new vscode.ThemeIcon(isActive ? 'sparkle' : 'check', new vscode.ThemeColor(isActive ? 'charts.yellow' : 'charts.green'))
			: new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
		item.command = {
			command: 'tarot.agents.selectById',
			title: 'Selecionar Agente',
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

export class TarotWorkspaceFolderTreeProvider implements vscode.TreeDataProvider<SimpleTreeItem>, vscode.Disposable {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<SimpleTreeItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly relativeDir: string,
		private readonly kind: 'specs' | 'steering' | 'hooks',
	) {
		const watcher = vscode.workspace.createFileSystemWatcher(`**/.tarot/${kind}/**`);
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

		const targetDir = path.join(root, this.relativeDir);
		try {
			const entries = await fs.readdir(targetDir, { withFileTypes: true });
			if (this.kind === 'specs') {
				const dirs = entries.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
				const specItems: SimpleTreeItem[] = [];
				for (const dir of dirs) {
					const specPath = path.join(targetDir, dir.name);
					const files = ['requirements.md', 'design.md', 'tasks.md'];
					const children: SimpleTreeItem[] = [];
					let progressDesc = '';

					for (const fileName of files) {
						const fullPath = path.join(specPath, fileName);
						try {
							const content = await fs.readFile(fullPath, 'utf8');
							if (fileName === 'tasks.md') {
								const total = (content.match(/^\s*-\s+\[[ xX]\]/gm) ?? []).length;
								const done = (content.match(/^\s*-\s+\[[xX]\]/gm) ?? []).length;
								if (total > 0) {
									progressDesc = `${done}/${total} tasks`;
								}
							}
							const child = new SimpleTreeItem(fileName, vscode.TreeItemCollapsibleState.None, fullPath);
							child.iconPath = new vscode.ThemeIcon('markdown');
							child.command = {
								command: 'vscode.open',
								title: 'Abrir arquivo',
								arguments: [vscode.Uri.file(fullPath)],
							};
							children.push(child);
						} catch {
							// File does not exist yet
						}
					}

					const specItem = new SimpleTreeItem(
						dir.name,
						children.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
						specPath,
						children,
					);
					specItem.description = progressDesc;
					specItem.iconPath = new vscode.ThemeIcon('book');
					specItems.push(specItem);
				}
				return specItems;
			}

			const ext = this.kind === 'steering' ? '.md' : '.json';
			const files = entries
				.filter(e => e.isFile() && e.name.endsWith(ext))
				.sort((a, b) => a.name.localeCompare(b.name));

			return files.map(file => {
				const fullPath = path.join(targetDir, file.name);
				const item = new SimpleTreeItem(file.name, vscode.TreeItemCollapsibleState.None, fullPath);
				item.iconPath = new vscode.ThemeIcon(this.kind === 'steering' ? 'compass' : 'zap');
				item.command = {
					command: 'vscode.open',
					title: 'Abrir arquivo',
					arguments: [vscode.Uri.file(fullPath)],
				};
				return item;
			});
		} catch {
			return [];
		}
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

	constructor(private readonly steeringService: TarotSteeringService) {
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

		const iconMap: Record<SteeringDocument['inclusion'], string> = {
			always: 'compass',
			fileMatch: 'file-code',
			auto: 'sparkle',
			manual: 'tag',
		};
		item.iconPath = new vscode.ThemeIcon(iconMap[doc.inclusion]);
		item.tooltip = [
			`${doc.fileName} (${doc.scope})`,
			`Inclusão: ${badge}`,
			doc.description ? `Descrição: ${doc.description}` : undefined,
			`Caminho: ${doc.filePath}`,
		].filter(Boolean).join('\n');
		item.command = {
			command: 'vscode.open',
			title: 'Abrir Steering',
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
			group.description = 'root';
			group.iconPath = new vscode.ThemeIcon('root-folder');
			groups.push(group);
		}

		if (workspaceDocs.length > 0) {
			const group = new SimpleTreeItem(
				'Workspace',
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
				'Global',
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

	constructor(private readonly specService: TarotSpecService) {
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
					title: 'Abrir arquivo',
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
				: '0 tasks';
			item.description = `${spec.kind} · ${progress}`;
			item.iconPath = new vscode.ThemeIcon(spec.kind === 'bugfix' ? 'bug' : 'book');
			item.tooltip = `Spec: ${spec.slug}\nTipo: ${spec.kind}\nProgresso: ${progress}`;
			return item;
		});
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
