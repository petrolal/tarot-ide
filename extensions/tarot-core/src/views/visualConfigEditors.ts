/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { HookDefinition, HookTrigger } from '../hooks/hookTypes';
import { TarotMcpConfigService } from '../mcp/mcpConfigService';
import { isValidCronExpression } from '../schedule/cronParser';
import { ScheduledJobDefinition, TarotScheduleService } from '../schedule/scheduleService';
import { getWorkspaceRoot } from './tarotSidebarViews';

const HOOK_TRIGGERS: readonly HookTrigger[] = [
	'PostFileSave',
	'PostFileCreate',
	'PostFileDelete',
	'PreToolUse',
	'PostToolUse',
	'PromptSubmit',
	'Stop',
	'SessionStart',
	'SessionEnd',
	'PreCompaction',
	'PostCompaction',
	'PermissionRequest',
	'PreTaskExecution',
	'PostTaskExecution',
];

function buildBaseStyle(nonce: string): string {
	return `<style nonce="${nonce}">
	body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 24px 28px; max-width: 820px; line-height: 1.5; }
	.top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 14px; margin-bottom: 18px; flex-wrap: wrap; }
	h1 { margin: 0; font-size: 20px; font-weight: 600; }
	.sub { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 3px; }
	.actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
	button { border: none; border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 12px; font-weight: 500; background: #7C3AED; color: #FFFFFF; }
	button:hover { background: #6D28D9; }
	button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	button.danger { background: rgba(248, 113, 113, 0.16); color: #FCA5A5; border: 1px solid rgba(248, 113, 113, 0.4); }
	label.field { display: block; margin-bottom: 12px; }
	label.field span { display: block; font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
	input, select, textarea { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 6px; padding: 7px 10px; font: inherit; font-size: 12.5px; }
	textarea { min-height: 96px; resize: vertical; font-family: var(--vscode-editor-font-family); }
	.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
	.toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; cursor: pointer; }
	.toggle input { width: auto; }
	.presets { display: flex; gap: 6px; flex-wrap: wrap; margin: -6px 0 12px; }
	.preset-btn { padding: 3px 8px; font-size: 11px; border-radius: 999px; background: rgba(139, 92, 246, 0.14); color: #DDD6FE; border: 1px solid rgba(139, 92, 246, 0.35); }
	.card { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 10px 14px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; gap: 10px; }
	.card-title { font-weight: 600; font-size: 13px; }
	.badge { font-size: 11px; padding: 2px 7px; border-radius: 999px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin-left: 6px; }
	.footer { display: flex; justify-content: space-between; align-items: center; margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--vscode-panel-border); }
	h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); margin: 20px 0 8px; }
</style>`;
}

/**
 * Visual Agent Hook Editor WebviewPanel (Kiro Hook Management parity).
 * CSP-strict with nonce, zero unsafe HTML injection.
 */
export class TarotHookVisualEditorPanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private activeHook: HookDefinition | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly onChanged: () => void) { }

	show(hook: HookDefinition): void {
		this.activeHook = hook;
		const title = vscode.l10n.t('Hook: {0}', hook.name);
		if (!this.panel) {
			this.panel = vscode.window.createWebviewPanel(
				'tarot.hookVisualEditor',
				title,
				vscode.ViewColumn.Active,
				{ enableScripts: true, retainContextWhenHidden: true },
			);
			this.panel.onDidDispose(() => {
				this.panel = undefined;
				this.activeHook = undefined;
			}, null, this.disposables);
			this.panel.webview.onDidReceiveMessage(async msg => {
				if (!msg || typeof msg !== 'object' || !this.activeHook) {
					return;
				}
				const m = msg as Record<string, unknown>;
				if (m.type === 'openJson') {
					const doc = await vscode.workspace.openTextDocument(this.activeHook.sourceFile);
					await vscode.window.showTextDocument(doc);
				} else if (m.type === 'runNow') {
					await vscode.commands.executeCommand('tarot.hooks.runManual', { hook: this.activeHook });
				} else if (m.type === 'save') {
					await this.saveHook(this.activeHook, m);
				} else if (m.type === 'delete') {
					await this.deleteHook(this.activeHook);
				}
			}, null, this.disposables);
			this.panel.webview.html = this.buildHtml(this.panel.webview);
		} else {
			this.panel.title = title;
			this.panel.reveal(vscode.ViewColumn.Active);
		}
		void this.panel.webview.postMessage({ type: 'render', hook, triggers: HOOK_TRIGGERS });
	}

	private async saveHook(hook: HookDefinition, data: Record<string, unknown>): Promise<void> {
		try {
			const raw = JSON.parse(await fs.readFile(hook.sourceFile, 'utf8')) as { version?: string; hooks?: Array<Record<string, unknown>> } & Record<string, unknown>;
			const updateObj = (target: Record<string, unknown>): void => {
				target.name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : hook.name;
				target.description = typeof data.description === 'string' ? data.description.trim() : '';
				target.enabled = data.enabled === true;
				target.trigger = typeof data.trigger === 'string' ? data.trigger : hook.trigger;
				const matcher = typeof data.matcher === 'string' ? data.matcher.trim() : '';
				if (matcher) {
					target.matcher = matcher;
				} else {
					delete target.matcher;
				}
				const timeout = Number(data.timeout);
				if (Number.isFinite(timeout) && timeout > 0) {
					target.timeout = Math.floor(timeout);
				}
				const actionType = data.actionType === 'command' ? 'command' : 'agent';
				const value = typeof data.actionValue === 'string' ? data.actionValue.trim() : '';
				target.action = actionType === 'command'
					? { type: 'command', command: value }
					: { type: 'agent', prompt: value };
			};

			if (Array.isArray(raw.hooks)) {
				const found = raw.hooks.find(h => h.name === hook.name) ?? raw.hooks[0];
				if (found) {
					updateObj(found);
				}
			} else {
				updateObj(raw);
			}
			await fs.writeFile(hook.sourceFile, JSON.stringify(raw, null, 2) + '\n', 'utf8');
			this.onChanged();
			vscode.window.showInformationMessage(vscode.l10n.t('Hook "{0}" saved.', String(data.name || hook.name)));
		} catch (err) {
			vscode.window.showErrorMessage(vscode.l10n.t('Failed to save hook: {0}', err instanceof Error ? err.message : String(err)));
		}
	}

	private async deleteHook(hook: HookDefinition): Promise<void> {
		const delLabel = vscode.l10n.t('Delete Hook');
		const choice = await vscode.window.showWarningMessage(
			vscode.l10n.t('Delete hook file "{0}"?', path.basename(hook.sourceFile)),
			{ modal: true },
			delLabel,
		);
		if (choice !== delLabel) {
			return;
		}
		const targetAbs = path.resolve(hook.sourceFile);
		const root = getWorkspaceRoot();
		const allowedRoots = [path.join(os.homedir(), '.tarot', 'hooks')];
		if (root) {
			allowedRoots.push(path.join(root, '.tarot', 'hooks'));
		}
		if (!allowedRoots.some(r => targetAbs.startsWith(path.resolve(r) + path.sep))) {
			vscode.window.showErrorMessage(vscode.l10n.t('Refusing to delete file outside .tarot/hooks/.'));
			return;
		}
		await fs.rm(targetAbs, { force: true });
		this.onChanged();
		this.panel?.dispose();
		vscode.window.showInformationMessage(vscode.l10n.t('Hook "{0}" deleted.', hook.name));
	}

	private buildHtml(webview: vscode.Webview): string {
		const nonce = crypto.randomBytes(16).toString('base64');
		const csp = `default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
		return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />${buildBaseStyle(nonce)}</head>
<body><div id="root"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const root = document.getElementById('root');
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = String(text); return n; }

window.addEventListener('message', ev => {
	const msg = ev.data;
	if (!msg || msg.type !== 'render' || !msg.hook) return;
	const h = msg.hook;
	const frag = document.createDocumentFragment();

	const top = el('div', 'top');
	const left = el('div');
	left.appendChild(el('h1', '', h.name));
	left.appendChild(el('div', 'sub', h.sourceFile));
	top.appendChild(left);

	const actions = el('div', 'actions');
	const enabledLbl = el('label', 'toggle');
	const enabledChk = document.createElement('input');
	enabledChk.type = 'checkbox';
	enabledChk.checked = h.enabled !== false;
	enabledLbl.appendChild(enabledChk);
	enabledLbl.appendChild(document.createTextNode('Hook Enabled'));
	actions.appendChild(enabledLbl);

	const runBtn = el('button', 'secondary', '▶ Run Now');
	runBtn.addEventListener('click', () => vscode.postMessage({ type: 'runNow' }));
	actions.appendChild(runBtn);

	const jsonBtn = el('button', 'secondary', 'Open JSON');
	jsonBtn.addEventListener('click', () => vscode.postMessage({ type: 'openJson' }));
	actions.appendChild(jsonBtn);
	top.appendChild(actions);
	frag.appendChild(top);

	const mkField = (label, inputEl) => {
		const wrap = el('label', 'field');
		wrap.appendChild(el('span', '', label));
		wrap.appendChild(inputEl);
		return wrap;
	};

	const nameIn = document.createElement('input'); nameIn.value = h.name || '';
	const descIn = document.createElement('input'); descIn.value = h.description || '';
	const trigSel = document.createElement('select');
	for (const tr of (msg.triggers || [])) {
		const o = document.createElement('option'); o.value = tr; o.textContent = tr;
		if (tr === h.trigger) o.selected = true;
		trigSel.appendChild(o);
	}
	const matcherIn = document.createElement('input'); matcherIn.value = h.matcher || ''; matcherIn.placeholder = '\\\\.(ts|tsx)$';
	const timeoutIn = document.createElement('input'); timeoutIn.type = 'number'; timeoutIn.value = String(h.timeout || 60);
	const actTypeSel = document.createElement('select');
	for (const t of ['agent', 'command']) {
		const o = document.createElement('option'); o.value = t; o.textContent = t === 'agent' ? 'Agent Prompt' : 'Shell Command';
		if (h.action && h.action.type === t) o.selected = true;
		actTypeSel.appendChild(o);
	}
	const actValIn = document.createElement('textarea');
	actValIn.value = (h.action && (h.action.prompt || h.action.command)) || '';

	const g1 = el('div', 'grid2');
	g1.appendChild(mkField('Hook Name', nameIn));
	g1.appendChild(mkField('Trigger Event', trigSel));
	frag.appendChild(g1);
	frag.appendChild(mkField('Description', descIn));

	const g2 = el('div', 'grid2');
	g2.appendChild(mkField('Matcher Regex (Optional)', matcherIn));
	g2.appendChild(mkField('Timeout (seconds)', timeoutIn));
	frag.appendChild(g2);

	frag.appendChild(mkField('Action Type', actTypeSel));
	frag.appendChild(mkField('Prompt / Command', actValIn));

	const footer = el('div', 'footer');
	const delBtn = el('button', 'danger', 'Delete Hook');
	delBtn.addEventListener('click', () => vscode.postMessage({ type: 'delete' }));
	const saveBtn = el('button', '', 'Save Changes');
	saveBtn.addEventListener('click', () => vscode.postMessage({
		type: 'save',
		name: nameIn.value,
		description: descIn.value,
		enabled: enabledChk.checked,
		trigger: trigSel.value,
		matcher: matcherIn.value,
		timeout: Number(timeoutIn.value),
		actionType: actTypeSel.value,
		actionValue: actValIn.value,
	}));
	footer.appendChild(delBtn);
	footer.appendChild(saveBtn);
	frag.appendChild(footer);

	root.replaceChildren(frag);
});
</script></body></html>`;
	}

	dispose(): void {
		this.panel?.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}

