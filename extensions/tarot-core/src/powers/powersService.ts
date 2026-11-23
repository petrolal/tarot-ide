/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { McpServerConfig, parseMcpConfigJson } from '../mcp/mcpConfigService';
import { SkillDefinition, TarotSkillsService } from '../skills/skillsService';

export type PowerScope = 'workspace' | 'global';

export interface PowerPluginManifest {
	readonly name: string;
	readonly description: string;
	readonly keywords: readonly string[];
	readonly version?: string;
}

export interface PowerDefinition {
	readonly id: string;
	readonly manifest: PowerPluginManifest;
	readonly scope: PowerScope;
	readonly dirPath: string;
	readonly skills: readonly SkillDefinition[];
	readonly mcpServers: readonly McpServerConfig[];
}

export interface PowerActivationResult {
	readonly activePowers: readonly PowerDefinition[];
	readonly skills: readonly SkillDefinition[];
	readonly mcpServers: readonly McpServerConfig[];
	readonly summaryContext?: string;
}

/** Parses a Power `plugin.json` manifest (Agent Plugins format). Pure — unit-testable. */
export function parsePowerManifest(raw: unknown, fallbackName: string): PowerPluginManifest | undefined {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return undefined;
	}
	const obj = raw as Record<string, unknown>;
	const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : fallbackName;
	const description = typeof obj.description === 'string' ? obj.description.trim() : '';
	const keywords = Array.isArray(obj.keywords)
		? obj.keywords.filter((k): k is string => typeof k === 'string' && k.trim().length > 0).map(k => k.trim().toLowerCase())
		: [];
	const version = typeof obj.version === 'string' && obj.version.trim() ? obj.version.trim() : undefined;
	return { name, description, keywords, version };
}

/**
 * Activates Powers on demand when the prompt mentions any of their declared `keywords` (or
 * `/power:<id>`), and naturally deactivates them on subsequent turns when the topic changes.
 * Pure — unit-testable.
 */
export function matchPowersForPrompt(powers: readonly PowerDefinition[], prompt: string): PowerActivationResult {
	const promptLower = prompt.toLowerCase();
	const activePowers: PowerDefinition[] = [];

	for (const power of powers) {
		const explicit = promptLower.includes(`#${power.id.toLowerCase()}`) || promptLower.includes(`/${power.id.toLowerCase()}`);
		const keywordHit = power.manifest.keywords.some(kw => {
			const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			return new RegExp(`(?:^|[^a-z0-9_])${escaped}(?:[^a-z0-9_]|$)`, 'i').test(promptLower);
		});
		if (explicit || keywordHit) {
			activePowers.push(power);
		}
	}

	const skills = activePowers.flatMap(p => p.skills);
	const mcpServers = activePowers.flatMap(p => p.mcpServers);
	const summaryContext = activePowers.length > 0
		? `Active Powers: ${activePowers.map(p => `${p.manifest.name} (${p.skills.length} skills, ${p.mcpServers.length} MCP servers)`).join(', ')}`
		: undefined;

	return { activePowers, skills, mcpServers, summaryContext };
}

/**
 * Discovers Powers (`plugin.json` + optional `skills/` + optional `mcp.json`) from
 * `.tarot/powers/` (workspace) and `~/.tarot/powers/` (global). Callers must gate workspace
 * discovery on `vscode.workspace.isTrusted`.
 */
export class TarotPowersService {
	constructor(private readonly skillsService: TarotSkillsService) { }

	getGlobalPowersDir(): string {
		return path.join(os.homedir(), '.tarot', 'powers');
	}

	getWorkspacePowersDir(workspaceRoot: string): string {
		return path.join(workspaceRoot, '.tarot', 'powers');
	}

	async discover(workspaceRoot?: string): Promise<PowerDefinition[]> {
		const byId = new Map<string, PowerDefinition>();
		for (const p of await this.readPowersDir(this.getGlobalPowersDir(), 'global')) {
			byId.set(p.id.toLowerCase(), p);
		}
		if (workspaceRoot) {
			for (const p of await this.readPowersDir(this.getWorkspacePowersDir(workspaceRoot), 'workspace')) {
				byId.set(p.id.toLowerCase(), p);
			}
		}
		return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
	}

	private async readPowersDir(dirPath: string, scope: PowerScope): Promise<PowerDefinition[]> {
		let entries;
		try {
			entries = await fs.readdir(dirPath, { withFileTypes: true });
		} catch {
			return [];
		}
		const results: PowerDefinition[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}
			const powerDir = path.join(dirPath, entry.name);
			const manifestFile = path.join(powerDir, 'plugin.json');
			try {
				const raw = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
				const manifest = parsePowerManifest(raw, entry.name);
				if (!manifest) {
					continue;
				}
				const skills = await this.skillsService.readSkillsDir(path.join(powerDir, 'skills'), 'power');
				let mcpServers: McpServerConfig[] = [];
				try {
					const mcpRaw = JSON.parse(await fs.readFile(path.join(powerDir, 'mcp.json'), 'utf8'));
					mcpServers = parseMcpConfigJson(mcpRaw, path.join(powerDir, 'mcp.json'), scope).servers;
				} catch {
					// Optional mcp.json
				}
				results.push({ id: entry.name, manifest, scope, dirPath: powerDir, skills, mcpServers });
			} catch {
				// Skip directory without valid plugin.json
			}
		}
		return results;
	}
}
