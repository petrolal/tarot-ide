/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import {
	CrewAppAction,
	CrewAppManifest,
	RemoteSshProfile,
	TarotAppsAndRemoteService,
} from '../crew/appsAndRemoteService';
import { GatewayMetadata, TarotGatewayService } from '../crew/gatewayService';
import { TarotHeartbeatService } from '../crew/heartbeatService';
import { BaseTarotTreeProvider, getWorkspaceRoot, SimpleTreeItem } from './tarotSidebarViews';

export class GatewayTreeItem extends SimpleTreeItem {
	constructor(label: string, readonly gateway: GatewayMetadata) {
		super(label, vscode.TreeItemCollapsibleState.None);
	}
}

export class CrewAppTreeItem extends SimpleTreeItem {
	constructor(label: string, readonly app: CrewAppManifest) {
		super(label, vscode.TreeItemCollapsibleState.None, app.manifestPath);
	}
}

export class RemoteSshTreeItem extends SimpleTreeItem {
	constructor(label: string, readonly remote: RemoteSshProfile) {
		super(label, vscode.TreeItemCollapsibleState.None);
	}
}

export class CrewAutomationTreeProvider extends BaseTarotTreeProvider {
	constructor(
		private readonly heartbeatService: TarotHeartbeatService,
		private readonly gatewayService: TarotGatewayService,
		private readonly appsAndRemoteService: TarotAppsAndRemoteService,
	) {
		super([
			'**/.tarot/crew/heartbeat.json',
			'**/.tarot/crew/gateways.json',
			'**/.tarot/crew/remotes.json',
			'**/.tarot/crew/apps/*/app.json',
		]);
	}

