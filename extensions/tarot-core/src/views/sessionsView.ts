/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import {
	classifySessionStatus,
	filterSessionCards,
	SessionCardSummary,
	SessionFilterKind,
} from '../agents/sessionConcurrency';
import { TarotSessionStore } from '../agents/sessionStore';

class SessionTreeItem extends vscode.TreeItem {
	constructor(
		label: string,
		collapsibleState: vscode.TreeItemCollapsibleState,
		readonly children?: SessionTreeItem[],
		readonly sessionId?: string,
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

function formatShortTime(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) {
		return '';
	}
	return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * `SESSIONS` TreeView (MIGRATION_PLAN.md M3.9c):
 * - Search & status/mode filtering
 * - Multi-repo session cards (`title`, `repo` badge, time, `Needs input` / `🔒 N sub-agent needs approval` parked badges)
 * - `Older Sessions` persisted under `.tarot/sessions/` (Workspace Trust gated)
 * - Direct footer shortcuts: **Schedule**, **Agent Config**, **Settings**
 */
export class SessionsTreeProvider implements vscode.TreeDataProvider<SessionTreeItem>, vscode.Disposable {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<SessionTreeItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private readonly disposables: vscode.Disposable[] = [];
	private searchQuery = '';
	private filter: SessionFilterKind = 'all';

	constructor(
		private readonly sessionStore: TarotSessionStore,
		private readonly extensionUri: vscode.Uri,
		private readonly getRunningSessionId: () => string | undefined,
	) {
		const watcher = vscode.workspace.createFileSystemWatcher('**/.tarot/sessions/*.json');
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

	setSearchQuery(query: string): void {
		this.searchQuery = query.trim();
		this.refresh();
	}

	getSearchQuery(): string {
		return this.searchQuery;
	}

	setFilter(filter: SessionFilterKind): void {
		this.filter = filter;
		this.refresh();
	}

	getFilter(): SessionFilterKind {
		return this.filter;
	}

	getTreeItem(element: SessionTreeItem): vscode.TreeItem {
		return element;
	}

	async buildSessionCards(): Promise<{ active: SessionCardSummary[]; older: SessionCardSummary[] }> {
		const defaultRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const defaultRepo = defaultRoot ? path.basename(defaultRoot) : 'workspace';
		const runningId = this.getRunningSessionId();

		const liveSessions = this.sessionStore.listSessions();
		const liveIds = new Set(liveSessions.map(s => s.id));
		const activeCards: SessionCardSummary[] = liveSessions.map(s => {
			const lastMsg = s.messages[s.messages.length - 1];
			const summary = lastMsg ? lastMsg.content.replace(/\s+/g, ' ').trim().slice(0, 80) : vscode.l10n.t('Empty session');
			const repoName = s.repoRoot ? path.basename(s.repoRoot) : defaultRepo;
			const parkedApprovals = s.parkedApprovals ?? 0;
			return {
				id: s.id,
				title: s.title,
				summary,
				repoName,
				repoRoot: s.repoRoot ?? defaultRoot,
				worktreeBranch: s.worktreeBranch,
				mode: s.mode,
				activeAgentId: s.activeAgentId,
				updatedAt: s.updatedAt,
				status: classifySessionStatus(s, runningId === s.id, parkedApprovals),
				parkedApprovals,
			};
		});

		const olderCards: SessionCardSummary[] = [];
		if (vscode.workspace.isTrusted) {
			const persisted = await this.sessionStore.listPersistedSessions();
			for (const p of persisted) {
				if (liveIds.has(p.id)) {
					continue;
				}
				olderCards.push({
					id: p.id,
					title: p.title,
					summary: vscode.l10n.t('{0} message(s)', p.messages.length),
					repoName: p.repoRoot ? path.basename(p.repoRoot) : defaultRepo,
					repoRoot: p.repoRoot ?? defaultRoot,
					worktreeBranch: p.worktreeBranch,
					mode: p.mode,
					activeAgentId: p.activeAgentId,
					updatedAt: p.updatedAt,
					status: 'idle',
					parkedApprovals: 0,
					isPersistedOnly: true,
				});
			}
		}

		return {
			active: filterSessionCards(activeCards, this.searchQuery, this.filter),
			older: filterSessionCards(olderCards, this.searchQuery, this.filter),
		};
	}

	private toSessionItem(card: SessionCardSummary): SessionTreeItem {
		const item = new SessionTreeItem(card.title, vscode.TreeItemCollapsibleState.None, undefined, card.id);
		const badges: string[] = [card.repoName];
		if (card.worktreeBranch) {
			badges.push(`⎇ ${card.worktreeBranch}`);
		}
		if (card.status === 'parked') {
			badges.push(vscode.l10n.t('🔒 {0} sub-agent needs approval', card.parkedApprovals));
		} else if (card.status === 'needsInput') {
			badges.push(vscode.l10n.t('Needs input'));
		} else if (card.status === 'running') {
			badges.push(vscode.l10n.t('Running'));
		}
		const timeStr = formatShortTime(card.updatedAt);
		if (timeStr) {
			badges.push(timeStr);
		}
		item.description = badges.join(' · ');
		item.tooltip = [
			card.title,
			vscode.l10n.t('Repo: {0} · Agent: {1} · Mode: {2}', card.repoName, card.activeAgentId, card.mode),
			card.summary,
		].join('\n');
		item.iconPath = card.status === 'parked'
			? new vscode.ThemeIcon('lock', new vscode.ThemeColor('charts.yellow'))
			: card.status === 'needsInput'
				? new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('charts.yellow'))
				: card.status === 'running'
					? new vscode.ThemeIcon('sync~spin')
					: arcanaIcon(this.extensionUri, card.mode === 'spec' ? '05-the-hierophant.svg' : '00-the-fool.svg');
		item.command = {
			command: 'tarot.sessions.open',
			title: vscode.l10n.t('Open Session'),
			arguments: [card.id],
		};
		return item;
	}

	async getChildren(element?: SessionTreeItem): Promise<SessionTreeItem[]> {
		if (element?.children) {
			return element.children;
		}

		const { active, older } = await this.buildSessionCards();
		const roots: SessionTreeItem[] = [];

		if (this.searchQuery || this.filter !== 'all') {
			const filterChip = new SessionTreeItem(
				vscode.l10n.t('Filter: {0}{1}', this.filter, this.searchQuery ? ` · "${this.searchQuery}"` : ''),
				vscode.TreeItemCollapsibleState.None,
			);
			filterChip.iconPath = new vscode.ThemeIcon('filter');
			filterChip.command = { command: 'tarot.sessions.search', title: vscode.l10n.t('Search Sessions') };
			roots.push(filterChip);
		}

		for (const card of active) {
			roots.push(this.toSessionItem(card));
		}

		if (older.length > 0) {
			const olderGroup = new SessionTreeItem(
				vscode.l10n.t('Older Sessions'),
				vscode.TreeItemCollapsibleState.Collapsed,
				older.map(c => this.toSessionItem(c)),
			);
			olderGroup.description = String(older.length);
			olderGroup.iconPath = new vscode.ThemeIcon('history');
			roots.push(olderGroup);
		}

		// Fixed bottom shortcuts (M3.9c): Schedule, Agent Config, Settings
		const scheduleItem = new SessionTreeItem(vscode.l10n.t('Schedule'), vscode.TreeItemCollapsibleState.None);
		scheduleItem.description = vscode.l10n.t('Cron & digests (M3.10)');
		scheduleItem.iconPath = new vscode.ThemeIcon('calendar');
		scheduleItem.command = { command: 'tarot.schedule.open', title: vscode.l10n.t('Schedule') };

		const configItem = new SessionTreeItem(vscode.l10n.t('Agent Config'), vscode.TreeItemCollapsibleState.None);
		configItem.description = vscode.l10n.t('Agents · Steering · Skills · MCP · Permissions');
		configItem.iconPath = arcanaIcon(this.extensionUri, '02-high-priestess.svg');
		configItem.command = { command: 'tarot.agentConfig.open', title: vscode.l10n.t('Agent Config') };

		const settingsItem = new SessionTreeItem(vscode.l10n.t('Settings'), vscode.TreeItemCollapsibleState.None);
		settingsItem.description = 'tarot.*';
		settingsItem.iconPath = new vscode.ThemeIcon('settings-gear');
		settingsItem.command = { command: 'tarot.settings.open', title: vscode.l10n.t('Tarot Settings') };

		const shortcutsGroup = new SessionTreeItem(
			vscode.l10n.t('Shortcuts'),
			vscode.TreeItemCollapsibleState.Expanded,
			[scheduleItem, configItem, settingsItem],
		);
		shortcutsGroup.iconPath = new vscode.ThemeIcon('compass');
		roots.push(shortcutsGroup);

		return roots;
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
