/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parsePermissionsDocument, PermissionRule } from '../permissions/permissionTypes';
import { parseYamlLite } from '../permissions/yamlLite';

export type CustomAgentOrigin = 'builtIn' | 'user' | 'workspace';

export interface CustomAgentProfile {
	/** Identifier including subfolder prefix when nested (e.g. `team/planner`). */
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly origin: CustomAgentOrigin;
	readonly sourceFile?: string;
	readonly tools?: readonly string[];
	readonly excludedTools?: readonly string[];
	readonly includeMcpJson?: boolean;
	readonly includePowers?: boolean;
	readonly resources?: readonly string[];
	readonly permissions?: readonly PermissionRule[];
	readonly prompt?: string;
	readonly model?: string;
	readonly welcomeMessage?: string;
}

export const BUILT_IN_AGENT_PROFILES: readonly CustomAgentProfile[] = [
	{
		id: 'default',
		name: 'Default',
		description: 'General-purpose Tarot coding assistant (Vibe mode).',
		origin: 'builtIn',
		includeMcpJson: true,
		includePowers: true,
	},
	{
		id: 'spec',
		name: 'Spec',
		description: 'Spec-Driven Development (EARS requirements, design & tasks).',
		origin: 'builtIn',
		includeMcpJson: true,
		includePowers: true,
	},
	{
		id: 'quick-spec',
		name: 'Quick Spec',
		description: 'Generate requirements, design and tasks in a single pass.',
		origin: 'builtIn',
		includeMcpJson: true,
		includePowers: true,
	},
	{
		id: 'bug-fix',
		name: 'Bug Fix',
		description: 'Capture defect, root cause and regression checks.',
		origin: 'builtIn',
		includeMcpJson: true,
		includePowers: true,
	},
	{
		id: 'plan',
		name: 'Plan',
		description: 'Read-only investigation and architecture planning.',
		origin: 'builtIn',
		excludedTools: ['fs_write', 'shell'],
		includeMcpJson: true,
		includePowers: true,
	},
];

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const out = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map(v => v.trim());
	return out.length > 0 ? out : undefined;
}

function parseAgentPermissions(rawPermissions: unknown, sourceFile: string): readonly PermissionRule[] | undefined {
	if (!rawPermissions) {
		return undefined;
	}
	const doc = Array.isArray(rawPermissions)
		? { version: 1, rules: rawPermissions }
		: rawPermissions;
	const parsed = parsePermissionsDocument(doc, sourceFile);
	return parsed.rules.length > 0 ? parsed.rules : undefined;
}

/** Parses a `.tarot/agents/<name>.json` or `.md` custom agent definition. Pure — unit-testable. */
export function parseCustomAgentFile(
	raw: string,
	ext: '.md' | '.json',
	id: string,
	origin: 'user' | 'workspace',
	sourceFile: string,
): CustomAgentProfile | undefined {
	let meta: Record<string, unknown> = {};
	let promptBody: string | undefined;

	if (ext === '.json') {
		try {
			const parsed = JSON.parse(raw);
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				return undefined;
			}
			meta = parsed as Record<string, unknown>;
			if (typeof meta.prompt === 'string') {
				promptBody = meta.prompt.trim();
			}
		} catch {
			return undefined;
		}
	} else {
		const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
		if (fm) {
			try {
				const parsedFm = parseYamlLite(fm[1]);
				if (parsedFm && typeof parsedFm === 'object' && !Array.isArray(parsedFm)) {
					meta = parsedFm as Record<string, unknown>;
				}
			} catch {
				// Ignore malformed frontmatter and still load body
			}
			promptBody = fm[2].trim() || (typeof meta.prompt === 'string' ? meta.prompt.trim() : undefined);
		} else {
			promptBody = raw.trim();
		}
	}

	const name = typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : id;
	const description = typeof meta.description === 'string' ? meta.description.trim() : '';

	return {
		id,
		name,
		description,
		origin,
		sourceFile,
		tools: asStringArray(meta.tools),
		excludedTools: asStringArray(meta.excludedTools),
		includeMcpJson: typeof meta.includeMcpJson === 'boolean' ? meta.includeMcpJson : true,
		includePowers: typeof meta.includePowers === 'boolean' ? meta.includePowers : true,
		resources: asStringArray(meta.resources),
		permissions: parseAgentPermissions(meta.permissions, sourceFile),
		prompt: promptBody || undefined,
		model: typeof meta.model === 'string' && meta.model.trim() ? meta.model.trim() : undefined,
		welcomeMessage: typeof meta.welcomeMessage === 'string' && meta.welcomeMessage.trim() ? meta.welcomeMessage.trim() : undefined,
	};
}

/**
 * Discovers Custom Agents from `~/.tarot/agents/` (`user`) and `.tarot/agents/` (`workspace`),
 * supporting nested folders (`team/planner.md` -> `team/planner`). Workspace wins over user on
 * duplicate IDs. Callers must gate workspace discovery on `vscode.workspace.isTrusted`.
 */
export class TarotCustomAgentService {
	getUserAgentsDir(): string {
		return path.join(os.homedir(), '.tarot', 'agents');
	}

	getWorkspaceAgentsDir(workspaceRoot: string): string {
		return path.join(workspaceRoot, '.tarot', 'agents');
	}

	async discover(workspaceRoot?: string): Promise<CustomAgentProfile[]> {
		const byId = new Map<string, CustomAgentProfile>();
		for (const b of BUILT_IN_AGENT_PROFILES) {
			byId.set(b.id.toLowerCase(), b);
		}
		for (const u of await this.readAgentsDir(this.getUserAgentsDir(), 'user')) {
			byId.set(u.id.toLowerCase(), u);
		}
		if (workspaceRoot) {
			for (const w of await this.readAgentsDir(this.getWorkspaceAgentsDir(workspaceRoot), 'workspace')) {
				byId.set(w.id.toLowerCase(), w);
			}
		}
		return [...byId.values()];
	}

	private async readAgentsDir(rootDir: string, origin: 'user' | 'workspace', prefix = ''): Promise<CustomAgentProfile[]> {
		let entries;
		try {
			entries = await fs.readdir(rootDir, { withFileTypes: true });
		} catch {
			return [];
		}

		const results: CustomAgentProfile[] = [];
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const fullPath = path.join(rootDir, entry.name);
			if (entry.isDirectory()) {
				const subPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
				results.push(...await this.readAgentsDir(fullPath, origin, subPrefix));
				continue;
			}
			const ext = path.extname(entry.name).toLowerCase();
			if (ext !== '.md' && ext !== '.json') {
				continue;
			}
			const stem = entry.name.slice(0, -ext.length);
			const id = prefix ? `${prefix}/${stem}` : stem;
			try {
				const raw = await fs.readFile(fullPath, 'utf8');
				const parsed = parseCustomAgentFile(raw, ext, id, origin, fullPath);
				if (parsed) {
					results.push(parsed);
				}
			} catch {
				// Skip unreadable file
			}
		}
		return results;
	}
}
