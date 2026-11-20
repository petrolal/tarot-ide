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
		vscode.window.showWarningMessage(vscode.l10n.t('Open a folder/workspace in Tarot IDE to create artifacts under .tarot/.'));
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
	const specsProvider = new SpecsTreeProvider(specService, context.extensionUri);
	const hooksProvider = new TarotWorkspaceFolderTreeProvider('.tarot/hooks', 'hooks', context.extensionUri);
	const steeringProvider = new SteeringTreeProvider(steeringService, context.extensionUri);
	const agentsProvider = new LocalAgentsTreeProvider(runtimeManager, context.extensionUri);

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
			const agentsText = available.length > 0
				? vscode.l10n.t('Agents detected: {0}.', available.join(', '))
				: vscode.l10n.t('No agent CLI detected on PATH.');
			vscode.window.showInformationMessage(vscode.l10n.t('Welcome to Tarot IDE! {0}', agentsText));
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
				vscode.window.showWarningMessage(vscode.l10n.t('{0} is not installed. {1}', status.displayName, status.installHint ?? ''));
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
						label: vscode.l10n.t('Feature (Requirements-First · EARS)'),
						description: vscode.l10n.t('requirements.md → design.md → tasks.md'),
						detail: vscode.l10n.t('Default Kiro workflow: start by defining requirements in EARS notation (WHEN ... THE SYSTEM SHALL ...).'),
						specKind: 'feature-requirements-first' as SpecCreationKind,
					},
					{
						label: vscode.l10n.t('Feature (Design-First · Architecture)'),
						description: vscode.l10n.t('design.md → requirements.md → tasks.md'),
						detail: vscode.l10n.t('Best when the technical architecture and interfaces are defined first.'),
						specKind: 'feature-design-first' as SpecCreationKind,
					},
					{
						label: vscode.l10n.t('Bugfix (EARS · Regression)'),
						description: vscode.l10n.t('bugfix.md → design.md → tasks.md'),
						detail: vscode.l10n.t('Three mandatory EARS blocks: Current Behavior, Expected Behavior and Unchanged Behavior.'),
						specKind: 'bugfix' as SpecCreationKind,
					},
				],
				{ title: vscode.l10n.t('Tarot IDE — Spec Type (Kiro Workflow)') },
			);
			if (!kindPick) {
				return;
			}

			const rawName = await vscode.window.showInputBox({
				title: vscode.l10n.t('Tarot IDE — New Spec'),
				prompt: kindPick.specKind === 'bugfix'
					? vscode.l10n.t('Bugfix slug (e.g. fix-oauth-refresh-race)')
					: vscode.l10n.t('Feature slug (e.g. auth-oauth, agent-hooks)'),
				placeHolder: kindPick.specKind === 'bugfix' ? 'fix-my-bug' : 'my-feature',
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
				vscode.window.showWarningMessage(vscode.l10n.t('No local agent CLI available (claude, agy, codex).'));
				return;
			}
			const picked = await vscode.window.showQuickPick(
				available.map(s => ({
					label: s.displayName,
					description: s.version ?? s.binary,
					agentId: s.id,
				})),
				{ title: vscode.l10n.t('Tarot IDE — Pick Agent to Run Task') },
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
					{ label: vscode.l10n.t('Workspace (.tarot/steering/)'), description: vscode.l10n.t('Rules versioned in this repository'), scope: 'workspace' as const },
					{ label: vscode.l10n.t('Global (~/.tarot/steering/)'), description: vscode.l10n.t('Personal rules applied to every project'), scope: 'global' as const },
				],
				{ title: vscode.l10n.t('Tarot IDE — Steering Scope') },
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
				title: vscode.l10n.t('Tarot IDE — New Steering'),
				prompt: vscode.l10n.t('Rules file name (e.g. product, tech, structure, api-style)'),
				placeHolder: 'tech',
			});
			if (!rawName) {
				return;
			}

			const inclusionPick = await vscode.window.showQuickPick(
				[
					{ label: 'always', description: vscode.l10n.t('Included in every turn (Kiro default)'), value: 'always' as SteeringInclusion },
					{ label: 'fileMatch', description: vscode.l10n.t('Included when the active editor or #File matches a glob'), value: 'fileMatch' as SteeringInclusion },
					{ label: 'auto', description: vscode.l10n.t('Included automatically when relevant to the prompt'), value: 'auto' as SteeringInclusion },
					{ label: 'manual', description: vscode.l10n.t('Included only when referenced as #name or through #Steering'), value: 'manual' as SteeringInclusion },
				],
				{ title: vscode.l10n.t('Tarot IDE — Inclusion Mode') },
			);
			if (!inclusionPick) {
				return;
			}

			let fileMatchPattern: string | undefined;
			if (inclusionPick.value === 'fileMatch') {
				fileMatchPattern = await vscode.window.showInputBox({
					title: vscode.l10n.t('Tarot IDE — fileMatchPattern Glob'),
					prompt: vscode.l10n.t('Glob pattern (e.g. src/**/*.ts, *.tsx)'),
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
					vscode.l10n.t('Templates product.md, tech.md and structure.md created in .tarot/steering/. Install a local CLI (claude, agy or codex) for automatic filling.')
				);
				return;
			}

			const fillWithAgent = vscode.l10n.t('Fill With Agent');
			const editManually = vscode.l10n.t('Edit Manually');
			const confirm = await vscode.window.showInformationMessage(
				vscode.l10n.t('Templates created in .tarot/steering/ (product.md, tech.md, structure.md). Do you want the active agent to analyze the workspace and fill them in?'),
				fillWithAgent,
				editManually,
			);
			if (confirm === fillWithAgent) {
				const prompt = steeringService.buildGenerateSteeringPrompt(root);
				await agentPanelProvider.runExternalPrompt(prompt, 'vibe');
			} else if (confirm === editManually) {
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
				title: vscode.l10n.t('Tarot IDE — New Agent Hook'),
				prompt: vscode.l10n.t('Hook identifier (e.g. update-tests-on-save)'),
				placeHolder: 'update-tests-on-save',
			});
			if (!rawName) {
				return;
			}
			const id = rawName.trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-');
			const dir = path.join(root, '.tarot', 'hooks');
			await fs.mkdir(dir, { recursive: true });
			const filePath = path.join(dir, `${id}.json`);
			// Hook schema `v1`: several hooks per file, `matcher` is a regex on the file path and
			// the action is either a `command` or an `agent` loop. Authored prompts stay PT-BR.
			const template = {
				version: 'v1',
				hooks: [
					{
						name: id,
						description: 'Revisa o arquivo salvo e ajusta ou cria testes quando necessário.',
						enabled: true,
						trigger: 'PostFileSave',
						matcher: '\\.(ts|tsx)$',
						timeout: 60,
						action: {
							type: 'agent',
							prompt: 'Verifique se o arquivo alterado {{file}} precisa de ajustes ou atualização de testes.',
						},
					},
				],
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
