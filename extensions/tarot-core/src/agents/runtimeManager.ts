/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getTarotConfig } from '../config/tarotConfig';
import { AgyAdapter } from './adapters/agyAdapter';
import { ClaudeCodeAdapter } from './adapters/claudeAdapter';
import { CodexAdapter } from './adapters/codexAdapter';
import { CustomCliAdapter } from './adapters/customAdapter';
import { AgentAdapter, AgentId, AgentModelOption, AgentStatus } from './types';

const ACTIVE_AGENT_STATE_KEY = 'tarot.activeAgentId';

export class AgentRuntimeManager implements vscode.Disposable {
	private readonly _onDidChangeAgents = new vscode.EventEmitter<readonly AgentStatus[]>();
	readonly onDidChangeAgents = this._onDidChangeAgents.event;

	private readonly _onDidChangeActiveAgent = new vscode.EventEmitter<AgentId>();
	readonly onDidChangeActiveAgent = this._onDidChangeActiveAgent.event;

	private readonly adapters = new Map<AgentId, AgentAdapter>();
	private readonly modelCache = new Map<AgentId, readonly AgentModelOption[]>();
	private statuses: AgentStatus[] = [];
	private activeAgentId: AgentId = 'claude';
	private readonly statusBarItem: vscode.StatusBarItem;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly outputChannel: vscode.OutputChannel,
	) {
		this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this.statusBarItem.command = 'tarot.agents.select';
		this.statusBarItem.tooltip = vscode.l10n.t('Tarot IDE — Select the active local agent (claude / codex / agy)');
		this.statusBarItem.show();

		this.disposables.push(
			this._onDidChangeAgents,
			this._onDidChangeActiveAgent,
			this.statusBarItem,
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('tarot.agents')) {
					void this.refresh();
				}
			}),
		);

		this.rebuildAdapters();
	}

	private rebuildAdapters(): void {
		this.adapters.clear();
		const builtIns: AgentAdapter[] = [
			new ClaudeCodeAdapter(() => getTarotConfig().agentPaths.claude),
			new AgyAdapter(() => getTarotConfig().agentPaths.agy),
			new CodexAdapter(() => getTarotConfig().agentPaths.codex),
		];
		for (const adapter of builtIns) {
			this.adapters.set(adapter.id, adapter);
		}
		for (const custom of getTarotConfig().customAgents) {
			if (!this.adapters.has(custom.id)) {
				this.adapters.set(custom.id, new CustomCliAdapter(custom));
			}
		}
	}

	async refresh(): Promise<readonly AgentStatus[]> {
		this.modelCache.clear();
		this.rebuildAdapters();
		const detected = await Promise.all(Array.from(this.adapters.values()).map(a => a.detect()));
		this.statuses = detected;

		const saved = this.context.globalState.get<AgentId>(ACTIVE_AGENT_STATE_KEY);
		const configuredDefault = getTarotConfig().defaultAgent;

		const pickPreferred = (): AgentId => {
			if (saved && this.statuses.some(s => s.id === saved && s.available)) {
				return saved;
			}
			if (configuredDefault !== 'auto' && this.statuses.some(s => s.id === configuredDefault && s.available)) {
				return configuredDefault;
			}
			const firstAvailable = this.statuses.find(s => s.available);
			return firstAvailable?.id ?? this.statuses[0]?.id ?? 'claude';
		};

		this.activeAgentId = pickPreferred();
		this.updateStatusBar();

		const summary = this.statuses
			.map(s => `${s.id}: ${s.available ? `${s.version ?? 'ok'} (${s.resolvedPath})` : 'not installed'}`)
			.join(' | ');
		this.outputChannel.appendLine(`[Agents] ${summary}`);

		this._onDidChangeAgents.fire(this.statuses);
		this._onDidChangeActiveAgent.fire(this.activeAgentId);
		return this.statuses;
	}

	getStatuses(): readonly AgentStatus[] {
		return this.statuses;
	}

	getActiveAgentId(): AgentId {
		return this.activeAgentId;
	}

	getAdapter(id: AgentId = this.activeAgentId): AgentAdapter | undefined {
		return this.adapters.get(id);
	}

	async listModelsForAgent(id: AgentId = this.activeAgentId): Promise<readonly AgentModelOption[]> {
		const cached = this.modelCache.get(id);
		if (cached) {
			return cached;
		}
		const adapter = this.adapters.get(id);
		if (!adapter?.listModels) {
			return [];
		}
		const models = await adapter.listModels();
		this.modelCache.set(id, models);
		return models;
	}

	async setActiveAgent(id: AgentId): Promise<void> {
		if (!this.adapters.has(id)) {
			return;
		}
		this.activeAgentId = id;
		await this.context.globalState.update(ACTIVE_AGENT_STATE_KEY, id);
		this.updateStatusBar();
		this._onDidChangeActiveAgent.fire(id);
	}

	async showAgentQuickPick(): Promise<void> {
		if (this.statuses.length === 0) {
			await this.refresh();
		}
		const items = this.statuses.map(s => ({
			label: `${s.available ? '$(check)' : '$(circle-slash)'} ${s.displayName}`,
			description: s.available ? (s.version ?? vscode.l10n.t('Available')) : vscode.l10n.t('Not installed'),
			detail: s.available ? s.resolvedPath : (s.installHint ?? s.error),
			agentId: s.id,
			available: s.available,
		}));

		const picked = await vscode.window.showQuickPick(items, {
			title: vscode.l10n.t('Tarot IDE — Select Local Agent'),
			placeHolder: vscode.l10n.t('Pick the AI engine installed on your machine'),
		});

		if (!picked) {
			return;
		}

		if (!picked.available) {
			const status = this.statuses.find(s => s.id === picked.agentId);
			vscode.window.showWarningMessage(
				vscode.l10n.t('{0} was not found on PATH. {1}', status?.displayName ?? picked.agentId, status?.installHint ?? ''),
			);
			return;
		}

		await this.setActiveAgent(picked.agentId);
	}

	private updateStatusBar(): void {
		const current = this.statuses.find(s => s.id === this.activeAgentId);
		if (current?.available) {
			this.statusBarItem.text = `Tarot · ${current.id}`;
			this.statusBarItem.backgroundColor = undefined;
		} else {
			this.statusBarItem.text = `$(warning) Tarot: ${vscode.l10n.t('no agent')}`;
			this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		}
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
