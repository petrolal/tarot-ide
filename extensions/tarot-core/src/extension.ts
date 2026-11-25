/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { TarotCustomAgentService } from './agents/customAgentService';
import { AgentRuntimeManager } from './agents/runtimeManager';
import { TarotSessionStore } from './agents/sessionStore';
import { AgentId } from './agents/types';
import { TarotCheckpointService } from './checkpoints/checkpointService';
import { registerSpecCommands } from './commands/specCommands';
import { registerWorkflowCommands } from './commands/workflowCommands';
import { TAROT_GIT_HEAD_SCHEME, TarotGitHeadContentProvider, TarotGitReviewService } from './git/gitReviewService';
import { TarotWorktreeManager } from './git/worktreeManager';
import { KeyedHookQueue, runHooksForTrigger, TarotHookEngine } from './hooks/hookEngine';
import { TarotMcpConfigService } from './mcp/mcpConfigService';
import { TarotPermissionsService } from './permissions/permissionsService';
import { TarotTrustService } from './permissions/trustService';
import { TarotPowersService } from './powers/powersService';
import { TarotSkillsService } from './skills/skillsService';
import { TarotSpecService } from './specs/specService';
import { SpecTaskCodeLensProvider } from './specs/taskCodeLensProvider';
import { SteeringInclusion, TarotSteeringService } from './steering/steeringService';
import { TarotAgentPanelProvider } from './views/agentPanelView';
import { TarotFocusModeManager } from './views/focusModeView';
import { RecipesTreeProvider } from './views/recipesView';
import { SessionsTreeProvider } from './views/sessionsView';
import { HooksTreeProvider, LocalAgentsTreeProvider, McpServersTreeProvider, SpecsTreeProvider, SteeringTreeProvider } from './views/tarotSidebarViews';
import { WorkflowRunsTreeProvider } from './views/workflowRunsView';
import { TarotRecipeLoader } from './workflows/recipeLoader';
import { TarotWorkflowRunStore } from './workflows/runStore';
import { TarotWorkflowEngine } from './workflows/workflowEngine';

let outputChannel: vscode.OutputChannel | undefined;

async function ensureWorkspaceFolder(): Promise<string | undefined> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) {
		vscode.window.showWarningMessage(vscode.l10n.t('Open a folder/workspace in Tarot IDE to create artifacts under .tarot/.'));
	}
	return root;
}

class TarotEmptyContentProvider implements vscode.TextDocumentContentProvider {
	provideTextDocumentContent(): string {
		return '';
	}
}

