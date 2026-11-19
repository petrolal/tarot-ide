/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentRuntimeManager } from '../agents/runtimeManager';
import { AgentStatus } from '../agents/types';

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
