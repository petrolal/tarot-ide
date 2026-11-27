/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { TarotRecipeLoader } from '../workflows/recipeLoader';
import { LoadedRecipe, RecipeScope } from '../workflows/workflowTypes';
import { flattenRecipeTree } from '../workflows/workflowViewHelpers';

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
			command: 'tarot.workflows.previewRecipe',
			title: vscode.l10n.t('Preview Workflow Recipe'),
			arguments: [loaded],
		};
		return item;
	}

	async getChildren(element?: RecipeTreeItem): Promise<RecipeTreeItem[]> {
		if (element?.children) {
			return element.children;
		}
		const root = vscode.workspace.isTrusted ? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath : undefined;
		const discovery = await this.recipeLoader.discover(root, vscode.workspace.isTrusted);
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

/**
 * Visual Workflow Recipe Preview WebviewPanel — replaces opening raw bundled `.workflow.json`
 * files when clicking a recipe in the `RECIPES` sidebar. CSP-strict, zero unsafe HTML injection.
 */
export class TarotRecipePreviewPanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private currentRecipe: LoadedRecipe | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly onCustomized: () => void) { }

	show(loaded: LoadedRecipe): void {
		this.currentRecipe = loaded;
		const title = vscode.l10n.t('Recipe: {0}', loaded.name);

		if (!this.panel) {
			this.panel = vscode.window.createWebviewPanel(
				'tarot.recipePreview',
				title,
				vscode.ViewColumn.Active,
				{ enableScripts: true, retainContextWhenHidden: true },
			);
			this.panel.onDidDispose(() => {
				this.panel = undefined;
				this.currentRecipe = undefined;
			}, null, this.disposables);
			this.panel.webview.onDidReceiveMessage(async msg => {
				if (!msg || typeof msg !== 'object' || !this.currentRecipe) {
					return;
				}
				const m = msg as { type?: string };
				if (m.type === 'run') {
					await vscode.commands.executeCommand('tarot.workflows.runRecipe', { loadedRecipe: this.currentRecipe });
				} else if (m.type === 'openJson') {
					const doc = await vscode.workspace.openTextDocument(this.currentRecipe.sourceFile);
					await vscode.window.showTextDocument(doc);
				} else if (m.type === 'customize') {
					if (!vscode.workspace.isTrusted) {
						vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace to customize recipes in .tarot/workflows/.'));
						return;
					}
					const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
					if (!root) {
						vscode.window.showWarningMessage(vscode.l10n.t('Open a workspace folder first.'));
						return;
					}
					const destDir = path.join(root, '.tarot', 'workflows');
					await fs.mkdir(destDir, { recursive: true });
					const destFile = path.join(destDir, path.basename(this.currentRecipe.sourceFile));
					await fs.copyFile(this.currentRecipe.sourceFile, destFile);
					this.onCustomized();
					const doc = await vscode.workspace.openTextDocument(destFile);
					await vscode.window.showTextDocument(doc);
				}
			}, null, this.disposables);
			this.panel.webview.html = this.buildHtml(this.panel.webview);
		} else {
			this.panel.title = title;
			this.panel.reveal(vscode.ViewColumn.Active);
		}

		const tree = flattenRecipeTree(loaded.recipe.steps);
		void this.panel.webview.postMessage({
			type: 'render',
			name: loaded.name,
			scope: loaded.scope,
			description: loaded.recipe.description ?? '',
			tree,
		});
	}

	private buildHtml(webview: vscode.Webview): string {
		const nonce = crypto.randomBytes(16).toString('base64');
		const csp = [
			`default-src 'none'`,
			`style-src ${webview.cspSource} 'nonce-${nonce}'`,
			`script-src 'nonce-${nonce}'`,
		].join('; ');
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style nonce="${nonce}">
	body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 24px 30px; max-width: 820px; line-height: 1.5; }
	.head { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 16px; margin-bottom: 20px; }
	.title-row { display: flex; align-items: center; gap: 10px; }
	h1 { margin: 0; font-size: 22px; }
	.badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
	.desc { color: var(--vscode-descriptionForeground); margin: 6px 0 14px; font-size: 13px; }
	.actions { display: flex; gap: 8px; flex-wrap: wrap; }
	button { border: none; border-radius: 6px; padding: 7px 14px; cursor: pointer; font-size: 12px; font-weight: 500; background: #7C3AED; color: #FFFFFF; }
	button:hover { background: #6D28D9; }
	button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--vscode-descriptionForeground); margin: 0 0 12px; }
	.row { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 6px; position: relative; }
	.row.nested::before { content: ''; position: absolute; left: var(--cx, 20px); top: -4px; bottom: -4px; width: 1.5px; background: var(--vscode-panel-border); }
	.num { width: 22px; height: 22px; border-radius: 999px; border: 1.5px solid var(--vscode-panel-border); display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground); }
	.dot { width: 16px; text-align: center; color: var(--vscode-descriptionForeground); }
	.name { font-weight: 600; }
	.pill { font-size: 11px; padding: 1px 7px; border-radius: 4px; background: rgba(96, 165, 250, 0.18); color: #93C5FD; }
	.agent { font-size: 12px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const root = document.getElementById('root');
	function el(tag, cls, text) {
		const n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text !== undefined) n.textContent = String(text);
		return n;
	}
	window.addEventListener('message', event => {
		const msg = event.data;
		if (!msg || msg.type !== 'render') return;
		const frag = document.createDocumentFragment();
		const head = el('div', 'head');
		const tr = el('div', 'title-row');
		tr.appendChild(el('h1', '', msg.name));
		tr.appendChild(el('span', 'badge', msg.scope));
		head.appendChild(tr);
		if (msg.description) head.appendChild(el('p', 'desc', msg.description));

		const actions = el('div', 'actions');
		const runBtn = el('button', '', '▶ Run Workflow');
		runBtn.addEventListener('click', () => vscode.postMessage({ type: 'run' }));
		actions.appendChild(runBtn);
		if (msg.scope === 'bundled') {
			const custBtn = el('button', 'secondary', 'Customize in Workspace');
			custBtn.addEventListener('click', () => vscode.postMessage({ type: 'customize' }));
			actions.appendChild(custBtn);
		}
		const jsonBtn = el('button', 'secondary', 'View JSON');
		jsonBtn.addEventListener('click', () => vscode.postMessage({ type: 'openJson' }));
		actions.appendChild(jsonBtn);
		head.appendChild(actions);
		frag.appendChild(head);

		const tree = msg.tree || [];
		const topCount = tree.filter(n => (n.depth || 0) === 0).length;
		frag.appendChild(el('h2', '', 'Pipeline Steps (' + topCount + ')'));
		let idx = 0;
		for (const item of tree) {
			const d = item.depth || 0;
			const row = el('div', 'row' + (d > 0 ? ' nested' : ''));
			if (d > 0) {
				row.style.paddingLeft = (10 + d * 24) + 'px';
				row.style.setProperty('--cx', (20 + (d - 1) * 24) + 'px');
			}
			if (d === 0) {
				idx++;
				row.appendChild(el('span', 'num', String(idx)));
			} else {
				row.appendChild(el('span', 'dot', '○'));
			}
			row.appendChild(el('span', 'name', item.id));
			if (item.badge) row.appendChild(el('span', 'pill', item.badge.replace(/^\\[|\\]$/g, '')));
			if (item.agent) row.appendChild(el('span', 'agent', item.agent));
			frag.appendChild(row);
		}
		root.replaceChildren(frag);
	});
</script>
</body>
</html>`;
	}

	dispose(): void {
		this.panel?.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
