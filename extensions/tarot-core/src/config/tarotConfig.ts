/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AgentId, CustomAgentConfig } from '../agents/types';

export interface TarotAgentPathsConfig {
	readonly claude: string;
	readonly codex: string;
	readonly agy: string;
}

export interface TarotConfig {
	readonly defaultAgent: AgentId | 'auto';
	readonly agentPaths: TarotAgentPathsConfig;
	readonly timeoutMs: number;
	readonly customAgents: readonly CustomAgentConfig[];
}

export function getTarotConfig(): TarotConfig {
	const cfg = vscode.workspace.getConfiguration('tarot');
	const rawPaths = cfg.get<Partial<TarotAgentPathsConfig>>('agents.paths', {});
	const rawCustom = cfg.get<readonly CustomAgentConfig[]>('agents.custom', []);

	return {
		defaultAgent: cfg.get<AgentId | 'auto'>('agents.default', 'auto'),
		agentPaths: {
			claude: (rawPaths.claude ?? '').trim(),
			codex: (rawPaths.codex ?? '').trim(),
			agy: (rawPaths.agy ?? '').trim(),
		},
		timeoutMs: Math.max(10_000, cfg.get<number>('agents.timeoutMs', 300_000)),
		customAgents: Array.isArray(rawCustom) ? rawCustom.filter(c => Boolean(c && c.id && c.binary)) : [],
	};
}
