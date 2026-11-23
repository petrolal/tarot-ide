/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

/**
 * Declarative preset catalog for Agent Client Protocol (ACP) CLIs (MIGRATION_PLAN.md M3.8b).
 * Adding support for a new ACP-compatible CLI only requires a catalog entry (or user entry in
 * `tarot.agents.custom` with `protocol: "acp"`) — no bespoke TypeScript adapter class needed.
 */
export interface AcpCatalogEntry {
	readonly id: string;
	readonly displayName: string;
	readonly binary: string;
	readonly acpArgs: readonly string[];
	readonly versionArgs: readonly string[];
	readonly installHint: string;
}

export const ACP_AGENT_CATALOG: readonly AcpCatalogEntry[] = [
	{
		id: 'agy-acp',
		displayName: 'Antigravity (ACP)',
		binary: 'agy',
		acpArgs: ['acp'],
		versionArgs: ['--version'],
		installHint: 'Install Antigravity CLI (agy) with ACP support.',
	},
	{
		id: 'kiro-cli',
		displayName: 'Kiro CLI (ACP)',
		binary: 'kiro-cli',
		acpArgs: ['acp'],
		versionArgs: ['--version'],
		installHint: 'Install kiro-cli and ensure it is on PATH.',
	},
	{
		id: 'opencode',
		displayName: 'OpenCode (ACP)',
		binary: 'opencode',
		acpArgs: ['acp'],
		versionArgs: ['--version'],
		installHint: 'Install opencode and ensure it is on PATH.',
	},
	{
		id: 'goose',
		displayName: 'Goose (ACP)',
		binary: 'goose',
		acpArgs: ['acp'],
		versionArgs: ['--version'],
		installHint: 'Install goose and ensure it is on PATH.',
	},
];

export function findAcpCatalogEntry(id: string): AcpCatalogEntry | undefined {
	return ACP_AGENT_CATALOG.find(e => e.id === id);
}
