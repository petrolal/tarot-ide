/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import {
	CrewLedgerEntry,
	CrewmateDefinition,
	DiscoveredTaskFile,
	KnowledgeSource,
	TarotCrewService,
} from '../crew/crewService';
import { ScheduledJobDefinition, TarotScheduleService } from '../schedule/scheduleService';
import { arcanaIcon, BaseTarotTreeProvider, getWorkspaceRoot, SimpleTreeItem } from './tarotSidebarViews';

export class CrewmateTreeItem extends SimpleTreeItem {
	constructor(
		label: string,
		readonly crewmate: CrewmateDefinition,
	) {
		super(label, vscode.TreeItemCollapsibleState.None, crewmate.configPath);
	}
}

export class CrewTaskFileTreeItem extends SimpleTreeItem {
	constructor(
		label: string,
		readonly taskFile: DiscoveredTaskFile,
	) {
		super(label, vscode.TreeItemCollapsibleState.None, taskFile.path);
	}
}

export class KnowledgeSourceTreeItem extends SimpleTreeItem {
	constructor(
		label: string,
		readonly source: KnowledgeSource,
	) {
		super(label, vscode.TreeItemCollapsibleState.None, source.targetPath);
	}
}

export class ScheduleJobTreeItem extends SimpleTreeItem {
	constructor(
		label: string,
		readonly job: ScheduledJobDefinition,
	) {
		super(label, vscode.TreeItemCollapsibleState.None, job.sourceFile);
	}
}

export class CrewmatesTreeProvider extends BaseTarotTreeProvider {
	constructor(
		private readonly crewService: TarotCrewService,
		private readonly extensionUri: vscode.Uri,
	) {
		super(['**/.tarot/crew/crewmates/**']);
	}

	async getChildren(element?: SimpleTreeItem): Promise<SimpleTreeItem[]> {
		if (element?.children) {
			return element.children;
		}
		const root = vscode.workspace.isTrusted ? getWorkspaceRoot() : undefined;
		const crewmates = await this.crewService.discoverCrewmates(root);
		return crewmates.map(cm => {
			const prefix = cm.starred ? '★ ' : '';
			const item = new CrewmateTreeItem(`${prefix}${cm.name}`, cm);
			item.description = `${cm.role} · ${cm.scope}`;
			item.iconPath = arcanaIcon(this.extensionUri, '01-the-magician.svg');
			item.contextValue = 'tarotCrewmate';
			item.tooltip = [
				`${cm.name} — ${cm.role} (${cm.scope})`,
				cm.description,
				cm.agentProfileId ? vscode.l10n.t('Agent Profile: {0}', cm.agentProfileId) : undefined,
				vscode.l10n.t('Memory: {0}', cm.memoryPath),
			].filter(Boolean).join('\n');
			item.command = {
				command: 'tarot.crew.openDashboard',
				title: vscode.l10n.t('Open Crewmate Dashboard'),
				arguments: [item],
			};
			return item;
		});
	}
}

export class CrewTasksTreeProvider extends BaseTarotTreeProvider {
	constructor(
		private readonly crewService: TarotCrewService,
		private readonly extensionUri: vscode.Uri,
	) {
		super(['**/TASK.md', '**/.tarot/crew/tasks/*.md']);
	}

	async getChildren(): Promise<SimpleTreeItem[]> {
		if (!vscode.workspace.isTrusted) {
			return [];
		}
		const root = getWorkspaceRoot();
		if (!root) {
			return [];
		}
		const files = await this.crewService.discoverTaskFiles(root);
		return files.map(tf => {
			const item = new CrewTaskFileTreeItem(tf.label, tf);
			item.description = `${tf.doneCount}/${tf.totalCount}`;
			item.iconPath = tf.totalCount > 0 && tf.doneCount === tf.totalCount
				? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'))
				: arcanaIcon(this.extensionUri, '05-the-hierophant.svg');
			item.contextValue = 'tarotCrewTaskFile';
			item.tooltip = vscode.l10n.t('{0} ({1}/{2} tasks completed)', tf.label, tf.doneCount, tf.totalCount);
			item.command = {
				command: 'vscode.open',
				title: vscode.l10n.t('Open Task File'),
				arguments: [vscode.Uri.file(tf.path)],
			};
			return item;
		});
	}
}

export class CrewMemoryKnowledgeTreeProvider extends BaseTarotTreeProvider {
	constructor(
		private readonly crewService: TarotCrewService,
	) {
		super([
			'**/.tarot/crew/memory/**',
			'**/.tarot/crew/knowledge/sources.json',
			'**/.tarot/steering/learned-lessons.md',
		]);
	}

