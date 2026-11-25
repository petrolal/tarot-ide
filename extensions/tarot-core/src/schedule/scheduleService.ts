/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isValidCronExpression } from './cronParser';

export type ScheduleScope = 'workspace' | 'global';
export type ScheduleActionKind = 'command' | 'agent';

export interface ScheduledJobDefinition {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly enabled: boolean;
	readonly cron: string;
	readonly timezone?: string;
	readonly timeoutSec: number;
	readonly jitterSec: number;
	readonly excludeDates: readonly string[];
	readonly action: {
		readonly type: ScheduleActionKind;
		readonly command?: string;
		readonly prompt?: string;
		readonly agent?: string;
	};
	readonly scope: ScheduleScope;
	readonly sourceFile: string;
}

export interface ScheduledJobRunRecord {
	readonly runId: string;
	readonly jobId: string;
	readonly jobName: string;
	readonly startedAt: string;
	readonly finishedAt: string;
	readonly status: 'ok' | 'failed' | 'denied' | 'timeout';
	readonly actionType: ScheduleActionKind;
	readonly sessionId?: string;
	readonly checkpointId?: string;
	readonly output: string;
	readonly error?: string;
	readonly tokensUsed: number;
}

export interface ScheduleDiscoveryResult {
	readonly jobs: ScheduledJobDefinition[];
	readonly errors: string[];
}

export function formatRunDigestMarkdown(record: ScheduledJobRunRecord): string {
	const lines: string[] = [
		`# Scheduled Job Digest — ${record.jobName}`,
		'',
		`- **Job ID**: \`${record.jobId}\``,
		`- **Run ID**: \`${record.runId}\``,
		`- **Status**: \`${record.status}\``,
		`- **Action**: \`${record.actionType}\`${record.actionType === 'command' ? ' (0 tokens)' : ''}`,
		`- **Started**: ${record.startedAt}`,
		`- **Finished**: ${record.finishedAt}`,
	];
	if (record.sessionId) {
		lines.push(`- **Session**: \`${record.sessionId}\``);
	}
	if (record.checkpointId) {
		lines.push(`- **Checkpoint**: \`${record.checkpointId}\``);
	}
	if (record.error) {
		lines.push('', '## Error', '', '```text', record.error, '```');
	}
	lines.push('', '## Output', '', record.output ? record.output : '_(no output)_', '');
	return lines.join('\n');
}

/**
 * Pure Node.js discovery & persistence service for M3.10 Scheduled Jobs & Digests.
 * Reads `.tarot/schedules/*.json` (workspace) and `~/.tarot/schedules/*.json` (global),
 * persists run logs to `.tarot/schedules/runs/` and readable digests to `.tarot/schedules/digests/`.
 */
export class TarotScheduleService {
	getWorkspaceSchedulesDir(workspaceRoot: string): string {
		return path.join(workspaceRoot, '.tarot', 'schedules');
	}

	getGlobalSchedulesDir(): string {
		return path.join(os.homedir(), '.tarot', 'schedules');
	}

	async discover(workspaceRoot?: string): Promise<ScheduleDiscoveryResult> {
		const jobs: ScheduledJobDefinition[] = [];
		const errors: string[] = [];

		const globalRes = await this.readDir(this.getGlobalSchedulesDir(), 'global');
		jobs.push(...globalRes.jobs);
		errors.push(...globalRes.errors);

		if (workspaceRoot) {
			const wsRes = await this.readDir(this.getWorkspaceSchedulesDir(workspaceRoot), 'workspace');
			jobs.push(...wsRes.jobs);
			errors.push(...wsRes.errors);
		}
		return { jobs, errors };
	}

	private async readDir(dirPath: string, scope: ScheduleScope): Promise<ScheduleDiscoveryResult> {
		let entries;
		try {
			entries = await fs.readdir(dirPath, { withFileTypes: true });
		} catch {
			return { jobs: [], errors: [] };
		}

		const jobs: ScheduledJobDefinition[] = [];
		const errors: string[] = [];
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith('.json')) {
				continue;
			}
			const filePath = path.join(dirPath, entry.name);
			try {
				const raw = JSON.parse(await fs.readFile(filePath, 'utf8')) as { jobs?: unknown[] } | Record<string, unknown>;
				const list = Array.isArray((raw as { jobs?: unknown[] }).jobs)
					? (raw as { jobs: unknown[] }).jobs
					: [raw];
				for (let idx = 0; idx < list.length; idx++) {
					const parsed = this.parseJob(list[idx], scope, filePath, idx);
					if (parsed.job) {
						jobs.push(parsed.job);
					} else if (parsed.error) {
						errors.push(`${filePath}: ${parsed.error}`);
					}
				}
			} catch (err) {
				errors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		return { jobs, errors };
	}

