/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CustomAgentProfile } from '../agents/customAgentService';
import { AttachedContext } from '../agents/types';
import { TarotMcpConfigService } from '../mcp/mcpConfigService';
import { matchPowersForPrompt, TarotPowersService } from '../powers/powersService';
import { resolveSkillsForPrompt, TarotSkillsService } from '../skills/skillsService';
import { TarotSteeringService } from '../steering/steeringService';

export interface TurnContextDependencies {
	readonly steeringService: TarotSteeringService;
	readonly powersService: TarotPowersService;
	readonly skillsService: TarotSkillsService;
	readonly mcpConfigService: TarotMcpConfigService;
}

export interface TurnContextInput {
	readonly workspaceRoot?: string;
	readonly prompt: string;
	readonly activeProfile?: CustomAgentProfile;
	readonly activeFiles: readonly string[];
	readonly attachments: readonly AttachedContext[];
	readonly explicitSkillIds?: readonly string[];
}

export interface TurnContextResult {
	readonly systemContext?: string;
	readonly appliedSteering: readonly string[];
}

/**
 * Assembles the per-turn `systemContext` (Custom Agent profile + workspace-confined `file://`
 * resources, Steering docs, keyword-activated Powers, progressive-disclosure Skills, and MCP
 * server summary) while strictly enforcing Workspace Trust for all `.tarot/` artifacts.
 */
export async function assembleTurnSystemContext(
	deps: TurnContextDependencies,
	input: TurnContextInput,
): Promise<TurnContextResult> {
	const isTrusted = vscode.workspace.isTrusted;
	const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

	const steeringResolution = isTrusted
		? await deps.steeringService.resolveForTurn({
			workspaceRoot: wsRoot,
			prompt: input.prompt,
			activeFiles: [...input.activeFiles],
			attachments: [...input.attachments],
		})
		: { applied: [] };

	const systemContextSections: string[] = [];
	const activeProfile = input.activeProfile;
	if (activeProfile && activeProfile.origin !== 'builtIn') {
		const lines: string[] = [`### Active Custom Agent: ${activeProfile.name} (${activeProfile.origin})`];
		if (activeProfile.tools && activeProfile.tools.length > 0) {
			lines.push(`Allowed tools: ${activeProfile.tools.join(', ')}`);
		}
		if (activeProfile.excludedTools && activeProfile.excludedTools.length > 0) {
			lines.push(`Excluded tools (do not use): ${activeProfile.excludedTools.join(', ')}`);
		}
		if (activeProfile.prompt) {
			lines.push(activeProfile.prompt);
		}
		// Inject declared `file://` resources (strictly confined to workspaceRoot when trusted).
		if (isTrusted && activeProfile.resources && activeProfile.resources.length > 0 && input.workspaceRoot) {
			const rootAbs = path.resolve(input.workspaceRoot);
			for (const resUri of activeProfile.resources) {
				if (resUri.startsWith('file://')) {
					const rel = resUri.slice('file://'.length).replace(/^\/+/, '');
					const target = path.resolve(rootAbs, rel);
					if (target.startsWith(rootAbs + path.sep)) {
						const text = await fs.readFile(target, 'utf8').catch(() => undefined);
						if (text) {
							lines.push(`\n#### Resource: ${rel}\n${text.slice(0, 8_000)}`);
						}
					}
				}
			}
		}
		systemContextSections.push(lines.join('\n'));
	}

	if (steeringResolution.formattedContext) {
		systemContextSections.push(steeringResolution.formattedContext);
	}

	if (isTrusted) {
		const powerActivation = activeProfile?.includePowers !== false
			? matchPowersForPrompt(await deps.powersService.discover(wsRoot), input.prompt)
			: { activePowers: [], skills: [], mcpServers: [] };
		if (powerActivation.summaryContext) {
			systemContextSections.push(powerActivation.summaryContext);
		}
		const skills = await deps.skillsService.discover(wsRoot, powerActivation.skills);
		const profileSkillIds = (activeProfile?.resources ?? [])
			.filter(r => r.startsWith('skill://'))
			.map(r => r.slice('skill://'.length).trim())
			.filter(Boolean);
		const combinedSkillIds = [...(input.explicitSkillIds ?? []), ...profileSkillIds];
		const skillsResolution = resolveSkillsForPrompt(skills, input.prompt, {
			explicitSkillIds: combinedSkillIds.length > 0 ? combinedSkillIds : undefined,
		});
		if (skillsResolution.catalogContext) {
			systemContextSections.push(skillsResolution.catalogContext);
		}
		if (skillsResolution.activeContext) {
			systemContextSections.push(skillsResolution.activeContext);
		}
		if (activeProfile?.includeMcpJson !== false) {
			const { servers } = await deps.mcpConfigService.discover(wsRoot, powerActivation.mcpServers);
			const enabledServers = servers.filter(s => s.enabled);
			if (enabledServers.length > 0) {
				systemContextSections.push(`Configured MCP Servers: ${enabledServers.map(s => `${s.name} (${s.transport})`).join(', ')}`);
			}
		}
	}

	return {
		systemContext: systemContextSections.length > 0 ? systemContextSections.join('\n\n') : undefined,
		appliedSteering: steeringResolution.applied.map(item => item.label),
	};
}