/**
 * Visual Schedule Editor WebviewPanel (Kiro Crew Schedules parity).
 * CSP-strict with nonce, zero unsafe HTML injection.
 */
export class TarotScheduleVisualEditorPanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private activeJob: ScheduledJobDefinition | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly scheduleService: TarotScheduleService,
		private readonly onChanged: () => void,
	) { }

	async show(job: ScheduledJobDefinition): Promise<void> {
		this.activeJob = job;
		const title = vscode.l10n.t('Schedule: {0}', job.name);
		if (!this.panel) {
			this.panel = vscode.window.createWebviewPanel(
				'tarot.scheduleVisualEditor',
				title,
				vscode.ViewColumn.Active,
				{ enableScripts: true, retainContextWhenHidden: true },
			);
			this.panel.onDidDispose(() => {
				this.panel = undefined;
				this.activeJob = undefined;
			}, null, this.disposables);
			this.panel.webview.onDidReceiveMessage(async msg => {
				if (!msg || typeof msg !== 'object' || !this.activeJob) {
					return;
				}
				const m = msg as Record<string, unknown>;
				if (m.type === 'openJson') {
					const doc = await vscode.workspace.openTextDocument(this.activeJob.sourceFile);
					await vscode.window.showTextDocument(doc);
				} else if (m.type === 'openDigest' && typeof m.path === 'string') {
					const doc = await vscode.workspace.openTextDocument(m.path);
					await vscode.window.showTextDocument(doc);
				} else if (m.type === 'runNow') {
					await vscode.commands.executeCommand('tarot.schedule.runNow');
				} else if (m.type === 'save') {
					await this.saveJob(this.activeJob, m);
				} else if (m.type === 'delete') {
					await this.deleteJob(this.activeJob);
				}
			}, null, this.disposables);
			this.panel.webview.html = this.buildHtml(this.panel.webview);
		} else {
			this.panel.title = title;
			this.panel.reveal(vscode.ViewColumn.Active);
		}
		const root = getWorkspaceRoot();
		const digests = root ? (await this.scheduleService.listDigests(root)).slice(0, 8) : [];
		void this.panel.webview.postMessage({
			type: 'render',
			job,
			digests: digests.map(p => ({ name: path.basename(p), path: p })),
		});
	}

	private async saveJob(job: ScheduledJobDefinition, data: Record<string, unknown>): Promise<void> {
		const cron = typeof data.cron === 'string' ? data.cron.trim() : '';
		if (!isValidCronExpression(cron)) {
			vscode.window.showErrorMessage(vscode.l10n.t('Invalid 5-field cron expression: "{0}".', cron));
			return;
		}
		try {
			const raw = JSON.parse(await fs.readFile(job.sourceFile, 'utf8')) as { jobs?: Array<Record<string, unknown>> } & Record<string, unknown>;
			const updateObj = (target: Record<string, unknown>): void => {
				target.name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : job.name;
				target.enabled = data.enabled === true;
				target.cron = cron;
				const tz = typeof data.timezone === 'string' ? data.timezone.trim() : '';
				if (tz) {
					target.timezone = tz;
				}
				const timeoutSec = Number(data.timeoutSec);
				if (Number.isFinite(timeoutSec) && timeoutSec > 0) {
					target.timeoutSec = Math.floor(timeoutSec);
				}
				const actionType = data.actionType === 'command' ? 'command' : 'agent';
				const value = typeof data.actionValue === 'string' ? data.actionValue.trim() : '';
				target.action = actionType === 'command'
					? { type: 'command', command: value }
					: { type: 'agent', prompt: value };
			};
			if (Array.isArray(raw.jobs)) {
				const found = raw.jobs.find(j => j.id === job.id || j.name === job.name) ?? raw.jobs[0];
				if (found) {
					updateObj(found);
				}
			} else {
				updateObj(raw);
			}
			await fs.writeFile(job.sourceFile, JSON.stringify(raw, null, 2) + '\n', 'utf8');
			this.onChanged();
			vscode.window.showInformationMessage(vscode.l10n.t('Schedule "{0}" saved.', String(data.name || job.name)));
		} catch (err) {
			vscode.window.showErrorMessage(vscode.l10n.t('Failed to save schedule: {0}', err instanceof Error ? err.message : String(err)));
		}
	}

	private async deleteJob(job: ScheduledJobDefinition): Promise<void> {
		const delLabel = vscode.l10n.t('Delete Schedule');
		const choice = await vscode.window.showWarningMessage(
			vscode.l10n.t('Delete schedule file "{0}"?', path.basename(job.sourceFile)),
			{ modal: true },
			delLabel,
		);
		if (choice !== delLabel) {
			return;
		}
		const targetAbs = path.resolve(job.sourceFile);
		const root = getWorkspaceRoot();
		const allowedRoots = [this.scheduleService.getGlobalSchedulesDir()];
		if (root) {
			allowedRoots.push(this.scheduleService.getWorkspaceSchedulesDir(root));
		}
		if (!allowedRoots.some(r => targetAbs.startsWith(path.resolve(r) + path.sep))) {
			vscode.window.showErrorMessage(vscode.l10n.t('Refusing to delete file outside .tarot/schedules/.'));
			return;
		}
		await fs.rm(targetAbs, { force: true });
		this.onChanged();
		this.panel?.dispose();
		vscode.window.showInformationMessage(vscode.l10n.t('Schedule "{0}" deleted.', job.name));
	}

	private buildHtml(webview: vscode.Webview): string {
		const nonce = crypto.randomBytes(16).toString('base64');
		const csp = `default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
		return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />${buildBaseStyle(nonce)}</head>
<body><div id="root"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const root = document.getElementById('root');
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = String(text); return n; }

window.addEventListener('message', ev => {
	const msg = ev.data;
	if (!msg || msg.type !== 'render' || !msg.job) return;
	const j = msg.job;
	const frag = document.createDocumentFragment();

	const top = el('div', 'top');
	const left = el('div');
	left.appendChild(el('h1', '', j.name));
	left.appendChild(el('div', 'sub', j.sourceFile));
	top.appendChild(left);

	const actions = el('div', 'actions');
	const enabledLbl = el('label', 'toggle');
	const enabledChk = document.createElement('input'); enabledChk.type = 'checkbox'; enabledChk.checked = j.enabled !== false;
	enabledLbl.appendChild(enabledChk); enabledLbl.appendChild(document.createTextNode('Enabled'));
	actions.appendChild(enabledLbl);
	const runBtn = el('button', 'secondary', '▶ Run Now');
	runBtn.addEventListener('click', () => vscode.postMessage({ type: 'runNow' }));
	actions.appendChild(runBtn);
	const jsonBtn = el('button', 'secondary', 'Open JSON');
	jsonBtn.addEventListener('click', () => vscode.postMessage({ type: 'openJson' }));
	actions.appendChild(jsonBtn);
	top.appendChild(actions);
	frag.appendChild(top);

	const mkField = (label, inputEl) => {
		const w = el('label', 'field'); w.appendChild(el('span', '', label)); w.appendChild(inputEl); return w;
	};

	const nameIn = document.createElement('input'); nameIn.value = j.name || '';
	const cronIn = document.createElement('input'); cronIn.value = j.cron || '0 9 * * 1-5';
	const tzIn = document.createElement('input'); tzIn.value = j.timezone || 'America/Sao_Paulo';
	const toIn = document.createElement('input'); toIn.type = 'number'; toIn.value = String(j.timeoutSec || 300);
	const actSel = document.createElement('select');
	for (const t of ['agent', 'command']) {
		const o = document.createElement('option'); o.value = t; o.textContent = t === 'agent' ? 'Agent Prompt (isolated session)' : 'Shell Command (0 tokens)';
		if (j.action && j.action.type === t) o.selected = true;
		actSel.appendChild(o);
	}
	const valIn = document.createElement('textarea');
	valIn.value = (j.action && (j.action.prompt || j.action.command)) || '';

	const g1 = el('div', 'grid2');
	g1.appendChild(mkField('Schedule Name', nameIn));
	g1.appendChild(mkField('Cron (5-field)', cronIn));
	frag.appendChild(g1);

	const presets = el('div', 'presets');
	for (const [lbl, expr] of [['Weekdays 9am', '0 9 * * 1-5'], ['Every 30m', '*/30 * * * *'], ['Hourly', '0 * * * *'], ['Daily midnight', '0 0 * * *']]) {
		const b = el('button', 'preset-btn', lbl + ' (' + expr + ')');
		b.type = 'button';
		b.addEventListener('click', () => { cronIn.value = expr; });
		presets.appendChild(b);
	}
	frag.appendChild(presets);

	const g2 = el('div', 'grid2');
	g2.appendChild(mkField('Timezone', tzIn));
	g2.appendChild(mkField('Timeout (seconds)', toIn));
	frag.appendChild(g2);

	frag.appendChild(mkField('Action Type', actSel));
	frag.appendChild(mkField('Prompt / Command', valIn));

	const footer = el('div', 'footer');
	const delBtn = el('button', 'danger', 'Delete Schedule');
	delBtn.addEventListener('click', () => vscode.postMessage({ type: 'delete' }));
	const saveBtn = el('button', '', 'Save Schedule');
	saveBtn.addEventListener('click', () => vscode.postMessage({
		type: 'save',
		name: nameIn.value,
		enabled: enabledChk.checked,
		cron: cronIn.value,
		timezone: tzIn.value,
		timeoutSec: Number(toIn.value),
		actionType: actSel.value,
		actionValue: valIn.value,
	}));
	footer.appendChild(delBtn); footer.appendChild(saveBtn);
	frag.appendChild(footer);

	const digests = msg.digests || [];
	if (digests.length > 0) {
		frag.appendChild(el('h2', '', 'Recent Digests'));
		for (const d of digests) {
			const card = el('div', 'card');
			card.appendChild(el('span', '', d.name));
			const ob = el('button', 'secondary', 'Open');
			ob.addEventListener('click', () => vscode.postMessage({ type: 'openDigest', path: d.path }));
			card.appendChild(ob);
			frag.appendChild(card);
		}
	}

	root.replaceChildren(frag);
});
</script></body></html>`;
	}

	dispose(): void {
		this.panel?.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}

