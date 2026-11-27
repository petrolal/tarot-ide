/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { CuratedPowerTemplate, PowerDefinition, TarotPowersService } from '../powers/powersService';
import { arcanaIcon, BaseTarotTreeProvider, getWorkspaceRoot, SimpleTreeItem } from './tarotSidebarViews';

export class InstalledPowerTreeItem extends SimpleTreeItem {
	constructor(
		label: string,
		readonly power: PowerDefinition,
	) {
		super(label, vscode.TreeItemCollapsibleState.None, power.manifestPath);
	}
}

export class AvailablePowerTreeItem extends SimpleTreeItem {
	constructor(
		label: string,
		readonly template: CuratedPowerTemplate,
		readonly isInstalled: boolean,
	) {
		super(label, vscode.TreeItemCollapsibleState.None);
	}
}

export class InstalledPowersTreeProvider extends BaseTarotTreeProvider {
	private filterQuery = '';

	constructor(
		private readonly powersService: TarotPowersService,
		private readonly extensionUri: vscode.Uri,
	) {
		super([
			'**/.tarot/powers/**/plugin.json',
			'**/.tarot/powers/**/POWER.md',
			'**/.tarot/powers/**/skills/**/SKILL.md',
		]);
	}

	setFilter(query: string): void {
		this.filterQuery = query.trim().toLowerCase();
		this.refresh();
	}

	getFilter(): string {
		return this.filterQuery;
	}

	private matchesFilter(p: PowerDefinition): boolean {
		if (!this.filterQuery) {
			return true;
		}
		const haystack = `${p.id} ${p.manifest.name} ${p.manifest.description} ${p.manifest.keywords.join(' ')}`.toLowerCase();
		return haystack.includes(this.filterQuery);
	}

	private toItem(power: PowerDefinition): InstalledPowerTreeItem {
		const item = new InstalledPowerTreeItem(power.manifest.name, power);
		const parts: string[] = [];
		if (power.manifest.version) {
			parts.push(`v${power.manifest.version}`);
		}
		parts.push(vscode.l10n.t('{0} skills', power.skills.length));
		if (power.mcpServers.length > 0) {
			parts.push(vscode.l10n.t('{0} MCP', power.mcpServers.length));
		}
		item.description = parts.join(' · ');
		item.iconPath = arcanaIcon(this.extensionUri, '16-the-tower.svg');
		item.contextValue = 'tarotPowerInstalled';
		item.tooltip = [
			`${power.manifest.name} (${power.scope})`,
			power.manifest.description,
			power.manifest.keywords.length > 0
				? vscode.l10n.t('Keywords: {0}', power.manifest.keywords.join(', '))
				: undefined,
			vscode.l10n.t('Trigger: /power:{0}', power.id),
			vscode.l10n.t('Path: {0}', power.dirPath),
		].filter(Boolean).join('\n');
		item.command = {
			command: 'tarot.powers.openDetail',
			title: vscode.l10n.t('Open Power Details'),
			arguments: [{ kind: 'installed', power }],
		};
		return item;
	}

	async getChildren(element?: SimpleTreeItem): Promise<SimpleTreeItem[]> {
		if (element?.children) {
			return element.children;
		}
		const root = vscode.workspace.isTrusted ? getWorkspaceRoot() : undefined;
		const powers = (await this.powersService.discover(root, vscode.workspace.isTrusted)).filter(p => this.matchesFilter(p));
		if (powers.length === 0) {
			return [];
		}

		const groups: SimpleTreeItem[] = [];
		for (const scope of ['workspace', 'global'] as const) {
			const scoped = powers.filter(p => p.scope === scope).map(p => this.toItem(p));
			if (scoped.length === 0) {
				continue;
			}
			const group = new SimpleTreeItem(
				scope === 'workspace' ? vscode.l10n.t('Workspace') : vscode.l10n.t('Global'),
				vscode.TreeItemCollapsibleState.Expanded,
				undefined,
				scoped,
			);
			group.description = scope === 'workspace'
				? `.tarot/powers (${scoped.length})`
				: `~/.tarot/powers (${scoped.length})`;
			group.iconPath = new vscode.ThemeIcon(scope === 'workspace' ? 'folder' : 'globe');
			groups.push(group);
		}
		return groups;
	}
}

