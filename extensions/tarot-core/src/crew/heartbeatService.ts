/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execSimple, resolveBinaryPath } from '../agents/processRunner';
import { runHookCommand } from '../hooks/hookRunner';

export type HeartbeatCheckKind = 'git-status' | 'git-branch' | 'command';

export interface HeartbeatCheckConfig {
	readonly id: string;
	readonly name: string;
	readonly kind: HeartbeatCheckKind;
	readonly command?: string;
}

export interface HeartbeatConfig {
	readonly enabled: boolean;
	readonly intervalSec: number;
	readonly checks: readonly HeartbeatCheckConfig[];
}

export interface HeartbeatCheckResult {
	readonly checkId: string;
	readonly name: string;
	readonly status: 'ok' | 'alert' | 'error';
	readonly summary: string;
}

export interface HeartbeatTickRecord {
	readonly timestamp: string;
	readonly status: 'ok' | 'alert' | 'error';
	readonly results: readonly HeartbeatCheckResult[];
}

export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
	enabled: false,
	intervalSec: 300,
	checks: [
		{ id: 'git-status', name: 'Git Working Tree', kind: 'git-status' },
		{ id: 'git-branch', name: 'Git Branch & Upstream', kind: 'git-branch' },
	],
};

export function parseHeartbeatConfig(raw: unknown): HeartbeatConfig {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return DEFAULT_HEARTBEAT_CONFIG;
	}
	const obj = raw as Record<string, unknown>;
	const enabled = obj.enabled === true;
	const rawInterval = typeof obj.intervalSec === 'number' && Number.isFinite(obj.intervalSec)
		? Math.floor(obj.intervalSec)
		: 300;
	const intervalSec = Math.max(30, Math.min(86400, rawInterval));
	const checks: HeartbeatCheckConfig[] = [];
	if (Array.isArray(obj.checks)) {
		for (const item of obj.checks) {
			if (!item || typeof item !== 'object') {
				continue;
			}
			const c = item as Record<string, unknown>;
			const id = typeof c.id === 'string' && c.id.trim() ? c.id.trim() : undefined;
			const name = typeof c.name === 'string' && c.name.trim() ? c.name.trim() : id;
			const kind = c.kind === 'git-status' || c.kind === 'git-branch' || c.kind === 'command' ? c.kind : undefined;
			if (!id || !name || !kind) {
				continue;
			}
			checks.push({
				id,
				name,
				kind,
				command: typeof c.command === 'string' && c.command.trim() ? c.command.trim() : undefined,
			});
		}
	}
	return {
		enabled,
		intervalSec,
		checks: checks.length > 0 ? checks : DEFAULT_HEARTBEAT_CONFIG.checks,
	};
}

/**
 * Pure Node.js Heartbeat Daemon service for Tarot Crew (Fase 5).
 * Reads `.tarot/crew/heartbeat.json`, runs periodic non-overlapping health checks (git status,
 * branch/upstream drift, or policy-approved read-only commands), and appends tick records to
 * `.tarot/crew/heartbeats/heartbeat-YYYY-MM-DD.jsonl`.
 */
export class TarotHeartbeatService {
	private timer: NodeJS.Timeout | undefined;
	private runningTick = false;
	private lastTick: HeartbeatTickRecord | undefined;
	private lastAlertSignature = '';

	getConfigPath(workspaceRoot: string): string {
		return path.join(workspaceRoot, '.tarot', 'crew', 'heartbeat.json');
	}

	getLogsDir(workspaceRoot: string): string {
		return path.join(workspaceRoot, '.tarot', 'crew', 'heartbeats');
	}

	isRunning(): boolean {
		return this.timer !== undefined;
	}

	getLastTick(): HeartbeatTickRecord | undefined {
		return this.lastTick;
	}

	async loadConfig(workspaceRoot: string): Promise<HeartbeatConfig> {
		try {
			const raw = JSON.parse(await fs.readFile(this.getConfigPath(workspaceRoot), 'utf8'));
			return parseHeartbeatConfig(raw);
		} catch {
			return DEFAULT_HEARTBEAT_CONFIG;
		}
	}

	async ensureConfigFile(workspaceRoot: string): Promise<string> {
		const configPath = this.getConfigPath(workspaceRoot);
		await fs.mkdir(path.dirname(configPath), { recursive: true });
		try {
			await fs.access(configPath);
		} catch {
			await fs.writeFile(configPath, JSON.stringify(DEFAULT_HEARTBEAT_CONFIG, null, 2) + '\n', 'utf8');
		}
		return configPath;
	}