/**
 * Visual MCP Server Configurator WebviewPanel (manages `.tarot/settings/mcp.json` & `~/.tarot/settings/mcp.json`
 * visually while preserving 1-click `Open Raw mcp.json`). CSP-strict, zero unsafe HTML injection.
 */
export class TarotMcpVisualEditorPanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private scope: 'workspace' | 'global' = 'workspace';
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly mcpService: TarotMcpConfigService,
		private readonly onChanged: () => void,
	) { }

	private getTargetFile(): string | undefined {
		if (this.scope === 'global') {
			return this.mcpService.getGlobalMcpConfigPath();
		}
		const root = getWorkspaceRoot();
		return root ? this.mcpService.getWorkspaceMcpConfigPath(root) : this.mcpService.getGlobalMcpConfigPath();
	}

	async show(): Promise<void> {
		const root = getWorkspaceRoot();
		this.scope = root && vscode.workspace.isTrusted ? 'workspace' : 'global';

		if (!this.panel) {
			this.panel = vscode.window.createWebviewPanel(
				'tarot.mcpVisualEditor',
				vscode.l10n.t('MCP Servers Configuration'),
				vscode.ViewColumn.Active,
				{ enableScripts: true, retainContextWhenHidden: true },
			);
			this.panel.onDidDispose(() => {
				this.panel = undefined;
			}, null, this.disposables);
			this.panel.webview.onDidReceiveMessage(async msg => {
				if (!msg || typeof msg !== 'object') {
					return;
				}
				const m = msg as Record<string, unknown>;
				if (m.type === 'switchScope') {
					this.scope = m.scope === 'global' ? 'global' : 'workspace';
					await this.postState();
				} else if (m.type === 'openJson') {
					const target = await this.ensureMcpFile();
					if (target) {
						const doc = await vscode.workspace.openTextDocument(target);
						await vscode.window.showTextDocument(doc);
					}
				} else if (m.type === 'addServer') {
					await this.addServer(m);
				} else if (m.type === 'toggleServer' && typeof m.name === 'string') {
					await this.toggleServer(m.name);
				} else if (m.type === 'removeServer' && typeof m.name === 'string') {
					await this.removeServer(m.name);
				}
			}, null, this.disposables);
			this.panel.webview.html = this.buildHtml(this.panel.webview);
		} else {
			this.panel.reveal(vscode.ViewColumn.Active);
		}
		await this.postState();
	}

	private async ensureMcpFile(): Promise<string | undefined> {
		if (this.scope === 'workspace' && !vscode.workspace.isTrusted) {
			vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace to edit .tarot/settings/mcp.json.'));
			return undefined;
		}
		const target = this.getTargetFile();
		if (!target) {
			return undefined;
		}
		await fs.mkdir(path.dirname(target), { recursive: true });
		try {
			await fs.access(target);
		} catch {
			await fs.writeFile(target, JSON.stringify({ mcpServers: {} }, null, 2) + '\n', 'utf8');
		}
		return target;
	}

	private async readRawMcp(filePath: string): Promise<{ mcpServers: Record<string, Record<string, unknown>> }> {
		try {
			const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as { mcpServers?: Record<string, Record<string, unknown>> };
			return { mcpServers: parsed.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : {} };
		} catch {
			return { mcpServers: {} };
		}
	}

	private async postState(): Promise<void> {
		if (!this.panel) {
			return;
		}
		const target = this.getTargetFile() ?? '';
		const data = target ? await this.readRawMcp(target) : { mcpServers: {} };
		const servers = Object.entries(data.mcpServers).map(([name, cfg]) => ({
			name,
			transport: typeof cfg.url === 'string' && cfg.url ? 'remote' : 'stdio',
			summary: typeof cfg.url === 'string' && cfg.url
				? cfg.url
				: `${String(cfg.command ?? '')} ${Array.isArray(cfg.args) ? cfg.args.join(' ') : ''}`.trim(),
			enabled: cfg.disabled !== true,
		}));
		void this.panel.webview.postMessage({
			type: 'render',
			scope: this.scope,
			filePath: target,
			hasWorkspace: Boolean(getWorkspaceRoot() && vscode.workspace.isTrusted),
			servers,
		});
	}

	private async addServer(m: Record<string, unknown>): Promise<void> {
		const target = await this.ensureMcpFile();
		if (!target) {
			return;
		}
		const name = typeof m.name === 'string' ? m.name.trim() : '';
		if (!name) {
			vscode.window.showWarningMessage(vscode.l10n.t('Server name is required.'));
			return;
		}
		const data = await this.readRawMcp(target);
		if (m.transport === 'remote') {
			const url = typeof m.url === 'string' ? m.url.trim() : '';
			if (!url) {
				vscode.window.showWarningMessage(vscode.l10n.t('Remote server URL is required.'));
				return;
			}
			data.mcpServers[name] = { url, disabled: false };
		} else {
			const command = typeof m.command === 'string' ? m.command.trim() : '';
			if (!command) {
				vscode.window.showWarningMessage(vscode.l10n.t('Executable command is required.'));
				return;
			}
			const args = typeof m.args === 'string' && m.args.trim()
				? m.args.trim().split(/\s+/)
				: [];
			data.mcpServers[name] = { command, args, disabled: false };
		}
		await fs.writeFile(target, JSON.stringify(data, null, 2) + '\n', 'utf8');
		this.onChanged();
		await this.postState();
		vscode.window.showInformationMessage(vscode.l10n.t('MCP Server "{0}" added.', name));
	}

	private async toggleServer(name: string): Promise<void> {
		const target = await this.ensureMcpFile();
		if (!target) {
			return;
		}
		const data = await this.readRawMcp(target);
		if (data.mcpServers[name]) {
			data.mcpServers[name].disabled = data.mcpServers[name].disabled !== true;
			await fs.writeFile(target, JSON.stringify(data, null, 2) + '\n', 'utf8');
			this.onChanged();
			await this.postState();
		}
	}

	private async removeServer(name: string): Promise<void> {
		const target = await this.ensureMcpFile();
		if (!target) {
			return;
		}
		const data = await this.readRawMcp(target);
		delete data.mcpServers[name];
		await fs.writeFile(target, JSON.stringify(data, null, 2) + '\n', 'utf8');
		this.onChanged();
		await this.postState();
	}

	private buildHtml(webview: vscode.Webview): string {
		const nonce = crypto.randomBytes(16).toString('base64');
		const csp = `default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
		return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />${buildBaseStyle(nonce)}</head>
<body><div id="root"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const root = document.getElementById('root');
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = String(text); return n; }

window.addEventListener('message', ev => {
	const msg = ev.data;
	if (!msg || msg.type !== 'render') return;
	const frag = document.createDocumentFragment();

	const top = el('div', 'top');
	const left = el('div');
	left.appendChild(el('h1', '', 'MCP Servers'));
	left.appendChild(el('div', 'sub', msg.filePath || ''));
	top.appendChild(left);

	const actions = el('div', 'actions');
	if (msg.hasWorkspace) {
		const wsBtn = el('button', msg.scope === 'workspace' ? '' : 'secondary', 'Workspace');
		wsBtn.addEventListener('click', () => vscode.postMessage({ type: 'switchScope', scope: 'workspace' }));
		actions.appendChild(wsBtn);
	}
	const glBtn = el('button', msg.scope === 'global' ? '' : 'secondary', 'Global');
	glBtn.addEventListener('click', () => vscode.postMessage({ type: 'switchScope', scope: 'global' }));
	actions.appendChild(glBtn);

	const rawBtn = el('button', 'secondary', 'Open Raw mcp.json');
	rawBtn.addEventListener('click', () => vscode.postMessage({ type: 'openJson' }));
	actions.appendChild(rawBtn);
	top.appendChild(actions);
	frag.appendChild(top);

	frag.appendChild(el('h2', '', 'Configured Servers (' + (msg.servers || []).length + ')'));
	if (!msg.servers || msg.servers.length === 0) {
		frag.appendChild(el('p', 'sub', 'No MCP servers configured in this scope yet. Add one below.'));
	} else {
		for (const s of msg.servers) {
			const card = el('div', 'card');
			const info = el('div');
			const titleRow = el('div', 'card-title', s.name);
			titleRow.appendChild(el('span', 'badge', s.transport));
			if (!s.enabled) titleRow.appendChild(el('span', 'badge', 'disabled'));
			info.appendChild(titleRow);
			info.appendChild(el('div', 'sub', s.summary));
			card.appendChild(info);

			const btns = el('div', 'actions');
			const tog = el('button', 'secondary', s.enabled ? 'Disable' : 'Enable');
			tog.addEventListener('click', () => vscode.postMessage({ type: 'toggleServer', name: s.name }));
			const rm = el('button', 'danger', 'Remove');
			rm.addEventListener('click', () => vscode.postMessage({ type: 'removeServer', name: s.name }));
			btns.appendChild(tog); btns.appendChild(rm);
			card.appendChild(btns);
			frag.appendChild(card);
		}
	}

	frag.appendChild(el('h2', '', 'Add MCP Server'));
	const mkField = (label, inputEl) => {
		const w = el('label', 'field'); w.appendChild(el('span', '', label)); w.appendChild(inputEl); return w;
	};
	const nameIn = document.createElement('input'); nameIn.placeholder = 'e.g. filesystem, postgres, github';
	const transSel = document.createElement('select');
	for (const [v, l] of [['stdio', 'Local Process (stdio)'], ['remote', 'Remote Endpoint (HTTP/SSE)']]) {
		const o = document.createElement('option'); o.value = v; o.textContent = l; transSel.appendChild(o);
	}
	const cmdIn = document.createElement('input'); cmdIn.placeholder = 'npx';
	const argsIn = document.createElement('input'); argsIn.placeholder = '-y @modelcontextprotocol/server-filesystem .';
	const urlIn = document.createElement('input'); urlIn.placeholder = 'https://mcp.example.com/sse';

	const g1 = el('div', 'grid2');
	g1.appendChild(mkField('Server Name', nameIn));
	g1.appendChild(mkField('Transport', transSel));
	frag.appendChild(g1);

	const stdioWrap = el('div', 'grid2');
	stdioWrap.appendChild(mkField('Command', cmdIn));
	stdioWrap.appendChild(mkField('Arguments (space-separated)', argsIn));
	const remoteWrap = el('div');
	remoteWrap.appendChild(mkField('Server URL', urlIn));
	remoteWrap.style.display = 'none';

	transSel.addEventListener('change', () => {
		stdioWrap.style.display = transSel.value === 'stdio' ? 'grid' : 'none';
		remoteWrap.style.display = transSel.value === 'remote' ? 'block' : 'none';
	});
	frag.appendChild(stdioWrap);
	frag.appendChild(remoteWrap);

	const addBtn = el('button', '', '+ Add MCP Server');
	addBtn.addEventListener('click', () => vscode.postMessage({
		type: 'addServer',
		name: nameIn.value,
		transport: transSel.value,
		command: cmdIn.value,
		args: argsIn.value,
		url: urlIn.value,
	}));
	frag.appendChild(addBtn);

	root.replaceChildren(frag);
});
</script></body></html>`;
	}

	dispose(): void {
		this.panel?.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
