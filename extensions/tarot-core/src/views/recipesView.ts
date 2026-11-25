/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TarotRecipeLoader } from '../workflows/recipeLoader';
import { LoadedRecipe, RecipeScope } from '../workflows/workflowTypes';

class RecipeTreeItem extends vscode.TreeItem {
	constructor(
		label: string,
		collapsibleState: vscode.TreeItemCollapsibleState,
		readonly children?: RecipeTreeItem[],
		readonly loadedRecipe?: LoadedRecipe,
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
 * `RECIPES` TreeView (MIGRATION_PLAN.md M3.9b): lists Workspace, User and Bundled recipes with
 * description, Arcana icons (`17-the-star.svg` for `publish-pr`, `10-wheel-of-fortune.svg` for
 * others) and inline `▷` Run action.
 */
export class RecipesTreeProvider implements vscode.TreeDataProvider<RecipeTreeItem>, vscode.Disposable {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<RecipeTreeItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly recipeLoader: TarotRecipeLoader,
		private readonly extensionUri: vscode.Uri,
	) {
		const watcher = vscode.workspace.createFileSystemWatcher('**/.tarot/workflows/*.workflow.{json,yaml,yml}');
		this.disposables.push(
			this._onDidChangeTreeData,
			watcher,
			watcher.onDidCreate(() => this.refresh()),
			watcher.onDidChange(() => this.refresh()),
			watcher.onDidDelete(() => this.refresh()),
			vscode.workspace.onDidGrantWorkspaceTrust(() => this.refresh()),
		);
	}

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: RecipeTreeItem): vscode.TreeItem {
		return element;
	}

	private toRecipeItem(loaded: LoadedRecipe): RecipeTreeItem {
		const item = new RecipeTreeItem(loaded.name, vscode.TreeItemCollapsibleState.None, undefined, loaded);
		item.description = loaded.recipe.description ?? '';
		item.contextValue = 'tarotWorkflowRecipe';
		item.iconPath = loaded.name === 'publish-pr'
			? arcanaIcon(this.extensionUri, '17-the-star.svg')
			: arcanaIcon(this.extensionUri, '10-wheel-of-fortune.svg');
		item.tooltip = [
			`${loaded.name} (${loaded.scope})`,
			loaded.recipe.description,
			loaded.sourceFile,
		].filter(Boolean).join('\n');
		item.command = {
			command: 'vscode.open',
			title: vscode.l10n.t('Open Recipe File'),
			arguments: [vscode.Uri.file(loaded.sourceFile)],
		};
		return item;
	}

	async getChildren(element?: RecipeTreeItem): Promise<RecipeTreeItem[]> {
		if (element?.children) {
			return element.children;
		}
		const root = vscode.workspace.isTrusted ? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath : undefined;
		const discovery = await this.recipeLoader.discover(root);
		if (discovery.recipes.length === 0) {
			return [];
		}

		const scopes: Array<{ key: RecipeScope; label: string; icon: string }> = [
			{ key: 'workspace', label: vscode.l10n.t('Workspace'), icon: 'folder' },
			{ key: 'user', label: vscode.l10n.t('Global'), icon: 'globe' },
			{ key: 'bundled', label: vscode.l10n.t('Bundled'), icon: 'sparkle' },
		];

		const groups: RecipeTreeItem[] = [];
		for (const s of scopes) {
			const bucket = discovery.recipes.filter(r => r.scope === s.key);
			if (bucket.length === 0) {
				continue;
			}
			const group = new RecipeTreeItem(
				s.label,
				vscode.TreeItemCollapsibleState.Expanded,
				bucket.map(r => this.toRecipeItem(r)),
			);
			group.description = `${bucket.length}`;
			group.iconPath = new vscode.ThemeIcon(s.icon);
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