	async getChildren(element?: SimpleTreeItem): Promise<SimpleTreeItem[]> {
		if (element?.children) {
			return element.children;
		}
		const root = vscode.workspace.isTrusted ? getWorkspaceRoot() : undefined;
		const memPaths = this.crewService.getMemoryPaths(root);

		const makeMemoryItem = (label: string, desc: string, kind: 'preferences' | 'projects' | 'todayHistory' | 'lessons', icon: string): SimpleTreeItem => {
			const item = new SimpleTreeItem(label, vscode.TreeItemCollapsibleState.None);
			item.description = desc;
			item.iconPath = new vscode.ThemeIcon(icon);
			item.command = {
				command: 'tarot.crew.openMemoryFile',
				title: vscode.l10n.t('Open Memory File'),
				arguments: [kind],
			};
			return item;
		};

		const memoryItems: SimpleTreeItem[] = [
			makeMemoryItem(vscode.l10n.t('Preferences'), 'preferences.md', 'preferences', 'settings'),
			makeMemoryItem(vscode.l10n.t('Active Projects'), 'projects.md', 'projects', 'project'),
			makeMemoryItem(vscode.l10n.t('Daily History'), 'history/today.md', 'todayHistory', 'history'),
			makeMemoryItem(vscode.l10n.t('Learned Lessons'), 'learned-lessons.md', 'lessons', 'mortar-board'),
		];
		const memoryGroup = new SimpleTreeItem(
			vscode.l10n.t('Persistent Memory'),
			vscode.TreeItemCollapsibleState.Expanded,
			memPaths.dir,
			memoryItems,
		);
		memoryGroup.iconPath = new vscode.ThemeIcon('database');

		const sources = root ? await this.crewService.listKnowledgeSources(root) : [];
		const knowledgeItems: SimpleTreeItem[] = sources.map(src => {
			const item = new KnowledgeSourceTreeItem(src.label, src);
			item.description = src.status === 'indexed'
				? vscode.l10n.t('Indexed ({0} chunks)', src.chunkCount)
				: vscode.l10n.t('Pending scan');
			item.iconPath = new vscode.ThemeIcon(src.status === 'indexed' ? 'library' : 'sync');
			item.contextValue = 'tarotKnowledgeSource';
			item.tooltip = `${src.targetPath}\n${src.lastIndexedAt ? vscode.l10n.t('Last indexed: {0}', src.lastIndexedAt) : vscode.l10n.t('Click Scan Now to index this source.')}`;
			return item;
		});
		const knowledgeGroup = new SimpleTreeItem(
			vscode.l10n.t('Knowledge Library'),
			vscode.TreeItemCollapsibleState.Expanded,
			undefined,
			knowledgeItems,
		);
		knowledgeGroup.description = `(${knowledgeItems.length})`;
		knowledgeGroup.iconPath = new vscode.ThemeIcon('book');

		return [memoryGroup, knowledgeGroup];
	}
}

export class CrewSchedulesTreeProvider extends BaseTarotTreeProvider {
	constructor(
		private readonly scheduleService: TarotScheduleService,
		private readonly extensionUri: vscode.Uri,
	) {
		super(['**/.tarot/schedules/*.json']);
	}

	async getChildren(element?: SimpleTreeItem): Promise<SimpleTreeItem[]> {
		if (element?.children) {
			return element.children;
		}
		if (!vscode.workspace.isTrusted) {
			return [];
		}
		const root = getWorkspaceRoot();
		const { jobs } = await this.scheduleService.discover(root);
		return jobs.map(job => {
			const item = new ScheduleJobTreeItem(job.name, job);
			item.description = `${job.cron}${job.enabled ? '' : vscode.l10n.t(' (disabled)')}`;
			item.iconPath = job.enabled
				? arcanaIcon(this.extensionUri, '10-wheel-of-fortune.svg')
				: new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
			item.contextValue = job.enabled ? 'tarotScheduleEnabled' : 'tarotScheduleDisabled';
			item.tooltip = [
				`${job.name} (${job.scope})`,
				vscode.l10n.t('Cron: {0}', job.cron),
				vscode.l10n.t('Action: {0}', job.action.type),
				vscode.l10n.t('File: {0}', job.sourceFile),
			].join('\n');
			item.command = {
				command: 'tarot.schedule.openEditor',
				title: vscode.l10n.t('Open Schedule Visual Editor'),
				arguments: [job],
			};
			return item;
		});
	}
}

