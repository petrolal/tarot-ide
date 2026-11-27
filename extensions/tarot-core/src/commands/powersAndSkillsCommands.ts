/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TarotCustomAgentService } from '../agents/customAgentService';
import { PowerDefinition, TarotPowersService } from '../powers/powersService';
import { TarotSkillsService } from '../skills/skillsService';
import { TarotAgentPanelProvider } from '../views/agentPanelView';
import {
	AvailablePowersTreeProvider,
	AvailablePowerTreeItem,
	InstalledPowersTreeProvider,
	InstalledPowerTreeItem,
	PowerDetailTarget,
	TarotPowerDetailPanel,
} from '../views/powersView';
import { CustomAgentsTreeProvider, CustomAgentTreeItem, SkillsTreeProvider } from '../views/skillsAndAgentsView';
import { getWorkspaceRoot, McpServersTreeProvider } from '../views/tarotSidebarViews';

export interface PowersAndSkillsCommandDeps {
	readonly powersService: TarotPowersService;
	readonly skillsService: TarotSkillsService;
	readonly customAgentService: TarotCustomAgentService;
	readonly installedPowersProvider: InstalledPowersTreeProvider;
	readonly availablePowersProvider: AvailablePowersTreeProvider;
	readonly skillsProvider: SkillsTreeProvider;
	readonly customAgentsProvider: CustomAgentsTreeProvider;
	readonly mcpProvider: McpServersTreeProvider;
	readonly agentPanelProvider: TarotAgentPanelProvider;
	readonly ensureWorkspaceFolder: () => Promise<string | undefined>;
}

