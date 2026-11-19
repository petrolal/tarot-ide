/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentRuntimeManager } from '../agents/runtimeManager';
import { TarotSessionStore } from '../agents/sessionStore';
import { AgentId, AgentMode, AttachedContext } from '../agents/types';
import { getTarotConfig } from '../config/tarotConfig';

interface WebviewIncomingMessage {
	readonly type: 'ready' | 'send' | 'cancel' | 'selectAgent' | 'setMode' | 'attachActiveFile' | 'removeAttachment' | 'newSession' | 'refreshAgents';
	readonly prompt?: string;
	readonly agentId?: AgentId;
	readonly mode?: AgentMode;
	readonly index?: number;
}

export class TarotAgentPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	static readonly viewId = 'tarot.views.agentPanel';

	private view: vscode.WebviewView | undefined;
	private mode: AgentMode = 'vibe';
	private attachments: AttachedContext[] = [];
	private activeCancellation: vscode.CancellationTokenSource | undefined;
	private isRunning = false;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly runtimeManager: AgentRuntimeManager,
		private readonly sessionStore: TarotSessionStore,
		private readonly outputChannel: vscode.OutputChannel,
	) {
		this.disposables.push(
			this.runtimeManager.onDidChangeAgents(() => this.postState()),
			this.runtimeManager.onDidChangeActiveAgent(() => this.postState()),
		);
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
		};
		webviewView.webview.html = this.buildHtml(webviewView.webview);

		const msgSub = webviewView.webview.onDidReceiveMessage((msg: WebviewIncomingMessage) => {
			void this.handleMessage(msg);
		});
		const disposeSub = webviewView.onDidDispose(() => {
			this.cancelActiveRun();
			this.view = undefined;
		});
		this.disposables.push(msgSub, disposeSub);
	}

	async setMode(mode: AgentMode): Promise<void> {
		this.mode = mode;
		this.postState();
	}

	private async handleMessage(msg: WebviewIncomingMessage): Promise<void> {
		switch (msg.type) {
			case 'ready':
				this.postState();
				break;
			case 'refreshAgents':
				await this.runtimeManager.refresh();
				break;
			case 'selectAgent':
				if (msg.agentId) {
					await this.runtimeManager.setActiveAgent(msg.agentId);
				}
				break;
			case 'setMode':
				if (msg.mode === 'vibe' || msg.mode === 'spec') {
					this.mode = msg.mode;
					this.postState();
				}
				break;
			case 'attachActiveFile':
				this.attachActiveEditor();
				break;
			case 'removeAttachment':
				if (typeof msg.index === 'number' && msg.index >= 0 && msg.index < this.attachments.length) {
					this.attachments.splice(msg.index, 1);
					this.postState();
				}
				break;
			case 'newSession':
				this.cancelActiveRun();
				this.attachments = [];
				this.sessionStore.resetSession(this.runtimeManager.getActiveAgentId(), this.mode);
				this.postState();
				break;
			case 'cancel':
				this.cancelActiveRun();
				break;
			case 'send':
				if (msg.prompt && msg.prompt.trim().length > 0) {
					await this.runPrompt(msg.prompt.trim());
				}
				break;
		}
	}

	private attachActiveEditor(): void {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showInformationMessage('Abra um arquivo no editor para anexá-lo ao contexto do agente.');
			return;
		}
		const fsPath = editor.document.uri.fsPath;
		const relPath = vscode.workspace.asRelativePath(editor.document.uri, false);
		const selectionText = editor.selection.isEmpty ? undefined : editor.document.getText(editor.selection);

		const exists = this.attachments.some(a => a.path === fsPath && a.selection === selectionText);
		if (!exists) {
			this.attachments.push({
				label: selectionText ? `${relPath} (seleção)` : relPath,
				path: fsPath,
				selection: selectionText,
			});
			this.postState();
		}
	}

	private cancelActiveRun(): void {
		if (this.activeCancellation) {
			this.activeCancellation.cancel();
			this.activeCancellation.dispose();
			this.activeCancellation = undefined;
		}
	}

	private async loadAlwaysSteeringContext(cwd: string): Promise<string | undefined> {
		const steeringDir = path.join(cwd, '.tarot', 'steering');
		try {
			const entries = await fs.readdir(steeringDir, { withFileTypes: true });
			const mdFiles = entries.filter(e => e.isFile() && e.name.endsWith('.md')).sort((a, b) => a.name.localeCompare(b.name));
			const blocks: string[] = [];
			for (const f of mdFiles) {
				const raw = await fs.readFile(path.join(steeringDir, f.name), 'utf8');
				if (/^---[\s\S]*?inclusion:\s*(?:manual|fileMatch)/m.test(raw)) {
					continue;
				}
				blocks.push(`### ${f.name}\n${raw.trim()}`);
			}
			return blocks.length > 0 ? blocks.join('\n\n') : undefined;
		} catch {
			return undefined;
		}
	}

	private async runPrompt(prompt: string): Promise<void> {
		if (this.isRunning) {
			return;
		}

		const agentId = this.runtimeManager.getActiveAgentId();
		const adapter = this.runtimeManager.getAdapter(agentId);
		if (!adapter) {
			this.postMessage({ type: 'error', content: `Nenhum adaptador encontrado para '${agentId}'.` });
			return;
		}

		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
		const session = this.sessionStore.getOrCreateSession(agentId, this.mode);
		session.activeAgentId = agentId;
		session.mode = this.mode;

		const historySnapshot = [...session.messages];
		const requestAttachments = [...this.attachments];
		this.attachments = [];

		await this.sessionStore.appendMessage(session, {
			role: 'user',
			mode: this.mode,
			content: prompt,
			attachments: requestAttachments,
		});

		this.isRunning = true;
		this.activeCancellation = new vscode.CancellationTokenSource();
		this.postState();
		this.postMessage({ type: 'streamStart', agentId, agentName: adapter.displayName });

		const steeringContext = await this.loadAlwaysSteeringContext(cwd);
		let accumulatedText = '';
		const usedTools: string[] = [];

		this.outputChannel.appendLine(`[AgentPanel] Running ${adapter.id} (${this.mode}) in ${cwd}`);

		try {
			await adapter.run(
				{
					prompt,
					mode: this.mode,
					cwd,
					systemContext: steeringContext,
					attachments: requestAttachments,
					conversationHistory: historySnapshot,
					timeoutMs: getTarotConfig().timeoutMs,
				},
				event => {
					if (event.type === 'text' && event.content) {
						accumulatedText += event.content;
						this.postMessage({ type: 'streamChunk', content: event.content });
					} else if (event.type === 'tool_start' && event.toolName) {
						usedTools.push(event.toolName);
						this.postMessage({ type: 'streamTool', toolName: event.toolName });
					} else if (event.type === 'status' && event.content) {
						this.postMessage({ type: 'streamStatus', content: event.content });
					} else if (event.type === 'error' && event.content) {
						accumulatedText += (accumulatedText ? '\n\n' : '') + `[Erro] ${event.content}`;
						this.postMessage({ type: 'streamError', content: event.content });
					}
				},
				this.activeCancellation.token,
			);
		} finally {
			this.isRunning = false;
			if (this.activeCancellation) {
				this.activeCancellation.dispose();
				this.activeCancellation = undefined;
			}

			if (accumulatedText.trim().length > 0) {
				await this.sessionStore.appendMessage(session, {
					role: 'assistant',
					agentId,
					mode: this.mode,
					content: accumulatedText,
					tools: usedTools.length > 0 ? usedTools : undefined,
				});
			}

			this.postMessage({ type: 'streamEnd' });
			this.postState();
		}
	}

	private postState(): void {
		const activeAgentId = this.runtimeManager.getActiveAgentId();
		const session = this.sessionStore.getOrCreateSession(activeAgentId, this.mode);
		this.postMessage({
			type: 'state',
			agents: this.runtimeManager.getStatuses(),
			activeAgentId,
			mode: this.mode,
			isRunning: this.isRunning,
			attachments: this.attachments,
			messages: session.messages,
		});
	}

	private postMessage(payload: Record<string, unknown>): void {
		if (this.view) {
			void this.view.webview.postMessage(payload);
		}
	}

	private buildHtml(webview: vscode.Webview): string {
		const nonce = crypto.randomBytes(16).toString('base64');
		const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview', 'panel.css'));
		const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview', 'panel.js'));

		return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource};" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link rel="stylesheet" href="${cssUri}" />
	<title>Tarot Agent</title>