	async getChildren(element?: SimpleTreeItem): Promise<SimpleTreeItem[]> {
		if (element?.children) {
			return element.children;
		}
		if (!vscode.workspace.isTrusted) {
			return [];
		}
		const root = getWorkspaceRoot();
		if (!root) {
			return [];
		}

		// 1. Heartbeat Daemon
		const hbRunning = this.heartbeatService.isRunning();
		const lastTick = this.heartbeatService.getLastTick();
		const hbToggleItem = new SimpleTreeItem(
			hbRunning ? vscode.l10n.t('Heartbeat Daemon: Running') : vscode.l10n.t('Heartbeat Daemon: Stopped'),
			vscode.TreeItemCollapsibleState.None,
		);
		hbToggleItem.description = lastTick ? `${lastTick.status} · ${lastTick.timestamp.slice(11, 19)}` : vscode.l10n.t('click to toggle');
		hbToggleItem.iconPath = new vscode.ThemeIcon(
			hbRunning ? 'pulse' : 'debug-pause',
			hbRunning ? new vscode.ThemeColor('testing.iconPassed') : undefined,
		);
		hbToggleItem.command = { command: 'tarot.crew.heartbeat.toggle', title: vscode.l10n.t('Toggle Heartbeat Daemon') };

		const hbRunItem = new SimpleTreeItem(vscode.l10n.t('Run Heartbeat Check Now'), vscode.TreeItemCollapsibleState.None);
		hbRunItem.iconPath = new vscode.ThemeIcon('play');
		hbRunItem.command = { command: 'tarot.crew.heartbeat.runOnce', title: vscode.l10n.t('Run Heartbeat Check Now') };

		const hbCfgItem = new SimpleTreeItem(vscode.l10n.t('Configure heartbeat.json'), vscode.TreeItemCollapsibleState.None);
		hbCfgItem.iconPath = new vscode.ThemeIcon('gear');
		hbCfgItem.command = { command: 'tarot.crew.heartbeat.openConfig', title: vscode.l10n.t('Configure Heartbeat') };

		const heartbeatGroup = new SimpleTreeItem(
			vscode.l10n.t('Heartbeat Daemon'),
			vscode.TreeItemCollapsibleState.Expanded,
			undefined,
			[hbToggleItem, hbRunItem, hbCfgItem],
		);
		heartbeatGroup.iconPath = new vscode.ThemeIcon('heart');

		// 2. Webhooks & Gateways
		const whRunning = this.gatewayService.isWebhookServerRunning();
		const whPort = this.gatewayService.getWebhookServerPort();
		const whItem = new SimpleTreeItem(
			whRunning ? vscode.l10n.t('Webhook Server: 127.0.0.1:{0}', whPort ?? 0) : vscode.l10n.t('Webhook Server: Stopped'),
			vscode.TreeItemCollapsibleState.None,
		);
		whItem.description = vscode.l10n.t('HMAC-SHA256');
		whItem.iconPath = new vscode.ThemeIcon(whRunning ? 'radio-tower' : 'circle-slash');
		whItem.command = { command: 'tarot.crew.webhook.toggleServer', title: vscode.l10n.t('Toggle Local Webhook Server') };

		const gateways = await this.gatewayService.listGateways(root);
		const gwItems: SimpleTreeItem[] = [whItem, ...gateways.map(g => {
			const item = new GatewayTreeItem(g.label, g);
			item.description = `${g.kind}${g.enabled ? '' : vscode.l10n.t(' (disabled)')}`;
			item.iconPath = new vscode.ThemeIcon('broadcast');
			item.contextValue = 'tarotCrewGateway';
			item.command = { command: 'tarot.crew.gateway.testSend', title: vscode.l10n.t('Send Test Message'), arguments: [item] };
			return item;
		})];
		const channelsGroup = new SimpleTreeItem(
			vscode.l10n.t('Webhooks & Gateways'),
			vscode.TreeItemCollapsibleState.Expanded,
			undefined,
			gwItems,
		);
		channelsGroup.description = `(${gateways.length})`;
		channelsGroup.iconPath = new vscode.ThemeIcon('plug');

		// 3. Crew Apps SDK
		const apps = await this.appsAndRemoteService.discoverApps(root);
		const appItems: SimpleTreeItem[] = apps.map(app => {
			const item = new CrewAppTreeItem(app.name, app);
			item.description = `v${app.version} · ${vscode.l10n.t('{0} actions', app.actions.length)}`;
			item.iconPath = new vscode.ThemeIcon('window');
			item.contextValue = 'tarotCrewApp';
			item.tooltip = `${app.name}\n${app.description}`;
			item.command = { command: 'tarot.crew.apps.open', title: vscode.l10n.t('Open Crew App'), arguments: [item] };
			return item;
		});
		const appsGroup = new SimpleTreeItem(
			vscode.l10n.t('Crew Apps'),
			vscode.TreeItemCollapsibleState.Expanded,
			undefined,
			appItems,
		);
		appsGroup.description = `(${apps.length})`;
		appsGroup.iconPath = new vscode.ThemeIcon('extensions');

		// 4. Remote SSH Instances
		const remotes = await this.appsAndRemoteService.listRemotes(root);
		const remoteItems: SimpleTreeItem[] = remotes.map(r => {
			const item = new RemoteSshTreeItem(r.label, r);
			item.description = r.user ? `${r.user}@${r.host}` : r.host;
			item.iconPath = new vscode.ThemeIcon('remote');
			item.contextValue = 'tarotCrewRemote';
			item.tooltip = `${r.label}\n${r.user ? `${r.user}@` : ''}${r.host}:${r.port ?? 22}\n${r.remoteCrewDir}`;
			item.command = { command: 'tarot.crew.remote.check', title: vscode.l10n.t('Check Remote Crew Status'), arguments: [item] };
			return item;
		});
		const remotesGroup = new SimpleTreeItem(
			vscode.l10n.t('Remote Crew (SSH)'),
			vscode.TreeItemCollapsibleState.Expanded,
			undefined,
			remoteItems,
		);
		remotesGroup.description = `(${remotes.length})`;
		remotesGroup.iconPath = new vscode.ThemeIcon('server-environment');

		return [heartbeatGroup, channelsGroup, appsGroup, remotesGroup];
	}
}

export interface CrewAppPanelActions {
	readonly runAction: (app: CrewAppManifest, action: CrewAppAction) => Promise<string>;
	readonly openManifest: (manifestPath: string) => Promise<void>;
}

/**
 * Sandboxed Crew App WebviewPanel (strict CSP with nonce, zero unsafe HTML injection).
 */
