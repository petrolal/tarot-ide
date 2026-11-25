/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CustomAgentProfile, TarotCustomAgentService } from '../agents/customAgentService';
import { TarotPowersService } from '../powers/powersService';
import { SkillDefinition, TarotSkillsService } from '../skills/skillsService';
import { arcanaIcon, BaseTarotTreeProvider, getWorkspaceRoot, SimpleTreeItem } from './tarotSidebarViews';

export class SkillTreeItem extends SimpleTreeItem {
	constructor(
		label: string,
		readonly skill: SkillDefinition,
	) {
		super(label, vscode.TreeItemCollapsibleState.None, skill.skillFilePath);
	}
}

export class CustomAgentTreeItem extends SimpleTreeItem {
	constructor(
		label: string,
		readonly profile: CustomAgentProfile,
	) {
		super(label, vscode.TreeItemCollapsibleState.None, profile.sourceFile);
	}
}

export class SkillsTreeProvider extends BaseTarotTreeProvider {
	constructor(
		private readonly skillsService: TarotSkillsService,
		private readonly powersService: TarotPowersService,
		private readonly extensionUri: vscode.Uri,
	) {
		super([
			'**/.tarot/skills/**/SKILL.md',
			'**/.tarot/powers/**/skills/**/SKILL.md',
		]);
	}

	private toSkillItem(skill: SkillDefinition): SkillTreeItem {
		const item = new SkillTreeItem(skill.name, skill);
		const badges: string[] = [`/${skill.id}`];
		if (skill.hasScripts) {
			badges.push('scripts');
		}
		if (skill.hasReferences) {
			badges.push('refs');
		}
		item.description = badges.join(' · ');
		item.iconPath = arcanaIcon(this.extensionUri, '02-high-priestess.svg');
		item.contextValue = 'tarotSkillItem';
		item.tooltip = [
			`${skill.name} (${skill.scope})`,
			skill.description || vscode.l10n.t('Agent Skill'),
			vscode.l10n.t('Invoke: /{0} or ${0}', skill.id),
			vscode.l10n.t('Path: {0}', skill.skillFilePath),
		].join('\n');
		item.command = {
			command: 'vscode.open',
			title: vscode.l10n.t('Open SKILL.md'),
			arguments: [vscode.Uri.file(skill.skillFilePath)],
		};
		return item;
	}

	async getChildren(element?: SimpleTreeItem): Promise<SimpleTreeItem[]> {
		if (element?.children) {
			return element.children;
		}
		const root = vscode.workspace.isTrusted ? getWorkspaceRoot() : undefined;
		const powers = await this.powersService.discover(root);
		const powerSkills = powers.flatMap(p => p.skills);
		const skills = await this.skillsService.discover(root, powerSkills);
		if (skills.length === 0) {
			return [];
		}

		const scopes: Array<{ key: 'workspace' | 'global' | 'power'; label: string; desc: string; icon: string }> = [
			{ key: 'workspace', label: vscode.l10n.t('Workspace'), desc: '.tarot/skills', icon: 'folder' },
			{ key: 'global', label: vscode.l10n.t('Global'), desc: '~/.tarot/skills', icon: 'globe' },
			{ key: 'power', label: vscode.l10n.t('From Powers'), desc: 'powers', icon: 'zap' },
		];

		const groups: SimpleTreeItem[] = [];
		for (const s of scopes) {
			const items = skills.filter(sk => sk.scope === s.key).map(sk => this.toSkillItem(sk));
			if (items.length === 0) {
				continue;
			}
			const group = new SimpleTreeItem(
				s.label,
				vscode.TreeItemCollapsibleState.Expanded,
				undefined,
				items,
			);
			group.description = `${s.desc} (${items.length})`;
			group.iconPath = new vscode.ThemeIcon(s.icon);
			groups.push(group);
		}
		return groups;
	}
}

export class CustomAgentsTreeProvider extends BaseTarotTreeProvider {
	constructor(
		private readonly customAgentService: TarotCustomAgentService,
		private readonly extensionUri: vscode.Uri,
	) {
		super([
			'**/.tarot/agents/**/*.md',
			'**/.tarot/agents/**/*.json',
		]);
	}

	private toAgentItem(profile: CustomAgentProfile): CustomAgentTreeItem {
		const item = new CustomAgentTreeItem(profile.name, profile);
		const parts: string[] = [];
		if (profile.model) {
			parts.push(profile.model);
		}
		if (profile.excludedTools?.length) {
			parts.push(vscode.l10n.t('restricted'));
		}
		if (profile.permissions?.length) {
			parts.push(vscode.l10n.t('{0} rules', profile.permissions.length));
		}
		item.description = parts.join(' · ') || profile.id;
		item.iconPath = arcanaIcon(this.extensionUri, '01-the-magician.svg');
		item.contextValue = 'tarotCustomAgent';
		item.tooltip = [
			`${profile.name} (${profile.origin})`,
			profile.description,
			profile.tools?.length ? vscode.l10n.t('Tools: {0}', profile.tools.join(', ')) : undefined,
			profile.excludedTools?.length ? vscode.l10n.t('Excluded: {0}', profile.excludedTools.join(', ')) : undefined,
			profile.sourceFile ? vscode.l10n.t('Path: {0}', profile.sourceFile) : undefined,
		].filter(Boolean).join('\n');

		item.command = profile.sourceFile
			? {
				command: 'vscode.open',
				title: vscode.l10n.t('Open Custom Agent'),
				arguments: [vscode.Uri.file(profile.sourceFile)],
			}
			: {
				command: 'tarot.agents.selectProfile',
				title: vscode.l10n.t('Activate Agent Profile'),
				arguments: [item],
			};
		return item;
	}

	async getChildren(element?: SimpleTreeItem): Promise<SimpleTreeItem[]> {
		if (element?.children) {
			return element.children;
		}
		const root = vscode.workspace.isTrusted ? getWorkspaceRoot() : undefined;
		const profiles = await this.customAgentService.discover(root);
		if (profiles.length === 0) {
			return [];
		}

		const origins: Array<{ key: 'workspace' | 'user' | 'builtIn'; label: string; desc: string; icon: string }> = [
			{ key: 'workspace', label: vscode.l10n.t('Workspace'), desc: '.tarot/agents', icon: 'folder' },
			{ key: 'user', label: vscode.l10n.t('User'), desc: '~/.tarot/agents', icon: 'account' },
			{ key: 'builtIn', label: vscode.l10n.t('Built-in'), desc: 'Tarot', icon: 'sparkle' },
		];

		const groups: SimpleTreeItem[] = [];
		for (const o of origins) {
			const items = profiles.filter(p => p.origin === o.key).map(p => this.toAgentItem(p));
			if (items.length === 0) {
				continue;
			}
			const group = new SimpleTreeItem(
				o.label,
				o.key === 'builtIn' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded,
				undefined,
				items,
			);
			group.description = `${o.desc} (${items.length})`;
			group.iconPath = new vscode.ThemeIcon(o.icon);
			groups.push(group);
		}
		return groups;
	}
}