</head>
<body>
	<div class="tarot-shell">
		<header class="tarot-header">
			<div class="tarot-brand">
				<span class="tarot-sigil">✦</span>
				<span class="tarot-title">Tarot Agent</span>
			</div>
			<div class="tarot-header-actions">
				<button id="btn-new-session" class="icon-btn" title="Nova Sessão">+</button>
				<button id="btn-refresh-agents" class="icon-btn" title="Atualizar Agentes Locais">↻</button>
			</div>
		</header>

		<div class="tarot-toolbar">
			<div class="mode-switch" role="tablist" aria-label="Modo de Execução">
				<button id="mode-vibe" class="mode-btn active" data-mode="vibe">Vibe</button>
				<button id="mode-spec" class="mode-btn" data-mode="spec">Spec</button>
			</div>
			<select id="agent-select" class="agent-select" aria-label="Agente Local"></select>
		</div>

		<main id="messages" class="tarot-messages" aria-live="polite"></main>

		<footer class="tarot-composer">
			<div id="attachments" class="attachments-bar"></div>
			<div class="composer-actions">
				<button id="btn-attach" class="chip-btn" type="button">+ Arquivo Ativo</button>
				<span id="status-indicator" class="status-text"></span>
			</div>
			<div class="input-row">
				<textarea id="prompt-input" rows="3" placeholder="Descreva a tarefa para seu agente local... (Ctrl+Enter para enviar)"></textarea>
				<button id="btn-send" class="send-btn" type="button">Enviar</button>
			</div>
		</footer>
	</div>
	<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
	}

	dispose(): void {
		this.cancelActiveRun();
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