export function activate(context: vscode.ExtensionContext): void {
	outputChannel = vscode.window.createOutputChannel('Tarot IDE');
	outputChannel.appendLine('Tarot Core extension activated.');

	const trustService = new TarotTrustService();
	const permissionsService = new TarotPermissionsService(trustService, outputChannel);
	const mcpConfigService = new TarotMcpConfigService();

	const runtimeManager = new AgentRuntimeManager(context, outputChannel, {
		evaluatePermission: async (toolName, params) => {
			const lower = toolName.toLowerCase();
			if (lower.includes('bash') || lower.includes('shell') || lower.includes('exec') || lower.includes('terminal')) {
				const rawCmd = typeof params?.command === 'string' ? params.command : toolName;
				const evalRes = await permissionsService.evaluateShellCommand(rawCmd, { headless: true });
				return evalRes.decision.effect === 'evaluate' ? 'ask' : evalRes.decision.effect;
			}
			const cap = (lower.includes('write') || lower.includes('edit') || lower.includes('delete'))
				? 'fs_write'
				: (lower.includes('read') ? 'fs_read' : (lower.includes('mcp') ? 'mcp' : 'shell'));
			const decision = await permissionsService.evaluate(cap, toolName, { headless: true });
			return decision.effect === 'evaluate' ? 'ask' : decision.effect;
		},
		getMcpServers: async cwd => {
			if (!vscode.workspace.isTrusted) {
				return [];
			}
			const { servers } = await mcpConfigService.discover(cwd);
			return servers
				.filter(s => s.enabled && s.transport === 'stdio' && s.command)
				.map(s => ({
					name: s.name,
					command: s.command,
					args: s.args ?? [],
					env: Object.entries(s.env ?? {}).map(([name, value]) => ({ name, value })),
				}));
		},
	});
	const sessionStore = new TarotSessionStore();
	const checkpointService = new TarotCheckpointService();
	const steeringService = new TarotSteeringService();
	const specService = new TarotSpecService();
	const gitReviewService = new TarotGitReviewService();
	const worktreeManager = new TarotWorktreeManager();
	const skillsService = new TarotSkillsService();
	const customAgentService = new TarotCustomAgentService();
	const powersService = new TarotPowersService(skillsService);
	const recipeLoader = new TarotRecipeLoader(path.join(context.extensionUri.fsPath, 'recipes'));
	const workflowRunStore = new TarotWorkflowRunStore();
	const workflowEngine = new TarotWorkflowEngine(workflowRunStore);
	const hookEngine = new TarotHookEngine((filePath, errors) => {
		for (const err of errors) {
			outputChannel!.appendLine(`[Hooks] ${filePath}: ${err}`);
		}
		const openLabel = vscode.l10n.t('Open File');
		void vscode.window.showWarningMessage(
			vscode.l10n.t('{0} error(s) loading hooks from {1} — see the Tarot IDE output channel for details.', errors.length, path.basename(filePath)),
			openLabel,
		).then(choice => {
			if (choice === openLabel) {
				void vscode.workspace.openTextDocument(filePath).then(doc => vscode.window.showTextDocument(doc));
			}
		});
	});
	const fileHookQueue = new KeyedHookQueue(250);
	const specCodeLensProvider = new SpecTaskCodeLensProvider();

	// Left Sidebar (Kiro-style) TreeViews
	const specsProvider = new SpecsTreeProvider(specService, context.extensionUri);
	const hooksProvider = new HooksTreeProvider(hookEngine, context.extensionUri);
	const steeringProvider = new SteeringTreeProvider(steeringService, context.extensionUri);
	const agentsProvider = new LocalAgentsTreeProvider(runtimeManager, context.extensionUri);
	const mcpProvider = new McpServersTreeProvider(mcpConfigService, context.extensionUri);
	const workflowRunsProvider = new WorkflowRunsTreeProvider(workflowRunStore, context.extensionUri);
	const recipesProvider = new RecipesTreeProvider(recipeLoader, context.extensionUri);

	// Right Secondary Side Bar (Kiro-style) Agent Panel
	const agentPanelProvider = new TarotAgentPanelProvider(
		context,
		context.extensionUri,
		runtimeManager,
		sessionStore,
		checkpointService,
		steeringService,
		specService,
		gitReviewService,
		hookEngine,
		permissionsService,
		worktreeManager,
		skillsService,
		customAgentService,
		powersService,
		mcpConfigService,
		outputChannel,
	);

	const sessionsProvider = new SessionsTreeProvider(
		sessionStore,
		context.extensionUri,
		() => agentPanelProvider.getRunningSessionId(),
	);

	const focusModeManager = new TarotFocusModeManager(
		context.extensionUri,
		sessionStore,
		runtimeManager,
		sessionsProvider,
		worktreeManager,
		specService,
		gitReviewService,
		workflowRunStore,
		{
			sendPrompt: async prompt => { await agentPanelProvider.runExternalPrompt(prompt); },
			cancelRun: () => agentPanelProvider.cancelActiveRun(),
			newSession: mode => agentPanelProvider.createNewSession(mode),
			selectSession: async sessionId => { await agentPanelProvider.openSessionById(sessionId); },
			selectAgent: async agentId => { await runtimeManager.setActiveAgent(agentId); },
			setMode: async mode => { await agentPanelProvider.setMode(mode); },
			setAutonomy: autonomy => agentPanelProvider.setAutonomy(autonomy),
			pickContext: async () => { await agentPanelProvider.pickContextFromUi(); },
			openFileDiff: async relativePath => { await agentPanelProvider.openChangedFileDiff(relativePath); },
			getRunningSessionId: () => agentPanelProvider.getRunningSessionId(),
			getActiveMode: () => agentPanelProvider.getMode(),
			getActiveAutonomy: () => agentPanelProvider.getAutonomy(),
		},
	);

	agentPanelProvider.setFocusModeHooks(
		() => focusModeManager.toggle(),
		() => {
			sessionsProvider.refresh();
			void focusModeManager.postState();
		},
	);

	const workflowCommands = registerWorkflowCommands({
		extensionUri: context.extensionUri,
		runtimeManager,
		checkpointService,
		permissionsService,
		recipeLoader,
		workflowRunStore,
		workflowEngine,
		workflowRunsProvider,
		getAgentPanelProvider: () => agentPanelProvider,
		ensureWorkspaceFolder,
		outputChannel,
	});

	const specCommands = registerSpecCommands({
		specService,
		runtimeManager,
		checkpointService,
		specsProvider,
		specCodeLensProvider,
		agentPanelProvider,
		ensureWorkspaceFolder,
	});

	context.subscriptions.push(
		outputChannel,
		runtimeManager,
		trustService,
		permissionsService,
		specsProvider,
		hooksProvider,
		steeringProvider,
		agentsProvider,
		mcpProvider,
		workflowRunsProvider,
		recipesProvider,
		sessionsProvider,
		focusModeManager,
		agentPanelProvider,
		specCodeLensProvider,
		vscode.window.registerTreeDataProvider('tarot.views.sessions', sessionsProvider),
		vscode.workspace.registerTextDocumentContentProvider(TAROT_GIT_HEAD_SCHEME, new TarotGitHeadContentProvider()),
		vscode.workspace.registerTextDocumentContentProvider('tarot-empty', new TarotEmptyContentProvider()),
		vscode.languages.registerCodeLensProvider(
			{ language: 'markdown', pattern: '**/.tarot/specs/*/tasks.md' },
			specCodeLensProvider,
		),
		vscode.window.registerTreeDataProvider('tarot.views.specs', specsProvider),
		vscode.window.registerTreeDataProvider('tarot.views.hooks', hooksProvider),
		vscode.window.registerTreeDataProvider('tarot.views.steering', steeringProvider),
		vscode.window.registerTreeDataProvider('tarot.views.agents', agentsProvider),
		vscode.window.registerTreeDataProvider('tarot.views.mcp', mcpProvider),
		vscode.window.registerTreeDataProvider('tarot.views.workflowRuns', workflowRunsProvider),
		vscode.window.registerTreeDataProvider('tarot.views.recipes', recipesProvider),
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
			await agentPanelProvider.attachSelectionAndFocus(false);
		}),

		vscode.commands.registerCommand('tarot.agent.sendSelectionToNewSession', async () => {
			await agentPanelProvider.attachSelectionAndFocus(true);
		}),

		vscode.commands.registerCommand('tarot.agent.quickAction.fixGrammar', async () => {
			await agentPanelProvider.runQuickEditorAction('fixGrammar');
		}),

		vscode.commands.registerCommand('tarot.agent.quickAction.writeComments', async () => {
			await agentPanelProvider.runQuickEditorAction('writeComments');
		}),

		vscode.commands.registerCommand('tarot.agent.quickAction.optimize', async () => {
			await agentPanelProvider.runQuickEditorAction('optimize');
		}),

		vscode.commands.registerCommand('tarot.sessions.history', async () => {
			await agentPanelProvider.openSessionHistory();
		}),

		vscode.commands.registerCommand('tarot.sessions.export', async () => {
			await agentPanelProvider.exportActiveSession();
		}),

		vscode.commands.registerCommand('tarot.sessions.compact', async () => {
			await agentPanelProvider.compactActiveSession(true);
		}),

		vscode.commands.registerCommand('tarot.sessions.new', async () => {
			agentPanelProvider.createNewSession();
			sessionsProvider.refresh();
			await vscode.commands.executeCommand(`${TarotAgentPanelProvider.viewId}.focus`);
		}),

		vscode.commands.registerCommand('tarot.sessions.search', async () => {
			const query = await vscode.window.showInputBox({
				title: vscode.l10n.t('Search Sessions'),
				prompt: vscode.l10n.t('Filter by title, repo, agent, branch or status (leave empty to clear)'),
				value: sessionsProvider.getSearchQuery(),
			});
			if (query !== undefined) {
				sessionsProvider.setSearchQuery(query);
			}
		}),

		vscode.commands.registerCommand('tarot.sessions.filter', async () => {
			const picked = await vscode.window.showQuickPick(
				[
					{ label: vscode.l10n.t('All sessions'), filter: 'all' as const },
					{ label: vscode.l10n.t('Needs input'), filter: 'needsInput' as const },
					{ label: vscode.l10n.t('Parked (awaiting approval)'), filter: 'parked' as const },
					{ label: vscode.l10n.t('Active (running)'), filter: 'active' as const },
					{ label: vscode.l10n.t('Spec sessions'), filter: 'spec' as const },
				],
				{ title: vscode.l10n.t('Filter Sessions') },
			);
			if (picked) {
				sessionsProvider.setFilter(picked.filter);
			}
		}),

		vscode.commands.registerCommand('tarot.sessions.open', async (sessionId?: string) => {
			if (!sessionId) {
				return;
			}
			await agentPanelProvider.openSessionById(sessionId);
			if (focusModeManager.isOpen()) {
				await focusModeManager.postState();
			} else {
				await vscode.commands.executeCommand(`${TarotAgentPanelProvider.viewId}.focus`);
			}
		}),

		vscode.commands.registerCommand('tarot.agentConfig.open', async () => {
			const picked = await vscode.window.showQuickPick(
				[
					{ label: vscode.l10n.t('Custom Agents — Create Custom Agent'), command: 'tarot.agents.createCustom' },
					{ label: vscode.l10n.t('Steering — Generate Foundational Steering Docs'), command: 'tarot.steering.generate' },
					{ label: vscode.l10n.t('Skills — Import Agent Skill'), command: 'tarot.skills.import' },
					{ label: vscode.l10n.t('MCP Servers — Open MCP Configuration'), command: 'tarot.mcp.openConfig' },
					{ label: vscode.l10n.t('Permissions — Open User Permissions'), command: 'tarot.permissions.openUserPermissions' },
					{ label: vscode.l10n.t('Permissions — Open Workspace Permissions'), command: 'tarot.permissions.openWorkspacePermissions' },
				],
				{ title: vscode.l10n.t('Tarot IDE — Agent Config') },
			);
			if (picked) {
				await vscode.commands.executeCommand(picked.command);
			}
		}),

		vscode.commands.registerCommand('tarot.schedule.open', async () => {
			vscode.window.showInformationMessage(
				vscode.l10n.t('Scheduled cron jobs and digests arrive in M3.10. Use Workflows & Recipes for multi-step runs today.'),
			);
		}),

		vscode.commands.registerCommand('tarot.settings.open', async () => {
			await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:tarot.tarot-core');
		}),

		vscode.commands.registerCommand('tarot.git.prePrReview', async () => {
			await agentPanelProvider.runPrePrReview();
		}),

		...workflowCommands.disposables,
		...specCommands,

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
					{ label: 'always', description: vscode.l10n.t('Included in every turn (default)'), value: 'always' as SteeringInclusion },
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

		vscode.commands.registerCommand('tarot.hooks.toggle', async (item?: { hook?: { sourceFile: string; name: string; enabled: boolean } }) => {
			const hook = item?.hook;
			if (!hook) {
				return;
			}
			const nextEnabled = !hook.enabled;
			const confirmLabel = nextEnabled ? vscode.l10n.t('Enable') : vscode.l10n.t('Disable');
			const confirm = await vscode.window.showWarningMessage(
				vscode.l10n.t('{0} hook "{1}" in {2}?', confirmLabel, hook.name, path.basename(hook.sourceFile)),
				{ modal: true },
				confirmLabel,
			);
			if (confirm !== confirmLabel) {
				return;
			}
			const ok = await hookEngine.setHookEnabled(hook.sourceFile, hook.name, nextEnabled);
			if (ok) {
				hooksProvider.refresh();
			} else {
				vscode.window.showErrorMessage(vscode.l10n.t('Could not update hook "{0}".', hook.name));
			}
		}),

		vscode.commands.registerCommand('tarot.hooks.runManual', async (item?: { hook?: { action: { type: 'command' | 'agent'; command?: string; prompt?: string }; name: string; timeout: number } }) => {
			const hook = item?.hook;
			if (!hook) {
				return;
			}
			if (!vscode.workspace.isTrusted) {
				vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace before running hooks.'));
				return;
			}
			const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!root) {
				return;
			}
			if (hook.action.type === 'agent' && hook.action.prompt) {
				await agentPanelProvider.runBatchPrompt(hook.action.prompt, vscode.l10n.t('🪝 Hook: {0}', hook.name));
				return;
			}
			if (hook.action.type === 'command' && hook.action.command) {
				const outcome = await permissionsService.createGatedRunCommand(outputChannel!)(hook.action.command, { cwd: root, hook_event_name: 'Manual' }, hook.timeout);
				if (outcome.kind === 'ok') {
					outputChannel!.appendLine(`[Hooks] "${hook.name}" (manual): ${outcome.stdout || '(no output)'}`);
					vscode.window.showInformationMessage(vscode.l10n.t('Hook "{0}" ran successfully.', hook.name));
				} else {
					const message = outcome.kind === 'timeout' ? vscode.l10n.t('timed out') : outcome.stderr;
					vscode.window.showWarningMessage(vscode.l10n.t('Hook "{0}" failed: {1}', hook.name, message || vscode.l10n.t('unknown error')));
				}
			}
		}),

		vscode.commands.registerCommand('tarot.permissions.openUserPermissions', async () => {
			const filePath = trustService.getUserPermissionsPath();
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			try {
				await fs.access(filePath);
			} catch {
				await fs.writeFile(filePath, 'version: 1\nrules: []\n', 'utf8');
			}
			const doc = await vscode.workspace.openTextDocument(filePath);
			await vscode.window.showTextDocument(doc);
		}),

		vscode.commands.registerCommand('tarot.permissions.openWorkspacePermissions', async () => {
			const root = await ensureWorkspaceFolder();
			if (!root) {
				return;
			}
			if (!trustService.requireTrustedOrWarn(vscode.l10n.t('Trust this workspace before editing its permissions.'))) {
				return;
			}
			const filePath = trustService.getWorkspacePermissionsPath(root);
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			try {
				await fs.access(filePath);
			} catch {
				await fs.writeFile(filePath, 'version: 1\nrules: []\n', 'utf8');
			}
			const doc = await vscode.workspace.openTextDocument(filePath);
			await vscode.window.showTextDocument(doc);
		}),

		vscode.commands.registerCommand('tarot.skills.import', async () => {
			const scopePick = await vscode.window.showQuickPick(
				[
					{ label: vscode.l10n.t('Workspace (.tarot/skills/)'), scope: 'workspace' as const },
					{ label: vscode.l10n.t('Global (~/.tarot/skills/)'), scope: 'global' as const },
				],
				{ title: vscode.l10n.t('Import Skill — Target Scope') },
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
				targetDir = skillsService.getWorkspaceSkillsDir(root);
			} else {
				targetDir = skillsService.getGlobalSkillsDir();
			}

			const sourcePick = await vscode.window.showQuickPick(
				[
					{ label: vscode.l10n.t('Local Folder (containing SKILL.md)'), sourceKind: 'local' as const },
					{ label: vscode.l10n.t('GitHub / GitLab Repository URL'), sourceKind: 'git' as const },
				],
				{ title: vscode.l10n.t('Import Skill — Source') },
			);
			if (!sourcePick) {
				return;
			}
			try {
				let imported;
				if (sourcePick.sourceKind === 'local') {
					const picked = await vscode.window.showOpenDialog({
						canSelectFiles: false,
						canSelectFolders: true,
						canSelectMany: false,
						openLabel: vscode.l10n.t('Select Skill Folder'),
					});
					if (!picked?.[0]) {
						return;
					}
					imported = await skillsService.importFromLocalFolder(picked[0].fsPath, targetDir);
				} else {
					const url = await vscode.window.showInputBox({
						title: vscode.l10n.t('Import Skill from Git URL'),
						prompt: vscode.l10n.t('Enter a GitHub or GitLab repository URL (subpath /tree/<branch>/<path> supported)'),
						placeHolder: 'https://github.com/org/repo/tree/main/skills/my-skill',
					});
					if (!url?.trim()) {
						return;
					}
					imported = await skillsService.importFromGitUrl(url.trim(), targetDir);
				}
				vscode.window.showInformationMessage(vscode.l10n.t('Imported skill "{0}".', imported.name));
				const doc = await vscode.workspace.openTextDocument(imported.skillFilePath);
				await vscode.window.showTextDocument(doc);
			} catch (err) {
				vscode.window.showErrorMessage(vscode.l10n.t('Could not import skill: {0}', err instanceof Error ? err.message : String(err)));
			}
		}),

		vscode.commands.registerCommand('tarot.mcp.openConfig', async () => {
			const scopePick = await vscode.window.showQuickPick(
				[
					{ label: vscode.l10n.t('Workspace (.tarot/settings/mcp.json)'), scope: 'workspace' as const },
					{ label: vscode.l10n.t('Global (~/.tarot/settings/mcp.json)'), scope: 'global' as const },
				],
				{ title: vscode.l10n.t('Open MCP Configuration') },
			);
			if (!scopePick) {
				return;
			}
			let filePath: string;
			if (scopePick.scope === 'workspace') {
				const root = await ensureWorkspaceFolder();
				if (!root) {
					return;
				}
				if (!trustService.requireTrustedOrWarn(vscode.l10n.t('Trust this workspace before editing .tarot/settings/mcp.json.'))) {
					return;
				}
				filePath = mcpConfigService.getWorkspaceMcpConfigPath(root);
			} else {
				filePath = mcpConfigService.getGlobalMcpConfigPath();
			}
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			try {
				await fs.access(filePath);
			} catch {
				await fs.writeFile(filePath, JSON.stringify({ mcpServers: {} }, null, 2) + '\n', 'utf8');
			}
			mcpProvider.refresh();
			const doc = await vscode.workspace.openTextDocument(filePath);
			await vscode.window.showTextDocument(doc);
		}),

		vscode.commands.registerCommand('tarot.agents.createCustom', async () => {
			const scopePick = await vscode.window.showQuickPick(
				[
					{ label: vscode.l10n.t('Workspace (.tarot/agents/)'), scope: 'workspace' as const },
					{ label: vscode.l10n.t('User (~/.tarot/agents/)'), scope: 'user' as const },
				],
				{ title: vscode.l10n.t('New Custom Agent — Scope') },
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
				targetDir = customAgentService.getWorkspaceAgentsDir(root);
			} else {
				targetDir = customAgentService.getUserAgentsDir();
			}
			const rawName = await vscode.window.showInputBox({
				title: vscode.l10n.t('New Custom Agent'),
				prompt: vscode.l10n.t('Agent identifier (subfolders supported, e.g. reviewer or team/planner)'),
				placeHolder: 'reviewer',
			});
			if (!rawName?.trim()) {
				return;
			}
			const cleanId = rawName.trim().replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9/_-]+/g, '-');
			if (!cleanId) {
				return;
			}
			const filePath = path.join(targetDir, `${cleanId}.md`);
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			const content = [
				'---',
				`name: "${cleanId}"`,
				'description: "Agente especializado personalizado"',
				'includeMcpJson: true',
				'includePowers: true',
				'---',
				'',
				`# Custom Agent — ${cleanId}`,
				'',
				'Descreva o papel, as restrições e o estilo de resposta deste agente.',
				'',
			].join('\n');
			await fs.writeFile(filePath, content, 'utf8');
			const doc = await vscode.workspace.openTextDocument(filePath);
			await vscode.window.showTextDocument(doc);
		}),
	);

	// File-triggered Agent Hooks (PostFileSave/PostFileCreate/PostFileDelete) — never run
	// automatically in an untrusted workspace (AGENTS.md §2d).
	const runFileTriggerHooks = async (trigger: 'PostFileSave' | 'PostFileCreate' | 'PostFileDelete', uri: vscode.Uri) => {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root || !vscode.workspace.isTrusted) {
			return;
		}
		const relativePath = path.relative(root, uri.fsPath).replace(/\\/g, '/');
		if (relativePath.startsWith('..') || relativePath.startsWith('.tarot/hooks')) {
			return;
		}
		const hooks = await hookEngine.discover(root);
		if (hooks.length === 0) {
			return;
		}
		// headless: true — an automatic file-save trigger cannot show a blocking approval prompt
		// on every keystroke, so an "ask" decision silently downgrades to deny (M3.8a default policy).
		const result = await runHooksForTrigger(
			hooks, trigger, { cwd: root, file_path: relativePath },
			{ matchInput: relativePath, runCommand: permissionsService.createGatedRunCommand(outputChannel!, { headless: true }) },
		);
		for (const w of result.warnings) {
			outputChannel!.appendLine(`[Hooks] "${w.hook.name}" (${trigger}): ${w.message}`);
		}
		for (const action of result.agentActions) {
			await agentPanelProvider.runBatchPrompt(action.prompt.replace(/\{\{file\}\}/g, relativePath), vscode.l10n.t('🪝 Hook: {0}', action.hook.name));
		}
	};

	context.subscriptions.push(
		{ dispose: () => fileHookQueue.dispose() },
		vscode.workspace.onDidSaveTextDocument(doc => {
			fileHookQueue.enqueue(`PostFileSave:${doc.uri.fsPath}`, () => runFileTriggerHooks('PostFileSave', doc.uri));
		}),
		vscode.workspace.onDidCreateFiles(e => {
			for (const uri of e.files) {
				fileHookQueue.enqueue(`PostFileCreate:${uri.fsPath}`, () => runFileTriggerHooks('PostFileCreate', uri));
			}
		}),
		vscode.workspace.onDidDeleteFiles(e => {
			for (const uri of e.files) {
				fileHookQueue.enqueue(`PostFileDelete:${uri.fsPath}`, () => runFileTriggerHooks('PostFileDelete', uri));
			}
		}),
	);

	// Initial background detection of local AI CLIs (claude, agy, codex, custom)
	void runtimeManager.refresh().catch(err => {
		outputChannel?.appendLine(`[Agents] Initial refresh failed: ${err instanceof Error ? err.message : String(err)}`);
	});

	// Kiro-style Agent-First startup: reveal Tarot Agent in Secondary Side Bar by default
	const openOnStartup = vscode.workspace.getConfiguration('tarot.ui').get<boolean>('openAgentPanelOnStartup', true);
	if (openOnStartup) {
		const startupTimer = setTimeout(() => {
			void Promise.resolve(vscode.commands.executeCommand(`${TarotAgentPanelProvider.viewId}.focus`)).catch(() => undefined);
		}, 400);
		context.subscriptions.push(new vscode.Disposable(() => clearTimeout(startupTimer)));
	}
}

export function deactivate(): void {
	outputChannel = undefined;
}