export class AvailablePowersTreeProvider implements vscode.TreeDataProvider<AvailablePowerTreeItem>, vscode.Disposable {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<AvailablePowerTreeItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private filterQuery = '';

	constructor(
		private readonly powersService: TarotPowersService,
		private readonly extensionUri: vscode.Uri,
	) { }

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	setFilter(query: string): void {
		this.filterQuery = query.trim().toLowerCase();
		this.refresh();
	}

	getTreeItem(element: AvailablePowerTreeItem): vscode.TreeItem {
		return element;
	}

	async getChildren(): Promise<AvailablePowerTreeItem[]> {
		const root = vscode.workspace.isTrusted ? getWorkspaceRoot() : undefined;
		const installed = await this.powersService.discover(root, vscode.workspace.isTrusted);
		const installedIds = new Set(installed.map(p => p.id.toLowerCase()));

		return this.powersService.getCuratedCatalog()
			.filter(tpl => {
				if (!this.filterQuery) {
					return true;
				}
				const hay = `${tpl.id} ${tpl.name} ${tpl.description} ${tpl.keywords.join(' ')}`.toLowerCase();
				return hay.includes(this.filterQuery);
			})
			.map(tpl => {
				const isInstalled = installedIds.has(tpl.id.toLowerCase());
				const item = new AvailablePowerTreeItem(tpl.name, tpl, isInstalled);
				item.description = isInstalled
					? vscode.l10n.t('✓ Installed · v{0}', tpl.version)
					: `v${tpl.version} · ${tpl.keywords.slice(0, 3).join(', ')}`;
				item.iconPath = isInstalled
					? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'))
					: arcanaIcon(this.extensionUri, '17-the-star.svg');
				item.contextValue = isInstalled ? 'tarotPowerCuratedInstalled' : 'tarotPowerAvailable';
				item.tooltip = [
					`${tpl.name} (v${tpl.version} · ${tpl.author})`,
					tpl.description,
					vscode.l10n.t('Keywords: {0}', tpl.keywords.join(', ')),
				].join('\n');
				item.command = {
					command: 'tarot.powers.openDetail',
					title: vscode.l10n.t('Open Power Details'),
					arguments: [{ kind: 'curated', template: tpl, isInstalled }],
				};
				return item;
			});
	}

	dispose(): void {
		this._onDidChangeTreeData.dispose();
	}
}

export type PowerDetailTarget =
	| { readonly kind: 'installed'; readonly power: PowerDefinition }
	| { readonly kind: 'curated'; readonly template: CuratedPowerTemplate; readonly isInstalled: boolean };

export interface PowerDetailActions {
	readonly installCurated: (powerId: string, scope: 'workspace' | 'global') => Promise<void>;
	readonly uninstall: (power: PowerDefinition) => Promise<void>;
	readonly openFile: (filePath: string) => Promise<void>;
}

/**
 * Reusable Power Detail WebviewPanel (Kiro Powers detail view parity).
 * Strictly enforces CSP with nonce and renders all dynamic data via safe DOM APIs (zero unsafe HTML injection).
 */
