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
import { TAROT_GIT_HEAD_SCHEME, TarotGitHeadContentProvider, TarotGitReviewService } from './git/gitReviewService';
import { SpecCreationKind, TarotSpecService } from './specs/specService';
import { SpecTaskCodeLensProvider } from './specs/taskCodeLensProvider';
import { SteeringInclusion, TarotSteeringService } from './steering/steeringService';
import { TarotAgentPanelProvider } from './views/agentPanelView';
import { LocalAgentsTreeProvider, SpecsTreeProvider, SteeringTreeProvider, TarotWorkspaceFolderTreeProvider } from './views/tarotSidebarViews';

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
	const steeringService = new TarotSteeringService();
	const specService = new TarotSpecService();
	const gitReviewService = new TarotGitReviewService();
	const specCodeLensProvider = new SpecTaskCodeLensProvider();

	// Left Sidebar (Kiro-style) TreeViews
	const specsProvider = new SpecsTreeProvider(specService);
	const hooksProvider = new TarotWorkspaceFolderTreeProvider('.tarot/hooks', 'hooks');
	const steeringProvider = new SteeringTreeProvider(steeringService);
	const agentsProvider = new LocalAgentsTreeProvider(runtimeManager);

	// Right Secondary Side Bar (Kiro-style) Agent Panel
	const agentPanelProvider = new TarotAgentPanelProvider(
		context.extensionUri,
		runtimeManager,
		sessionStore,
		checkpointService,
		steeringService,
		specService,
		gitReviewService,
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
		specCodeLensProvider,
		vscode.workspace.registerTextDocumentContentProvider(TAROT_GIT_HEAD_SCHEME, new TarotGitHeadContentProvider()),
		vscode.languages.registerCodeLensProvider(
			{ language: 'markdown', pattern: '**/.tarot/specs/*/tasks.md' },
			specCodeLensProvider,
		),
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

		vscode.commands.registerCommand('tarot.agent.sendSelection', async () => {
			await agentPanelProvider.attachSelectionAndFocus();
		}),

		vscode.commands.registerCommand('tarot.agent.openInEditorTab', async () => {
			await agentPanelProvider.openInEditorTab();
		}),

		vscode.commands.registerCommand('tarot.agent.toggleFocusMode', async () => {
			await agentPanelProvider.toggleAgentFocusMode();
		}),

		vscode.commands.registerCommand('tarot.git.generateCommitMessage', async () => {
			const root = await ensureWorkspaceFolder();
			if (!root) {
				return;
			}
			await gitReviewService.generateAiCommitMessage(root, runtimeManager, outputChannel!);
		}),

		vscode.commands.registerCommand('tarot.specs.create', async () => {
			const root = await ensureWorkspaceFolder();
			if (!root) {
				return;
			}
			const kindPick = await vscode.window.showQuickPick(
				[
					{
						label: 'Feature (Requirements-First · EARS)',
						description: 'requirements.md → design.md → tasks.md',
						detail: 'Fluxo padrão Kiro: comece definindo requisitos em notação EARS (WHEN ... THE SYSTEM SHALL ...).',
						specKind: 'feature-requirements-first' as SpecCreationKind,
					},
					{
						label: 'Feature (Design-First · Arquitetura)',
						description: 'design.md → requirements.md → tasks.md',
						detail: 'Ideal quando a arquitetura técnica e interfaces são definidas primeiro.',
						specKind: 'feature-design-first' as SpecCreationKind,
					},
					{
						label: 'Bugfix (EARS · Regressão)',
						description: 'bugfix.md → design.md → tasks.md',
						detail: '3 blocos EARS obrigatórios: Current Behavior, Expected Behavior e Unchanged Behavior.',
						specKind: 'bugfix' as SpecCreationKind,
					},
				],
				{ title: 'Tarot IDE — Tipo de Spec (Kiro Workflow)' },
			);
			if (!kindPick) {
				return;
			}

			const rawName = await vscode.window.showInputBox({
				title: 'Tarot IDE — Nova Spec',
				prompt: kindPick.specKind === 'bugfix'
					? 'Slug do bugfix (ex.: fix-oauth-refresh-race)'
					: 'Slug da feature (ex.: auth-oauth, agent-hooks)',
				placeHolder: kindPick.specKind === 'bugfix' ? 'fix-meu-bug' : 'minha-feature',
			});
			if (!rawName) {
				return;
			}
			const slug = rawName.trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
			if (!slug) {
				return;
			}

			const { dirPath, entryFilePath } = await specService.createSpec(root, slug, kindPick.specKind);
			specsProvider.refresh();
			const doc = await vscode.workspace.openTextDocument(entryFilePath);
			await vscode.window.showTextDocument(doc);
			await agentPanelProvider.introduceSpecInPanel(dirPath, slug, kindPick.specKind);
		}),

		vscode.commands.registerCommand('tarot.specs.runTask', async (uri?: vscode.Uri, lineIndex?: number) => {
			if (!uri || typeof lineIndex !== 'number') {
				return;
			}
			const specDir = path.dirname(uri.fsPath);
			await agentPanelProvider.runSpecTask(specDir, lineIndex);
			specsProvider.refresh();
			specCodeLensProvider.refresh();
		}),

		vscode.commands.registerCommand('tarot.specs.runTaskWith', async (uri?: vscode.Uri, lineIndex?: number) => {
			if (!uri || typeof lineIndex !== 'number') {
				return;
			}
			const available = runtimeManager.getStatuses().filter(s => s.available);
			if (available.length === 0) {
				vscode.window.showWarningMessage('Nenhum CLI de agente local disponível (claude, agy, codex).');
				return;
			}
			const picked = await vscode.window.showQuickPick(
				available.map(s => ({
					label: s.displayName,
					description: s.version ?? s.binary,
					agentId: s.id,
				})),
				{ title: 'Tarot IDE — Escolher Agente para Executar Tarefa' },
			);
			if (!picked) {
				return;
			}
			const specDir = path.dirname(uri.fsPath);
			await agentPanelProvider.runSpecTask(specDir, lineIndex, picked.agentId);
			specsProvider.refresh();
			specCodeLensProvider.refresh();
		}),

		vscode.commands.registerCommand('tarot.steering.create', async () => {
			const scopePick = await vscode.window.showQuickPick(
				[
					{ label: 'Workspace (.tarot/steering/)', description: 'Regras versionadas neste repositório', scope: 'workspace' as const },
					{ label: 'Global (~/.tarot/steering/)', description: 'Regras pessoais aplicadas em todos os seus projetos', scope: 'global' as const },
				],
				{ title: 'Tarot IDE — Escopo do Steering' },
			);
			if (!scopePick) {
				return;
			}

			let targetDir: string;
			if (scopePick.scope === 'workspace') {
				const root = await ensureWorkspaceFolder();
				if (!root) {
					return;
				}
				targetDir = steeringService.getWorkspaceSteeringDir(root);
			} else {
				targetDir = steeringService.getGlobalSteeringDir();
			}

			const rawName = await vscode.window.showInputBox({
				title: 'Tarot IDE — Novo Steering',
				prompt: 'Nome do arquivo de regras (ex.: product, tech, structure, api-style)',
				placeHolder: 'tech',
			});
			if (!rawName) {
				return;
			}

			const inclusionPick = await vscode.window.showQuickPick(
				[
					{ label: 'always', description: 'Incluído em todos os turnos (padrão Kiro)', value: 'always' as SteeringInclusion },
					{ label: 'fileMatch', description: 'Incluído quando o editor ativo ou #File casar com um glob', value: 'fileMatch' as SteeringInclusion },
					{ label: 'auto', description: 'Incluído automaticamente quando relevante ao prompt', value: 'auto' as SteeringInclusion },
					{ label: 'manual', description: 'Incluído apenas quando citado como #nome ou via #Steering', value: 'manual' as SteeringInclusion },
				],
				{ title: 'Tarot IDE — Modo de Inclusão' },
			);
			if (!inclusionPick) {
				return;
			}

			let fileMatchPattern: string | undefined;
			if (inclusionPick.value === 'fileMatch') {
				fileMatchPattern = await vscode.window.showInputBox({
					title: 'Tarot IDE — Glob fileMatchPattern',
					prompt: 'Padrão glob (ex.: src/**/*.ts, *.tsx)',
					value: 'src/**/*.ts',
				});
				if (!fileMatchPattern) {
					return;
				}
			}

			const fileName = rawName.trim().endsWith('.md') ? rawName.trim() : `${rawName.trim()}.md`;
			const stem = fileName.replace(/\.md$/i, '');
			const frontmatterLines = [`inclusion: ${inclusionPick.value}`];
			if (fileMatchPattern) {
				frontmatterLines.push(`fileMatchPattern: "${fileMatchPattern.trim()}"`);
			}
			frontmatterLines.push(`description: "Regras de ${stem} para agentes locais"`);

			await fs.mkdir(targetDir, { recursive: true });
			const filePath = path.join(targetDir, fileName);
			await fs.writeFile(
				filePath,
				`---\n${frontmatterLines.join('\n')}\n---\n\n# Steering — ${stem}\n\nDescreva as convenções e regras que todos os agentes (claude, agy, codex) devem seguir.\n`,
				'utf8',
			);
			steeringProvider.refresh();
			const doc = await vscode.workspace.openTextDocument(filePath);
			await vscode.window.showTextDocument(doc);
		}),

		vscode.commands.registerCommand('tarot.steering.generate', async () => {
			const root = await ensureWorkspaceFolder();
			if (!root) {
				return;
			}
			await steeringService.ensureFoundationalTemplates(root);
			steeringProvider.refresh();

			const available = runtimeManager.getStatuses().filter(s => s.available);
			if (available.length === 0) {
				vscode.window.showInformationMessage(
					'Templates product.md, tech.md e structure.md criados em .tarot/steering/. Instale um CLI local (claude, agy ou codex) para preenchimento automático.'
				);
				return;
			}

			const confirm = await vscode.window.showInformationMessage(
				'Templates criados em .tarot/steering/ (product.md, tech.md, structure.md). Deseja que o agente ativo analise o workspace e preencha automaticamente?',
				'Preencher com Agente',
				'Editar Manualmente',
			);
			if (confirm === 'Preencher com Agente') {
				const prompt = steeringService.buildGenerateSteeringPrompt(root);
				await agentPanelProvider.runExternalPrompt(prompt, 'vibe');
			} else if (confirm === 'Editar Manualmente') {
				const doc = await vscode.workspace.openTextDocument(path.join(root, '.tarot', 'steering', 'product.md'));
				await vscode.window.showTextDocument(doc);
			}
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

	// Kiro-style Agent-First startup: reveal Tarot Agent in Secondary Side Bar by default
	const openOnStartup = vscode.workspace.getConfiguration('tarot.ui').get<boolean>('openAgentPanelOnStartup', true);
	if (openOnStartup) {
		setTimeout(() => {
			void vscode.commands.executeCommand(`${TarotAgentPanelProvider.viewId}.focus`);
		}, 400);
	}
}

export function deactivate(): void {
	outputChannel?.dispose();
	outputChannel = undefined;
}