	async runOnce(
		workspaceRoot: string,
		options?: {
			readonly checkCommandAllowed?: (command: string) => Promise<boolean>;
			readonly onAlert?: (record: HeartbeatTickRecord) => void | Promise<void>;
		},
	): Promise<HeartbeatTickRecord> {
		const config = await this.loadConfig(workspaceRoot);
		const results: HeartbeatCheckResult[] = [];

		for (const check of config.checks) {
			results.push(await this.executeCheck(workspaceRoot, check, options?.checkCommandAllowed));
		}

		const overall: HeartbeatTickRecord['status'] = results.some(r => r.status === 'error')
			? 'error'
			: (results.some(r => r.status === 'alert') ? 'alert' : 'ok');

		const record: HeartbeatTickRecord = {
			timestamp: new Date().toISOString(),
			status: overall,
			results,
		};
		this.lastTick = record;

		const logsDir = this.getLogsDir(workspaceRoot);
		await fs.mkdir(logsDir, { recursive: true });
		const logFile = path.join(logsDir, `heartbeat-${record.timestamp.slice(0, 10)}.jsonl`);
		await fs.appendFile(logFile, JSON.stringify(record) + '\n', 'utf8');

		if (overall !== 'ok') {
			const sig = results.filter(r => r.status !== 'ok').map(r => `${r.checkId}:${r.summary}`).join('|');
			if (sig !== this.lastAlertSignature) {
				this.lastAlertSignature = sig;
				await options?.onAlert?.(record);
			}
		} else {
			this.lastAlertSignature = '';
		}

		return record;
	}

	private async executeCheck(
		workspaceRoot: string,
		check: HeartbeatCheckConfig,
		checkCommandAllowed?: (command: string) => Promise<boolean>,
	): Promise<HeartbeatCheckResult> {
		if (check.kind === 'git-status') {
			const git = await resolveBinaryPath('git');
			if (!git) {
				return { checkId: check.id, name: check.name, status: 'error', summary: 'git not found on PATH' };
			}
			const res = await execSimple(git, ['-C', workspaceRoot, 'status', '--porcelain'], 8_000);
			if (res.exitCode !== 0) {
				return { checkId: check.id, name: check.name, status: 'error', summary: res.stderr.trim() || 'git status failed' };
			}
			const changed = res.stdout.split(/\r?\n/).filter(l => l.trim().length > 0).length;
			return changed > 0
				? { checkId: check.id, name: check.name, status: 'alert', summary: `${changed} uncommitted file(s)` }
				: { checkId: check.id, name: check.name, status: 'ok', summary: 'Clean working tree' };
		}

		if (check.kind === 'git-branch') {
			const git = await resolveBinaryPath('git');
			if (!git) {
				return { checkId: check.id, name: check.name, status: 'error', summary: 'git not found on PATH' };
			}
			const res = await execSimple(git, ['-C', workspaceRoot, 'status', '-sb'], 8_000);
			if (res.exitCode !== 0) {
				return { checkId: check.id, name: check.name, status: 'error', summary: res.stderr.trim() || 'git branch check failed' };
			}
			const header = res.stdout.split(/\r?\n/)[0]?.trim() || 'unknown';
			const behind = header.includes('behind');
			return behind
				? { checkId: check.id, name: check.name, status: 'alert', summary: header }
				: { checkId: check.id, name: check.name, status: 'ok', summary: header };
		}

		if (check.kind === 'command' && check.command) {
			if (checkCommandAllowed) {
				const allowed = await checkCommandAllowed(check.command);
				if (!allowed) {
					return { checkId: check.id, name: check.name, status: 'error', summary: 'Denied by Tarot permissions policy' };
				}
			}
			const res = await runHookCommand(
				check.command,
				{ hook_event_name: 'Stop', cwd: workspaceRoot, session_id: `heartbeat-${check.id}` },
				15,
			);
			if (res.kind === 'ok') {
				const summary = res.stdout.trim().split(/\r?\n/)[0]?.slice(0, 160) || 'ok';
				return { checkId: check.id, name: check.name, status: 'ok', summary };
			}
			const errSummary = res.kind === 'timeout'
				? 'Command timed out after 15s'
				: (res.stderr.trim().split(/\r?\n/)[0]?.slice(0, 160) || `exit ${res.kind === 'warn' ? (res.exitCode ?? 'error') : 2}`);
			return { checkId: check.id, name: check.name, status: 'alert', summary: errSummary };
		}

		return { checkId: check.id, name: check.name, status: 'error', summary: 'Invalid heartbeat check configuration' };
	}

	start(
		workspaceRoot: string,
		intervalSec: number,
		callbacks?: {
			readonly checkCommandAllowed?: (command: string) => Promise<boolean>;
			readonly onTick?: (record: HeartbeatTickRecord) => void;
			readonly onAlert?: (record: HeartbeatTickRecord) => void | Promise<void>;
		},
	): void {
		this.stop();
		const ms = Math.max(30, intervalSec) * 1000;
		this.timer = setInterval(() => {
			if (this.runningTick) {
				return;
			}
			this.runningTick = true;
			void this.runOnce(workspaceRoot, {
				checkCommandAllowed: callbacks?.checkCommandAllowed,
				onAlert: callbacks?.onAlert,
			}).then(rec => {
				callbacks?.onTick?.(rec);
			}).catch(() => undefined).finally(() => {
				this.runningTick = false;
			});
		}, ms);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	dispose(): void {
		this.stop();
	}
}