export interface CrewmateDashboardActions {
	readonly startSession: (crewmate: CrewmateDefinition) => Promise<void>;
	readonly openFile: (filePath: string) => Promise<void>;
	readonly appendNote: (crewmate: CrewmateDefinition, note: string) => Promise<CrewLedgerEntry>;
	readonly toggleStar: (crewmate: CrewmateDefinition) => Promise<boolean>;
	readonly loadState: (crewmate: CrewmateDefinition) => Promise<{
		readonly memory: string;
		readonly ledger: readonly CrewLedgerEntry[];
	}>;
}

/**
 * Crewmate Dashboard WebviewPanel (Kiro Crewmate identity + private memory + Work Ledger).
 * Strictly enforces CSP with nonce and renders via safe DOM APIs (zero unsafe HTML injection).
 */
export class TarotCrewmateDashboardPanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private activeCrewmate: CrewmateDefinition | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly actions: CrewmateDashboardActions) { }

	async show(crewmate: CrewmateDefinition): Promise<void> {
		this.activeCrewmate = crewmate;
		const title = vscode.l10n.t('Crewmate: {0}', crewmate.name);

		if (!this.panel) {
			this.panel = vscode.window.createWebviewPanel(
				'tarot.crewmateDashboard',
				title,
				vscode.ViewColumn.Active,
				{ enableScripts: true, retainContextWhenHidden: true },
			);
			this.panel.onDidDispose(() => {
				this.panel = undefined;
				this.activeCrewmate = undefined;
			}, null, this.disposables);
			this.panel.webview.onDidReceiveMessage(async msg => {
				if (!msg || typeof msg !== 'object' || !this.activeCrewmate) {
					return;
				}
				const m = msg as { type?: string; note?: string; path?: string };
				if (m.type === 'startSession') {
					await this.actions.startSession(this.activeCrewmate);
				} else if (m.type === 'openFile' && typeof m.path === 'string') {
					await this.actions.openFile(m.path);
				} else if (m.type === 'toggleStar') {
					const starred = await this.actions.toggleStar(this.activeCrewmate);
					this.activeCrewmate = { ...this.activeCrewmate, starred };
					await this.postState();
				} else if (m.type === 'addNote' && typeof m.note === 'string' && m.note.trim()) {
					await this.actions.appendNote(this.activeCrewmate, m.note.trim());
					await this.postState();
				}
			}, null, this.disposables);
			this.panel.webview.html = this.buildShellHtml(this.panel.webview);
		} else {
			this.panel.title = title;
			this.panel.reveal(vscode.ViewColumn.Active);
		}

		await this.postState();
	}

	private async postState(): Promise<void> {
		if (!this.panel || !this.activeCrewmate) {
			return;
		}
		const { memory, ledger } = await this.actions.loadState(this.activeCrewmate);
		void this.panel.webview.postMessage({
			type: 'render',
			crewmate: this.activeCrewmate,
			memory,
			ledger,
			l10n: {
				startSession: vscode.l10n.t('Start Session with Crewmate'),
				openMemory: vscode.l10n.t('Edit memory.md'),
				openConfig: vscode.l10n.t('Open crewmate.json'),
				star: this.activeCrewmate.starred ? vscode.l10n.t('★ Starred') : vscode.l10n.t('☆ Star'),
				memoryHeading: vscode.l10n.t('Private Memory'),
				ledgerHeading: vscode.l10n.t('Work Ledger'),
				notePlaceholder: vscode.l10n.t('Record a note or decision in the Work Ledger...'),
				addNote: vscode.l10n.t('Add Entry'),
				emptyLedger: vscode.l10n.t('No Work Ledger entries yet.'),
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
	body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 24px 28px; max-width: 880px; line-height: 1.5; }
	.header { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 16px; margin-bottom: 20px; }
	.title-row { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
	h1 { margin: 0; font-size: 22px; font-weight: 600; }
	.badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
	.desc { color: var(--vscode-descriptionForeground); margin: 6px 0 12px; }
	.actions { display: flex; gap: 8px; flex-wrap: wrap; }
	button { border: none; border-radius: 4px; padding: 6px 12px; cursor: pointer; font-size: 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
	button:hover { background: var(--vscode-button-hoverBackground); }
	button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); margin: 20px 0 8px; }
	.mem { background: var(--vscode-textBlockQuote-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 12px 14px; font-size: 12.5px; max-height: 240px; overflow-y: auto; line-height: 1.5; }
	.mem-h1 { font-weight: 700; font-size: 14px; margin-bottom: 6px; }
	.mem-h2 { font-weight: 600; font-size: 12.5px; margin: 10px 0 4px; color: var(--vscode-descriptionForeground); }
	.mem-li { padding-left: 8px; margin-bottom: 3px; }
	.mem-p { margin-bottom: 4px; }
	.note-row { display: flex; gap: 8px; margin-bottom: 12px; }
	input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, rgba(255, 255, 255, 0.14)); border-radius: 6px; padding: 6px 10px; font-size: 12px; transition: border-color 0.15s ease, box-shadow 0.15s ease; }
	input:focus { outline: none; border-color: #8B5CF6; box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.25); }
	.ledger-item { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; }
	.ledger-meta { display: flex; justify-content: space-between; font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
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
		if (!msg || msg.type !== 'render' || !msg.crewmate) return;
		const cm = msg.crewmate;
		const t = msg.l10n || {};
		const frag = document.createDocumentFragment();

		const header = el('div', 'header');
		const titleRow = el('div', 'title-row');
		titleRow.appendChild(el('h1', '', cm.name));
		titleRow.appendChild(el('span', 'badge', cm.role));
		titleRow.appendChild(el('span', 'badge', cm.scope));
		header.appendChild(titleRow);
		if (cm.description) header.appendChild(el('p', 'desc', cm.description));

		const actions = el('div', 'actions');
		const startBtn = el('button', '', t.startSession || 'Start Session');
		startBtn.addEventListener('click', () => vscode.postMessage({ type: 'startSession' }));
		actions.appendChild(startBtn);

		const memBtn = el('button', 'secondary', t.openMemory || 'Edit memory.md');
		memBtn.addEventListener('click', () => vscode.postMessage({ type: 'openFile', path: cm.memoryPath }));
		actions.appendChild(memBtn);

		const cfgBtn = el('button', 'secondary', t.openConfig || 'Open crewmate.json');
		cfgBtn.addEventListener('click', () => vscode.postMessage({ type: 'openFile', path: cm.configPath }));
		actions.appendChild(cfgBtn);

		const starBtn = el('button', 'secondary', t.star || 'Star');
		starBtn.addEventListener('click', () => vscode.postMessage({ type: 'toggleStar' }));
		actions.appendChild(starBtn);
		header.appendChild(actions);
		frag.appendChild(header);

		frag.appendChild(el('h2', '', t.memoryHeading || 'Private Memory'));
		const memBox = el('div', 'mem');
		const memLines = String(msg.memory || '').split(/\\r?\\n/);
		for (const ln of memLines) {
			const trimmed = ln.trim();
			if (!trimmed) continue;
			if (trimmed.startsWith('## ')) {
				memBox.appendChild(el('div', 'mem-h2', trimmed.slice(3)));
			} else if (trimmed.startsWith('# ')) {
				memBox.appendChild(el('div', 'mem-h1', trimmed.slice(2)));
			} else if (trimmed.startsWith('- ')) {
				memBox.appendChild(el('div', 'mem-li', '• ' + trimmed.slice(2).replace(/\\*\\*/g, '')));
			} else {
				memBox.appendChild(el('div', 'mem-p', trimmed.replace(/\\*\\*/g, '')));
			}
		}
		frag.appendChild(memBox);

		frag.appendChild(el('h2', '', t.ledgerHeading || 'Work Ledger'));
		const noteRow = el('div', 'note-row');
		const input = document.createElement('input');
		input.type = 'text';
		input.placeholder = t.notePlaceholder || '';
		const addBtn = el('button', '', t.addNote || 'Add Entry');
		const submitNote = () => {
			if (!input.value.trim()) return;
			vscode.postMessage({ type: 'addNote', note: input.value.trim() });
			input.value = '';
		};
		addBtn.addEventListener('click', submitNote);
		input.addEventListener('keydown', e => { if (e.key === 'Enter') submitNote(); });
		noteRow.appendChild(input);
		noteRow.appendChild(addBtn);
		frag.appendChild(noteRow);

		const ledger = msg.ledger || [];
		if (ledger.length === 0) {
			frag.appendChild(el('p', 'desc', t.emptyLedger || 'No entries yet.'));
		} else {
			for (const entry of ledger) {
				const card = el('div', 'ledger-item');
				const meta = el('div', 'ledger-meta');
				meta.appendChild(el('span', '', '[' + entry.kind + ' · ' + entry.status + ']'));
				meta.appendChild(el('span', '', entry.timestamp));
				card.appendChild(meta);
				card.appendChild(el('div', '', entry.summary));
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