export function registerPowersAndSkillsCommands(deps: PowersAndSkillsCommandDeps): vscode.Disposable[] {
	const refreshAll = (): void => {
		deps.installedPowersProvider.refresh();
		deps.availablePowersProvider.refresh();
		deps.skillsProvider.refresh();
		deps.mcpProvider.refresh();
	};

	const pickTargetPowersDir = async (): Promise<string | undefined> => {
		const root = getWorkspaceRoot();
		const items: Array<{ label: string; description: string; dir: string; requiresTrust: boolean }> = [];
		if (root) {
			items.push({
				label: vscode.l10n.t('Workspace (.tarot/powers/)'),
				description: vscode.l10n.t('Shared with this repository'),
				dir: deps.powersService.getWorkspacePowersDir(root),
				requiresTrust: true,
			});
		}
		items.push({
			label: vscode.l10n.t('Global (~/.tarot/powers/)'),
			description: vscode.l10n.t('Available across all workspaces'),
			dir: deps.powersService.getGlobalPowersDir(),
			requiresTrust: false,
		});
		const picked = await vscode.window.showQuickPick(items, {
			title: vscode.l10n.t('Select Power Installation Scope'),
		});
		if (!picked) {
			return undefined;
		}
		if (picked.requiresTrust && !vscode.workspace.isTrusted) {
			vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace to install Powers under .tarot/powers/.'));
			return undefined;
		}
		return picked.dir;
	};

	const installCurated = async (powerId: string, scope: 'workspace' | 'global'): Promise<void> => {
		let targetDir: string;
		if (scope === 'workspace') {
			if (!vscode.workspace.isTrusted) {
				vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace to install Powers under .tarot/powers/.'));
				return;
			}
			const root = await deps.ensureWorkspaceFolder();
			if (!root) {
				return;
			}
			targetDir = deps.powersService.getWorkspacePowersDir(root);
		} else {
			targetDir = deps.powersService.getGlobalPowersDir();
		}
		try {
			const installed = await deps.powersService.installCuratedPower(powerId, targetDir);
			refreshAll();
			vscode.window.showInformationMessage(vscode.l10n.t('Power "{0}" installed ({1}).', installed.manifest.name, installed.scope));
		} catch (err) {
			vscode.window.showErrorMessage(vscode.l10n.t('Failed to install Power: {0}', err instanceof Error ? err.message : String(err)));
		}
	};

	const uninstallPower = async (power: PowerDefinition): Promise<void> => {
		const confirmLabel = vscode.l10n.t('Uninstall');
		const choice = await vscode.window.showWarningMessage(
			vscode.l10n.t('Uninstall Power "{0}" from {1}?', power.manifest.name, power.dirPath),
			{ modal: true },
			confirmLabel,
		);
		if (choice !== confirmLabel) {
			return;
		}
		const root = getWorkspaceRoot();
		const allowedRoots = [deps.powersService.getGlobalPowersDir()];
		if (root) {
			allowedRoots.push(deps.powersService.getWorkspacePowersDir(root));
		}
		try {
			await deps.powersService.uninstallPower(power.dirPath, allowedRoots);
			refreshAll();
			vscode.window.showInformationMessage(vscode.l10n.t('Power "{0}" uninstalled.', power.manifest.name));
		} catch (err) {
			vscode.window.showErrorMessage(vscode.l10n.t('Failed to uninstall Power: {0}', err instanceof Error ? err.message : String(err)));
		}
	};

	const detailPanel = new TarotPowerDetailPanel({
		installCurated,
		uninstall: uninstallPower,
		openFile: async filePath => {
			const doc = await vscode.workspace.openTextDocument(filePath);
			await vscode.window.showTextDocument(doc);
		},
	});

	return [
		detailPanel,

		vscode.commands.registerCommand('tarot.powers.openDetail', (target?: PowerDetailTarget | InstalledPowerTreeItem | AvailablePowerTreeItem) => {
			if (!target) {
				return;
			}
			if (target instanceof InstalledPowerTreeItem) {
				detailPanel.show({ kind: 'installed', power: target.power });
			} else if (target instanceof AvailablePowerTreeItem) {
				detailPanel.show({ kind: 'curated', template: target.template, isInstalled: target.isInstalled });
			} else if ('kind' in target) {
				detailPanel.show(target);
			}
		}),

		vscode.commands.registerCommand('tarot.powers.installCurated', async (item?: AvailablePowerTreeItem) => {
			const templateId = item?.template.id;
			if (!templateId) {
				await vscode.commands.executeCommand('tarot.powers.install');
				return;
			}
			const root = getWorkspaceRoot();
			const scope: 'workspace' | 'global' = root && vscode.workspace.isTrusted ? 'workspace' : 'global';
			await installCurated(templateId, scope);
		}),

		vscode.commands.registerCommand('tarot.powers.install', async () => {
			const source = await vscode.window.showQuickPick([
				{ label: vscode.l10n.t('$(star) Curated Starter Power'), id: 'curated' as const, description: vscode.l10n.t('1-click offline starter bundle') },
				{ label: vscode.l10n.t('$(repo) Public GitHub / GitLab Repository URL'), id: 'git' as const, description: vscode.l10n.t('Clones via git --depth 1 (https://)') },
				{ label: vscode.l10n.t('$(folder) Local Folder'), id: 'folder' as const, description: vscode.l10n.t('Folder containing plugin.json or POWER.md') },
			], { title: vscode.l10n.t('Install Tarot Power') });
			if (!source) {
				return;
			}

			if (source.id === 'curated') {
				const picked = await vscode.window.showQuickPick(
					deps.powersService.getCuratedCatalog().map(tpl => ({
						label: tpl.name,
						description: `v${tpl.version}`,
						detail: `${tpl.description} (${tpl.keywords.join(', ')})`,
						id: tpl.id,
					})),
					{ title: vscode.l10n.t('Select Starter Power') },
				);
				if (!picked) {
					return;
				}
				const targetDir = await pickTargetPowersDir();
				if (!targetDir) {
					return;
				}
				const scope: 'workspace' | 'global' = targetDir === deps.powersService.getGlobalPowersDir() ? 'global' : 'workspace';
				await installCurated(picked.id, scope);
				return;
			}

			const targetDir = await pickTargetPowersDir();
			if (!targetDir) {
				return;
			}

			if (source.id === 'folder') {
				const picked = await vscode.window.showOpenDialog({
					canSelectFiles: false,
					canSelectFolders: true,
					canSelectMany: false,
					openLabel: vscode.l10n.t('Select Power Folder'),
				});
				if (!picked?.[0]) {
					return;
				}
				try {
					const installed = await deps.powersService.installFromLocalFolder(picked[0].fsPath, targetDir);
					refreshAll();
					vscode.window.showInformationMessage(vscode.l10n.t('Power "{0}" installed.', installed.manifest.name));
				} catch (err) {
					vscode.window.showErrorMessage(vscode.l10n.t('Failed to install Power: {0}', err instanceof Error ? err.message : String(err)));
				}
				return;
			}

			const repoUrl = await vscode.window.showInputBox({
				title: vscode.l10n.t('Install Power from GitHub or GitLab'),
				prompt: vscode.l10n.t('Paste a public https:// GitHub or GitLab URL pointing to a Power repository or subfolder.'),
				placeHolder: 'https://github.com/org/repo/tree/main/powers/my-power',
			});
			if (!repoUrl?.trim()) {
				return;
			}
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Installing Power from repository...') },
				async () => {
					try {
						const installed = await deps.powersService.installFromGitUrl(repoUrl, targetDir);
						refreshAll();
						vscode.window.showInformationMessage(vscode.l10n.t('Power "{0}" installed.', installed.manifest.name));
					} catch (err) {
						vscode.window.showErrorMessage(vscode.l10n.t('Failed to install Power: {0}', err instanceof Error ? err.message : String(err)));
					}
				},
			);
		}),

		vscode.commands.registerCommand('tarot.powers.create', async () => {
			const id = await vscode.window.showInputBox({
				title: vscode.l10n.t('New Custom Power'),
				prompt: vscode.l10n.t('Enter a slug identifier (e.g. stripe-payments, kubernetes-ops).'),
				placeHolder: 'my-power',
			});
			if (!id?.trim()) {
				return;
			}
			const description = await vscode.window.showInputBox({
				title: vscode.l10n.t('Power Description'),
				prompt: vscode.l10n.t('Briefly describe what domain expertise this Power bundles.'),
				placeHolder: 'Domain guidelines, skills, and MCP servers',
			});
			if (description === undefined) {
				return;
			}
			const keywordsRaw = await vscode.window.showInputBox({
				title: vscode.l10n.t('Activation Keywords'),
				prompt: vscode.l10n.t('Comma-separated keywords that dynamically activate this Power in chat.'),
				placeHolder: 'stripe, billing, checkout, webhook',
			});
			if (keywordsRaw === undefined) {
				return;
			}
			const targetDir = await pickTargetPowersDir();
			if (!targetDir) {
				return;
			}
			try {
				const keywords = keywordsRaw.split(',').map(k => k.trim()).filter(Boolean);
				const created = await deps.powersService.createPowerTemplate(targetDir, id, description, keywords);
				refreshAll();
				const doc = await vscode.workspace.openTextDocument(created.manifestPath);
				await vscode.window.showTextDocument(doc);
			} catch (err) {
				vscode.window.showErrorMessage(vscode.l10n.t('Failed to create Power: {0}', err instanceof Error ? err.message : String(err)));
			}
		}),

		vscode.commands.registerCommand('tarot.powers.uninstall', async (item?: InstalledPowerTreeItem) => {
			let power = item?.power;
			if (!power) {
				const root = vscode.workspace.isTrusted ? getWorkspaceRoot() : undefined;
				const discovered = await deps.powersService.discover(root, vscode.workspace.isTrusted);
				if (discovered.length === 0) {
					vscode.window.showInformationMessage(vscode.l10n.t('No installed Powers found.'));
					return;
				}
				const picked = await vscode.window.showQuickPick(
					discovered.map(p => ({ label: p.manifest.name, description: p.scope, detail: p.dirPath, power: p })),
					{ title: vscode.l10n.t('Uninstall Power') },
				);
				power = picked?.power;
			}
			if (power) {
				await uninstallPower(power);
			}
		}),

		vscode.commands.registerCommand('tarot.powers.search', async () => {
			const query = await vscode.window.showInputBox({
				title: vscode.l10n.t('Search Powers'),
				prompt: vscode.l10n.t('Filter installed and available Powers by name, description, or keyword (leave empty to clear).'),
				value: deps.installedPowersProvider.getFilter(),
			});
			if (query === undefined) {
				return;
			}
			deps.installedPowersProvider.setFilter(query);
			deps.availablePowersProvider.setFilter(query);
		}),

		vscode.commands.registerCommand('tarot.powers.refresh', () => {
			refreshAll();
		}),

		vscode.commands.registerCommand('tarot.skills.create', async () => {
			const id = await vscode.window.showInputBox({
				title: vscode.l10n.t('New Agent Skill'),
				prompt: vscode.l10n.t('Enter a skill identifier (invoked via /<id>).'),
				placeHolder: 'release-checklist',
			});
			if (!id?.trim()) {
				return;
			}
			const description = await vscode.window.showInputBox({
				title: vscode.l10n.t('Skill Description'),
				prompt: vscode.l10n.t('Describe when agents should activate this Skill.'),
				placeHolder: 'Checklist de release, changelog e validação de build',
			});
			if (description === undefined) {
				return;
			}
			const root = getWorkspaceRoot();
			const scopeItems: Array<{ label: string; dir: string; requiresTrust: boolean }> = [];
			if (root) {
				scopeItems.push({ label: vscode.l10n.t('Workspace (.tarot/skills/)'), dir: deps.skillsService.getWorkspaceSkillsDir(root), requiresTrust: true });
			}
			scopeItems.push({ label: vscode.l10n.t('Global (~/.tarot/skills/)'), dir: deps.skillsService.getGlobalSkillsDir(), requiresTrust: false });
			const picked = await vscode.window.showQuickPick(scopeItems, { title: vscode.l10n.t('Select Skill Scope') });
			if (!picked) {
				return;
			}
			if (picked.requiresTrust && !vscode.workspace.isTrusted) {
				vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace to create skills under .tarot/skills/.'));
				return;
			}
			try {
				const created = await deps.skillsService.createSkillTemplate(picked.dir, id, description);
				deps.skillsProvider.refresh();
				const doc = await vscode.workspace.openTextDocument(created.skillFilePath);
				await vscode.window.showTextDocument(doc);
			} catch (err) {
				vscode.window.showErrorMessage(vscode.l10n.t('Failed to create Skill: {0}', err instanceof Error ? err.message : String(err)));
			}
		}),

		vscode.commands.registerCommand('tarot.skills.refresh', () => {
			deps.skillsProvider.refresh();
		}),

		vscode.commands.registerCommand('tarot.agents.selectProfile', async (item?: CustomAgentTreeItem) => {
			let profile = item?.profile;
			if (!profile) {
				const root = vscode.workspace.isTrusted ? getWorkspaceRoot() : undefined;
				const all = await deps.customAgentService.discover(root, vscode.workspace.isTrusted);
				const picked = await vscode.window.showQuickPick(
					all.map(p => ({ label: p.name, description: p.origin, detail: p.description, profile: p })),
					{ title: vscode.l10n.t('Activate Custom Agent Profile') },
				);
				profile = picked?.profile;
			}
			if (!profile) {
				return;
			}
			await vscode.commands.executeCommand('tarot.views.agentPanel.focus');
			const intro = profile.welcomeMessage
				? `${profile.welcomeMessage}`
				: vscode.l10n.t('Custom Agent profile "{0}" is ready. Use @{1} or mention it in your prompt.', profile.name, profile.id);
			vscode.window.showInformationMessage(intro);
		}),

		vscode.commands.registerCommand('tarot.agents.refreshProfiles', () => {
			deps.customAgentsProvider.refresh();
		}),
	];
}