export class TarotPowerDetailPanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private currentTarget: PowerDetailTarget | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly actions: PowerDetailActions) { }

	show(target: PowerDetailTarget): void {
		this.currentTarget = target;
		const title = target.kind === 'installed'
			? vscode.l10n.t('Power: {0}', target.power.manifest.name)
			: vscode.l10n.t('Power: {0}', target.template.name);

		if (!this.panel) {
			this.panel = vscode.window.createWebviewPanel(
				'tarot.powerDetail',
				title,
				vscode.ViewColumn.Active,
				{ enableScripts: true, retainContextWhenHidden: true },
			);
			this.panel.onDidDispose(() => {
				this.panel = undefined;
				this.currentTarget = undefined;
			}, null, this.disposables);
			this.panel.webview.onDidReceiveMessage(async msg => {
				if (!msg || typeof msg !== 'object') {
					return;
				}
				const m = msg as { type?: string; scope?: 'workspace' | 'global'; path?: string };
				if (m.type === 'installCurated' && this.currentTarget?.kind === 'curated') {
					await this.actions.installCurated(this.currentTarget.template.id, m.scope === 'global' ? 'global' : 'workspace');
				} else if (m.type === 'uninstall' && this.currentTarget?.kind === 'installed') {
					await this.actions.uninstall(this.currentTarget.power);
					this.panel?.dispose();
				} else if (m.type === 'openFile' && typeof m.path === 'string') {
					await this.actions.openFile(m.path);
				}
			}, null, this.disposables);
			this.panel.webview.html = this.buildShellHtml(this.panel.webview);
		} else {
			this.panel.title = title;
			this.panel.reveal(vscode.ViewColumn.Active);
		}

		this.postCurrentState();
	}

	private postCurrentState(): void {
		if (!this.panel || !this.currentTarget) {
			return;
		}
		const payload = this.currentTarget.kind === 'installed'
			? {
				kind: 'installed',
				id: this.currentTarget.power.id,
				name: this.currentTarget.power.manifest.name,
				version: this.currentTarget.power.manifest.version ?? '0.1.0',
				author: this.currentTarget.power.manifest.author ?? '',
				scope: this.currentTarget.power.scope,
				description: this.currentTarget.power.manifest.description,
				keywords: [...this.currentTarget.power.manifest.keywords],
				manifestPath: this.currentTarget.power.manifestPath,
				skills: this.currentTarget.power.skills.map(s => ({
					id: s.id,
					name: s.name,
					description: s.description,
					filePath: s.skillFilePath,
				})),
				mcpServers: this.currentTarget.power.mcpServers.map(s => ({
					name: s.name,
					transport: s.transport,
					enabled: s.enabled,
				})),
			}
			: {
				kind: 'curated',
				id: this.currentTarget.template.id,
				name: this.currentTarget.template.name,
				version: this.currentTarget.template.version,
				author: this.currentTarget.template.author,
				scope: this.currentTarget.isInstalled ? 'installed' : 'available',
				isInstalled: this.currentTarget.isInstalled,
				description: this.currentTarget.template.description,
				keywords: [...this.currentTarget.template.keywords],
				skills: [{
					id: this.currentTarget.template.skillName,
					name: this.currentTarget.template.skillName,
					description: this.currentTarget.template.skillDescription,
				}],
				mcpServers: [],
			};

		void this.panel.webview.postMessage({
			type: 'render',
			payload,
			l10n: {
				installWorkspace: vscode.l10n.t('Install to Workspace'),
				installGlobal: vscode.l10n.t('Install Globally'),
				openManifest: vscode.l10n.t('Open Manifest'),
				uninstall: vscode.l10n.t('Uninstall'),
				keywordsHeading: vscode.l10n.t('Activation Keywords'),
				skillsHeading: vscode.l10n.t('Bundled Skills'),
				mcpHeading: vscode.l10n.t('Bundled MCP Servers'),
				noMcp: vscode.l10n.t('No MCP servers bundled.'),
				triggerHint: vscode.l10n.t('Invoke explicitly with /power:{0} or mention any keyword below.', payload.id),
			},
		});
	}

	private buildShellHtml(webview: vscode.Webview): string {
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
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style nonce="${nonce}">
	body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 24px 28px; max-width: 820px; line-height: 1.5; }
	.header { display: flex; flex-direction: column; gap: 6px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 16px; margin-bottom: 20px; }
	.title-row { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
	h1 { margin: 0; font-size: 22px; font-weight: 600; }
	.badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
	.desc { color: var(--vscode-descriptionForeground); margin: 4px 0 8px; }
	.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
	button { border: none; border-radius: 4px; padding: 6px 12px; cursor: pointer; font-size: 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
	button:hover { background: var(--vscode-button-hoverBackground); }
	button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
	h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); margin: 20px 0 8px; }
	.pills { display: flex; gap: 6px; flex-wrap: wrap; }
	.pill { font-size: 12px; padding: 2px 8px; border-radius: 4px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-textBlockQuote-background); }
	.card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; gap: 12px; }
	.card-title { font-weight: 600; }
	.card-sub { font-size: 12px; color: var(--vscode-descriptionForeground); }
	.hint { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const root = document.getElementById('root');

	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = String(text);
		return node;
	}

	window.addEventListener('message', event => {
		const msg = event.data;
		if (!msg || msg.type !== 'render' || !msg.payload) return;
		const p = msg.payload;
		const t = msg.l10n || {};
		const frag = document.createDocumentFragment();

		const header = el('div', 'header');
		const titleRow = el('div', 'title-row');
		titleRow.appendChild(el('h1', '', p.name));
		titleRow.appendChild(el('span', 'badge', 'v' + p.version));
		titleRow.appendChild(el('span', 'badge', p.scope));
		if (p.author) titleRow.appendChild(el('span', 'card-sub', p.author));
		header.appendChild(titleRow);
		if (p.description) header.appendChild(el('p', 'desc', p.description));

		const actions = el('div', 'actions');
		if (p.kind === 'curated') {
			const wsBtn = el('button', '', t.installWorkspace || 'Install to Workspace');
			wsBtn.addEventListener('click', () => vscode.postMessage({ type: 'installCurated', scope: 'workspace' }));
			actions.appendChild(wsBtn);
			const glBtn = el('button', 'secondary', t.installGlobal || 'Install Globally');
			glBtn.addEventListener('click', () => vscode.postMessage({ type: 'installCurated', scope: 'global' }));
			actions.appendChild(glBtn);
		} else {
			const openBtn = el('button', '', t.openManifest || 'Open Manifest');
			openBtn.addEventListener('click', () => vscode.postMessage({ type: 'openFile', path: p.manifestPath }));
			actions.appendChild(openBtn);
			const rmBtn = el('button', 'secondary', t.uninstall || 'Uninstall');
			rmBtn.addEventListener('click', () => vscode.postMessage({ type: 'uninstall' }));
			actions.appendChild(rmBtn);
		}
		header.appendChild(actions);
		frag.appendChild(header);

		frag.appendChild(el('h2', '', t.keywordsHeading || 'Activation Keywords'));
		frag.appendChild(el('div', 'hint', t.triggerHint || ''));
		const pills = el('div', 'pills');
		for (const kw of (p.keywords || [])) {
			pills.appendChild(el('span', 'pill', kw));
		}
		frag.appendChild(pills);

		frag.appendChild(el('h2', '', t.skillsHeading || 'Bundled Skills'));
		for (const s of (p.skills || [])) {
			const card = el('div', 'card');
			const left = el('div');
			left.appendChild(el('div', 'card-title', '/' + s.id + ' — ' + s.name));
			if (s.description) left.appendChild(el('div', 'card-sub', s.description));
			card.appendChild(left);
			if (s.filePath) {
				const btn = el('button', 'secondary', 'SKILL.md');
				btn.addEventListener('click', () => vscode.postMessage({ type: 'openFile', path: s.filePath }));
				card.appendChild(btn);
			}
			frag.appendChild(card);
		}

		frag.appendChild(el('h2', '', t.mcpHeading || 'Bundled MCP Servers'));
		if (!p.mcpServers || p.mcpServers.length === 0) {
			frag.appendChild(el('div', 'hint', t.noMcp || 'No MCP servers bundled.'));
		} else {
			for (const srv of p.mcpServers) {
				const card = el('div', 'card');
				card.appendChild(el('div', 'card-title', srv.name));
				card.appendChild(el('span', 'badge', srv.transport + (srv.enabled ? '' : ' (disabled)')));
				frag.appendChild(card);
			}
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
