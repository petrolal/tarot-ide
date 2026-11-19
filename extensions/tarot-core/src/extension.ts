/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentRuntimeManager } from './agents/runtimeManager';
import { TarotSessionStore } from './agents/sessionStore';
import { AgentId } from './agents/types';
import { TarotCheckpointService } from './checkpoints/checkpointService';
import { TarotAgentPanelProvider } from './views/agentPanelView';
import { LocalAgentsTreeProvider, TarotWorkspaceFolderTreeProvider } from './views/tarotSidebarViews';

let outputChannel: vscode.OutputChannel | undefined;

async function ensureWorkspaceFolder(): Promise<string | undefined> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) {
		vscode.window.showWarningMessage('Abra uma pasta/workspace no Tarot IDE para criar artefatos em .tarot/.');
	}
	return root;
}

export function activate(context: vscode.ExtensionContext): void {
	outputChannel = vscode.window.createOutputChannel('Tarot IDE');
	outputChannel.appendLine('Tarot Core extension activated.');

	const runtimeManager = new AgentRuntimeManager(context, outputChannel);
	const sessionStore = new TarotSessionStore();
	const checkpointService = new TarotCheckpointService();

	// Left Sidebar (Kiro-style) TreeViews
	const specsProvider = new TarotWorkspaceFolderTreeProvider('.tarot/specs', 'specs');
	const hooksProvider = new TarotWorkspaceFolderTreeProvider('.tarot/hooks', 'hooks');
	const steeringProvider = new TarotWorkspaceFolderTreeProvider('.tarot/steering', 'steering');
	const agentsProvider = new LocalAgentsTreeProvider(runtimeManager);

	// Right Secondary Side Bar (Kiro-style) Agent Panel
	const agentPanelProvider = new TarotAgentPanelProvider(
		context.extensionUri,
		runtimeManager,
		sessionStore,
		checkpointService,
		outputChannel,
	);

	context.subscriptions.push(
		outputChannel,
		runtimeManager,
		specsProvider,
		hooksProvider,
		steeringProvider,
		agentsProvider,
		agentPanelProvider,
		vscode.window.registerTreeDataProvider('tarot.views.specs', specsProvider),
		vscode.window.registerTreeDataProvider('tarot.views.hooks', hooksProvider),
		vscode.window.registerTreeDataProvider('tarot.views.steering', steeringProvider),
		vscode.window.registerTreeDataProvider('tarot.views.agents', agentsProvider),
		vscode.window.registerWebviewViewProvider(TarotAgentPanelProvider.viewId, agentPanelProvider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),

		vscode.commands.registerCommand('tarot.welcome', () => {
			const available = runtimeManager.getStatuses().filter(s => s.available).map(s => s.id);
			const agentsText = available.length > 0 ? `Agentes detectados: ${available.join(', ')}.` : 'Nenhum CLI de agente detectado no PATH.';
			vscode.window.showInformationMessage(`Bem-vindo ao Tarot IDE! ${agentsText}`);
		}),

		vscode.commands.registerCommand('tarot.agents.refresh', async () => {
			await runtimeManager.refresh();
		}),

		vscode.commands.registerCommand('tarot.agents.select', async () => {
			await runtimeManager.showAgentQuickPick();
		}),

		vscode.commands.registerCommand('tarot.agents.selectById', async (agentId?: AgentId) => {
			if (!agentId) {
				await runtimeManager.showAgentQuickPick();
				return;
			}
			const status = runtimeManager.getStatuses().find(s => s.id === agentId);
			if (status && !status.available) {
				vscode.window.showWarningMessage(`${status.displayName} não está instalado. ${status.installHint ?? ''}`);
				return;
			}
			await runtimeManager.setActiveAgent(agentId);
		}),

		vscode.commands.registerCommand('tarot.agentPanel.open', async () => {
			await vscode.commands.executeCommand(`${TarotAgentPanelProvider.viewId}.focus`);
		}),

		vscode.commands.registerCommand('tarot.specs.create', async () => {
			const root = await ensureWorkspaceFolder();
			if (!root) {
				return;
			}
			const rawName = await vscode.window.showInputBox({
				title: 'Tarot IDE — Nova Spec',
				prompt: 'Nome da feature (ex.: auth-oauth, agent-hooks)',
				placeHolder: 'minha-feature',
			});
			if (!rawName) {
				return;
			}
			const slug = rawName.trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
			if (!slug) {
				return;
			}
			const specDir = path.join(root, '.tarot', 'specs', slug);
			await fs.mkdir(specDir, { recursive: true });
			const reqPath = path.join(specDir, 'requirements.md');
			const designPath = path.join(specDir, 'design.md');
			const tasksPath = path.join(specDir, 'tasks.md');

			await fs.writeFile(reqPath, `# Requirements — ${slug}\n\n## User Stories\n- Como usuário, eu quero ...\n\n## Acceptance Criteria\n- [ ] Critério 1\n`, 'utf8');
			await fs.writeFile(designPath, `# Design — ${slug}\n\n## Architecture\n\n## Components & Interfaces\n`, 'utf8');
			await fs.writeFile(tasksPath, `# Tasks — ${slug}\n\n- [ ] 1. Definir contratos e estrutura base\n- [ ] 2. Implementar lógica principal\n- [ ] 3. Validar com testes\n`, 'utf8');

			specsProvider.refresh();
			const doc = await vscode.workspace.openTextDocument(reqPath);
			await vscode.window.showTextDocument(doc);
			await agentPanelProvider.setMode('spec');
		}),

		vscode.commands.registerCommand('tarot.steering.create', async () => {
			const root = await ensureWorkspaceFolder();
			if (!root) {
				return;
			}
			const rawName = await vscode.window.showInputBox({
				title: 'Tarot IDE — Novo Steering',
				prompt: 'Nome do arquivo de regras (ex.: product, tech, style)',
				placeHolder: 'tech',
			});
			if (!rawName) {
				return;
			}
			const fileName = rawName.trim().endsWith('.md') ? rawName.trim() : `${rawName.trim()}.md`;
			const dir = path.join(root, '.tarot', 'steering');
			await fs.mkdir(dir, { recursive: true });
			const filePath = path.join(dir, fileName);
			await fs.writeFile(filePath, `---\ninclusion: always\n---\n\n# Steering — ${fileName.replace(/\.md$/, '')}\n\nDescreva as convenções e regras que todos os agentes (claude, agy, codex) devem seguir neste projeto.\n`, 'utf8');
			steeringProvider.refresh();
			const doc = await vscode.workspace.openTextDocument(filePath);
			await vscode.window.showTextDocument(doc);
		}),

		vscode.commands.registerCommand('tarot.hooks.create', async () => {
			const root = await ensureWorkspaceFolder();
			if (!root) {
				return;
			}
			const rawName = await vscode.window.showInputBox({
				title: 'Tarot IDE — Novo Agent Hook',
				prompt: 'Identificador do hook (ex.: update-tests-on-save)',
				placeHolder: 'update-tests-on-save',
			});
			if (!rawName) {
				return;
			}
			const id = rawName.trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-');
			const dir = path.join(root, '.tarot', 'hooks');
			await fs.mkdir(dir, { recursive: true });
			const filePath = path.join(dir, `${id}.json`);
			const template = {
				id,
				name: id,
				enabled: true,
				trigger: 'onSave',
				glob: 'src/**/*.ts',
				agent: 'default',
				prompt: 'Verifique se o arquivo alterado {{file}} precisa de ajustes ou atualização de testes.',
			};
			await fs.writeFile(filePath, JSON.stringify(template, null, 2) + '\n', 'utf8');
			hooksProvider.refresh();
			const doc = await vscode.workspace.openTextDocument(filePath);
			await vscode.window.showTextDocument(doc);
		}),
	);

	// Initial background detection of local AI CLIs (claude, agy, codex, custom)
	void runtimeManager.refresh();
}

export function deactivate(): void {
	outputChannel?.dispose();
	outputChannel = undefined;
}