	private parseJob(
		raw: unknown,
		scope: ScheduleScope,
		sourceFile: string,
		index: number,
	): { job?: ScheduledJobDefinition; error?: string } {
		if (!raw || typeof raw !== 'object') {
			return { error: `Job #${index + 1} is not an object.` };
		}
		const r = raw as Record<string, unknown>;
		const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : undefined;
		const cron = typeof r.cron === 'string' ? r.cron.trim() : '';
		if (!name) {
			return { error: `Job #${index + 1} is missing "name".` };
		}
		if (!isValidCronExpression(cron)) {
			return { error: `Job "${name}" has invalid 5-field cron expression "${cron}".` };
		}
		const actionObj = r.action && typeof r.action === 'object' ? r.action as Record<string, unknown> : undefined;
		const actionType = actionObj?.type === 'command' || actionObj?.type === 'agent' ? actionObj.type : undefined;
		if (!actionType) {
			return { error: `Job "${name}" requires action.type ("command" | "agent").` };
		}
		if (actionType === 'command' && (typeof actionObj?.command !== 'string' || !actionObj.command.trim())) {
			return { error: `Job "${name}" with action.type "command" requires action.command.` };
		}
		if (actionType === 'agent' && (typeof actionObj?.prompt !== 'string' || !actionObj.prompt.trim())) {
			return { error: `Job "${name}" with action.type "agent" requires action.prompt.` };
		}
		const id = typeof r.id === 'string' && r.id.trim()
			? r.id.trim()
			: `${path.basename(sourceFile, '.json')}-${index + 1}`;
		const excludeDates = Array.isArray(r.excludeDates)
			? r.excludeDates.filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
			: [];
		const timeoutSec = typeof r.timeoutSec === 'number' && r.timeoutSec > 0 ? r.timeoutSec : 300;
		const jitterSec = typeof r.jitterSec === 'number' && r.jitterSec >= 0 ? r.jitterSec : 0;

		return {
			job: {
				id,
				name,
				description: typeof r.description === 'string' ? r.description : undefined,
				enabled: r.enabled !== false,
				cron,
				timezone: typeof r.timezone === 'string' && r.timezone.trim() ? r.timezone.trim() : undefined,
				timeoutSec,
				jitterSec,
				excludeDates,
				action: {
					type: actionType,
					command: typeof actionObj?.command === 'string' ? actionObj.command.trim() : undefined,
					prompt: typeof actionObj?.prompt === 'string' ? actionObj.prompt.trim() : undefined,
					agent: typeof actionObj?.agent === 'string' ? actionObj.agent.trim() : undefined,
				},
				scope,
				sourceFile,
			},
		};
	}

	async recordRunAndDigest(
		workspaceRoot: string,
		record: Omit<ScheduledJobRunRecord, 'runId'>,
	): Promise<{ readonly record: ScheduledJobRunRecord; readonly logPath: string; readonly digestPath: string }> {
		const runId = `sched-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
		const full: ScheduledJobRunRecord = { runId, ...record };
		const runsDir = path.join(this.getWorkspaceSchedulesDir(workspaceRoot), 'runs');
		const digestsDir = path.join(this.getWorkspaceSchedulesDir(workspaceRoot), 'digests');
		await fs.mkdir(runsDir, { recursive: true });
		await fs.mkdir(digestsDir, { recursive: true });

		const safeJobId = full.jobId.replace(/[^a-zA-Z0-9._-]+/g, '-');
		const logPath = path.join(runsDir, `${safeJobId}-${runId}.json`);
		const digestPath = path.join(digestsDir, `${safeJobId}-${runId}.md`);
		await fs.writeFile(logPath, JSON.stringify(full, null, 2), 'utf8');
		await fs.writeFile(digestPath, formatRunDigestMarkdown(full), 'utf8');
		return { record: full, logPath, digestPath };
	}

	async listDigests(workspaceRoot: string): Promise<string[]> {
		const digestsDir = path.join(this.getWorkspaceSchedulesDir(workspaceRoot), 'digests');
		try {
			const entries = await fs.readdir(digestsDir, { withFileTypes: true });
			return entries
				.filter(e => e.isFile() && e.name.endsWith('.md'))
				.map(e => path.join(digestsDir, e.name))
				.sort()
				.reverse();
		} catch {
			return [];
		}
	}

	async createJobFile(
		targetDir: string,
		slug: string,
		job: {
			readonly name: string;
			readonly cron: string;
			readonly timezone?: string;
			readonly actionType: ScheduleActionKind;
			readonly commandOrPrompt: string;
		},
	): Promise<string> {
		await fs.mkdir(targetDir, { recursive: true });
		const filePath = path.join(targetDir, `${slug}.json`);
		const payload = {
			version: 'v1',
			jobs: [
				{
					id: slug,
					name: job.name,
					enabled: true,
					cron: job.cron,
					timezone: job.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
					timeoutSec: 300,
					jitterSec: 15,
					excludeDates: [],
					action: job.actionType === 'command'
						? { type: 'command', command: job.commandOrPrompt }
						: { type: 'agent', prompt: job.commandOrPrompt },
				},
			],
		};
		await fs.writeFile(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
		return filePath;
	}
}