export class TarotCrewAppPanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private activeApp: CrewAppManifest | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly actions: CrewAppPanelActions) { }

	show(app: CrewAppManifest): void {
		this.activeApp = app;
		const title = vscode.l10n.t('Crew App: {0}', app.name);
		if (!this.panel) {
			this.panel = vscode.window.createWebviewPanel(
				'tarot.crewApp',
				title,
				vscode.ViewColumn.Active,
				{ enableScripts: true, retainContextWhenHidden: true },
			);
			this.panel.onDidDispose(() => {
				this.panel = undefined;
				this.activeApp = undefined;
			}, null, this.disposables);
			this.panel.webview.onDidReceiveMessage(async msg => {
				if (!msg || typeof msg !== 'object' || !this.activeApp) {
					return;
				}
				const m = msg as { type?: string; actionId?: string };
				if (m.type === 'openManifest') {
					await this.actions.openManifest(this.activeApp.manifestPath);
				} else if (m.type === 'runAction' && typeof m.actionId === 'string') {
					const action = this.activeApp.actions.find(a => a.id === m.actionId);
					if (!action) {
						return;
					}
					const output = await this.actions.runAction(this.activeApp, action);
					void this.panel?.webview.postMessage({ type: 'output', label: action.label, output });
				}
			}, null, this.disposables);
			this.panel.webview.html = this.buildHtml(this.panel.webview);
		} else {
			this.panel.title = title;
			this.panel.reveal(vscode.ViewColumn.Active);
		}
		void this.panel.webview.postMessage({
			type: 'render',
			app,
			l10n: {
				openManifest: vscode.l10n.t('Edit app.json'),
				actionsHeading: vscode.l10n.t('App Actions'),
				outputHeading: vscode.l10n.t('Last Output'),
			},
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
	body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 24px 28px; max-width: 820px; line-height: 1.5; }
	h1 { margin: 0 0 6px; font-size: 20px; }
	.desc { color: var(--vscode-descriptionForeground); margin: 0 0 14px; }
	h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); margin: 20px 0 8px; }
	button { border: none; border-radius: 4px; padding: 6px 12px; cursor: pointer; font-size: 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
	button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	.row { display: flex; gap: 8px; flex-wrap: wrap; }
	.card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; gap: 12px; }
	pre { white-space: pre-wrap; background: var(--vscode-textBlockQuote-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 12px; font-family: var(--vscode-editor-font-family); font-size: 12px; }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const root = document.getElementById('root');
	let outputEl = null;

	function el(tag, cls, text) {
		const n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text !== undefined) n.textContent = String(text);
		return n;
	}

	window.addEventListener('message', event => {
		const msg = event.data;
		if (!msg) return;
		if (msg.type === 'output' && outputEl) {
			outputEl.textContent = '[' + msg.label + ']\\n' + (msg.output || '(no output)');
			return;
		}
		if (msg.type !== 'render' || !msg.app) return;
		const app = msg.app;
		const t = msg.l10n || {};
		const frag = document.createDocumentFragment();
		frag.appendChild(el('h1', '', app.name + ' (v' + app.version + ')'));
		if (app.description) frag.appendChild(el('p', 'desc', app.description));
		const editBtn = el('button', 'secondary', t.openManifest || 'Edit app.json');
		editBtn.addEventListener('click', () => vscode.postMessage({ type: 'openManifest' }));
		frag.appendChild(editBtn);

		frag.appendChild(el('h2', '', t.actionsHeading || 'Actions'));
		for (const act of (app.actions || [])) {
			const card = el('div', 'card');
			const info = el('div');
			info.appendChild(el('div', '', act.label));
			info.appendChild(el('div', 'desc', act.kind + ': ' + act.value));
			card.appendChild(info);
			const btn = el('button', '', 'Run');
			btn.addEventListener('click', () => vscode.postMessage({ type: 'runAction', actionId: act.id }));
			card.appendChild(btn);
			frag.appendChild(card);
		}
		frag.appendChild(el('h2', '', t.outputHeading || 'Output'));
		outputEl = el('pre', '', 'Ready.');
		frag.appendChild(outputEl);
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
