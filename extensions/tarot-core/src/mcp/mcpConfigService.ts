/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export type McpScope = 'workspace' | 'global';
export type McpTransport = 'stdio' | 'remote';

export interface McpServerConfig {
	readonly name: string;
	readonly scope: McpScope;
	readonly sourceFile: string;
	readonly transport: McpTransport;
	readonly enabled: boolean;
	/** Local stdio transport */
	readonly command?: string;
	readonly args?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	/** Remote HTTP/SSE transport */
	readonly url?: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly autoApprove?: readonly string[];
}

export interface ParsedMcpConfig {
	readonly servers: McpServerConfig[];
	readonly errors: readonly string[];
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (typeof v === 'string') {
			out[k] = v;
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** Parses `.tarot/settings/mcp.json` or `~/.tarot/settings/mcp.json`. Pure — unit-testable. */
export function parseMcpConfigJson(raw: unknown, sourceFile: string, scope: McpScope): ParsedMcpConfig {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return { servers: [], errors: [`${sourceFile}: root must be a JSON object.`] };
	}
	const root = raw as Record<string, unknown>;
	const map = root.mcpServers;
	if (map === undefined) {
		return { servers: [], errors: [] };
	}
	if (!map || typeof map !== 'object' || Array.isArray(map)) {
		return { servers: [], errors: [`${sourceFile}: "mcpServers" must be an object.`] };
	}

	const servers: McpServerConfig[] = [];
	const errors: string[] = [];

	for (const [name, entry] of Object.entries(map as Record<string, unknown>)) {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
			errors.push(`${sourceFile}: server "${name}" must be an object.`);
			continue;
		}
		const obj = entry as Record<string, unknown>;
		const command = typeof obj.command === 'string' && obj.command.trim() ? obj.command.trim() : undefined;
		const url = typeof obj.url === 'string' && obj.url.trim() ? obj.url.trim() : undefined;
		if (!command && !url) {
			errors.push(`${sourceFile}: server "${name}" must specify either "command" (stdio) or "url" (remote).`);
			continue;
		}
		const args = Array.isArray(obj.args)
			? obj.args.filter((a): a is string => typeof a === 'string')
			: undefined;
		const autoApprove = Array.isArray(obj.autoApprove)
			? obj.autoApprove.filter((a): a is string => typeof a === 'string')
			: undefined;
		const disabled = obj.disabled === true || obj.enabled === false;
		servers.push({
			name,
			scope,
			sourceFile,
			transport: url ? 'remote' : 'stdio',
			enabled: !disabled,
			command,
			args,
			env: asStringRecord(obj.env),
			url,
			headers: asStringRecord(obj.headers),
			autoApprove,
		});
	}

	return { servers, errors };
}

/**
 * Formats discovered MCP servers into prompt context without ever leaking header/env secret values
 * (AGENTS.md §2d).
 */
export function formatMcpContext(servers: readonly McpServerConfig[]): string {
	if (servers.length === 0) {
		return 'No MCP servers configured.';
	}
	return servers.map(s => {
		const target = s.transport === 'remote'
			? `remote ${s.url}`
			: `stdio ${s.command}${s.args && s.args.length > 0 ? ' ' + s.args.join(' ') : ''}`;
		const status = s.enabled ? 'enabled' : 'disabled';
		const extras: string[] = [];
		if (s.headers && Object.keys(s.headers).length > 0) {
			extras.push(`headers: [${Object.keys(s.headers).join(', ')}]`);
		}
		if (s.env && Object.keys(s.env).length > 0) {
			extras.push(`env: [${Object.keys(s.env).join(', ')}]`);
		}
		return `- ${s.name} (${s.scope}, ${status}): ${target}${extras.length > 0 ? ' · ' + extras.join(' · ') : ''}`;
	}).join('\n');
}

/**
 * Discovers MCP server configurations from `~/.tarot/settings/mcp.json` (global) and
 * `.tarot/settings/mcp.json` (workspace — wins on duplicate names).
 */
export class TarotMcpConfigService {
	getGlobalMcpConfigPath(): string {
		return path.join(os.homedir(), '.tarot', 'settings', 'mcp.json');
	}

	getWorkspaceMcpConfigPath(workspaceRoot: string): string {
		return path.join(workspaceRoot, '.tarot', 'settings', 'mcp.json');
	}

	/**
	 * `trusted` is mandatory (TD-16, AGENTS.md §2d): workspace `.tarot/settings/mcp.json` is never
	 * read unless `trusted === true`, even if a caller passes a real `workspaceRoot`.
	 */
	async discover(
		workspaceRoot: string | undefined,
		trusted: boolean,
		extraPowerServers?: readonly McpServerConfig[],
	): Promise<{
		readonly servers: McpServerConfig[];
		readonly errors: readonly string[];
	}> {
		const byName = new Map<string, McpServerConfig>();
		const errors: string[] = [];

		const globalRes = await this.readFile(this.getGlobalMcpConfigPath(), 'global');
		errors.push(...globalRes.errors);
		for (const s of globalRes.servers) {
			byName.set(s.name, s);
		}

		for (const s of extraPowerServers ?? []) {
			byName.set(s.name, s);
		}

		if (workspaceRoot && trusted) {
			const wsRes = await this.readFile(this.getWorkspaceMcpConfigPath(workspaceRoot), 'workspace');
			errors.push(...wsRes.errors);
			for (const s of wsRes.servers) {
				byName.set(s.name, s);
			}
		}

		return {
			servers: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
			errors,
		};
	}

	private async readFile(filePath: string, scope: McpScope): Promise<ParsedMcpConfig> {
		let text: string;
		try {
			text = await fs.readFile(filePath, 'utf8');
		} catch {
			return { servers: [], errors: [] };
		}
		try {
			return parseMcpConfigJson(JSON.parse(text), filePath, scope);
		} catch (err) {
			return { servers: [], errors: [`${filePath}: ${err instanceof Error ? err.message : String(err)}`] };
		}
	}
}
