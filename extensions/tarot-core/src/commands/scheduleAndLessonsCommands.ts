/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentRuntimeManager } from '../agents/runtimeManager';
import { TarotSessionStore } from '../agents/sessionStore';
import { TarotCheckpointService } from '../checkpoints/checkpointService';
import { runHookCommand } from '../hooks/hookRunner';
import { TarotPermissionsService } from '../permissions/permissionsService';
import { computeJitterMs, isValidCronExpression, matchesCronAt } from '../schedule/cronParser';
import { ScheduledJobDefinition, TarotScheduleService } from '../schedule/scheduleService';
import { TarotSkillsService } from '../skills/skillsService';
import { auditSteeringDocuments, promoteLessonToSkill, saveLessonToSteering } from '../steering/lessonsService';
import { TarotSteeringService } from '../steering/steeringService';
import { SessionsTreeProvider } from '../views/sessionsView';
import { SteeringTreeProvider } from '../views/tarotSidebarViews';

export interface ScheduleAndLessonsDeps {
	readonly scheduleService: TarotScheduleService;
	readonly runtimeManager: AgentRuntimeManager;
	readonly sessionStore: TarotSessionStore;
	readonly checkpointService: TarotCheckpointService;
	readonly permissionsService: TarotPermissionsService;
	readonly steeringService: TarotSteeringService;
	readonly skillsService: TarotSkillsService;
	readonly steeringProvider: SteeringTreeProvider;
	readonly sessionsProvider: SessionsTreeProvider;
	readonly ensureWorkspaceFolder: () => Promise<string | undefined>;
	readonly outputChannel: vscode.OutputChannel;
}

export function registerScheduleAndLessonsCommands(deps: ScheduleAndLessonsDeps): vscode.Disposable[] {
	const inFlightJobs = new Set<string>();
	const lastRunMinuteByJob = new Map<string, string>();
	const jitterTimers = new Set<NodeJS.Timeout>();

	const executeScheduledJob = async (root: string, job: ScheduledJobDefinition): Promise<void> => {
		if (!vscode.workspace.isTrusted) {
			return;
		}
		if (inFlightJobs.has(job.id)) {
			return;
		}
		inFlightJobs.add(job.id);
		const startedAt = new Date().toISOString();
		try {
			if (job.action.type === 'command' && job.action.command) {
				const evalRes = await deps.permissionsService.evaluateShellCommand(job.action.command, { headless: true });
				if (evalRes.decision.effect === 'deny') {
					const reason = evalRes.decision.reason ?? vscode.l10n.t('Command denied by permissions policy.');
					const { digestPath } = await deps.scheduleService.recordRunAndDigest(root, {
						jobId: job.id,
						jobName: job.name,
						startedAt,
						finishedAt: new Date().toISOString(),
						status: 'denied',
						actionType: 'command',
						output: '',
						error: reason,
						tokensUsed: 0,
					});
					deps.outputChannel.appendLine(`[Schedule] Job "${job.name}" denied: ${reason} (digest: ${digestPath})`);
					return;
				}
				const res = await runHookCommand(
					job.action.command,
					{ hook_event_name: 'Stop', cwd: root, session_id: `schedule-${job.id}` },
					job.timeoutSec,
				);
				const status = res.kind === 'ok' ? 'ok' : (res.kind === 'timeout' ? 'timeout' : 'failed');
				const stdoutText = res.kind === 'ok' ? res.stdout : '';
				const errText = res.kind === 'ok'
					? undefined
					: (res.kind === 'timeout'
						? `Command timed out after ${job.timeoutSec}s.`
						: (res.stderr || (res.kind === 'warn' ? `Exit code ${res.exitCode ?? 'unknown'}` : 'Blocked (exit 2)')));
				const { digestPath } = await deps.scheduleService.recordRunAndDigest(root, {
					jobId: job.id,
					jobName: job.name,
					startedAt,
					finishedAt: new Date().toISOString(),
					status,
					actionType: 'command',
					output: stdoutText,
					error: errText,
					tokensUsed: 0,
				});
				deps.outputChannel.appendLine(`[Schedule] Command job "${job.name}" finished (${status}, 0 tokens). Digest: ${digestPath}`);
				const openLabel = vscode.l10n.t('Open Digest');
				void vscode.window.showInformationMessage(
					vscode.l10n.t('Scheduled job "{0}" finished ({1}).', job.name, status),
					openLabel,
				).then(choice => {
					if (choice === openLabel) {
						void vscode.workspace.openTextDocument(digestPath).then(doc => vscode.window.showTextDocument(doc));
					}
				});
				return;
			}

			// Agent job: runs in its own isolated session with checkpoint and digest
			const agentId = job.action.agent ?? deps.runtimeManager.getActiveAgentId();
			const adapter = deps.runtimeManager.getAdapter(agentId) ?? deps.runtimeManager.getAdapter();
			if (!adapter) {
				await deps.scheduleService.recordRunAndDigest(root, {
					jobId: job.id,
					jobName: job.name,
					startedAt,
					finishedAt: new Date().toISOString(),
					status: 'failed',
					actionType: 'agent',
					output: '',
					error: `No agent adapter available for "${agentId}".`,
					tokensUsed: 0,
				});
				return;
			}

			const session = deps.sessionStore.createSession(adapter.id, 'vibe', 'acceptFileChanges');
			session.title = `⏰ ${job.name}`;
			await deps.sessionStore.appendMessage(session, {
				role: 'user',
				mode: 'vibe',
				content: job.action.prompt ?? '',
			});
			const checkpointId = await deps.checkpointService.createCheckpoint(root, session.id);

			let output = '';
			let totalTokens = 0;
			let hadError = false;
			const cts = new vscode.CancellationTokenSource();
			try {
				await adapter.run(
					{
						prompt: job.action.prompt ?? '',
						mode: 'vibe',
						autonomy: 'acceptFileChanges',
						cwd: root,
						timeoutMs: job.timeoutSec * 1000,
					},
					ev => {
						if (ev.type === 'text' && ev.content) {
							output += ev.content;
						} else if (ev.type === 'error' && ev.content) {
							hadError = true;
							output += `\n[Error] ${ev.content}`;
						}
						if (typeof ev.metadata?.totalTokens === 'number') {
							totalTokens = ev.metadata.totalTokens;
						}
					},
					cts.token,
				);
			} finally {
				cts.dispose();
			}

			await deps.sessionStore.appendMessage(session, {
				role: 'assistant',
				agentId: adapter.id,
				mode: 'vibe',
				content: output.trim() || '(no output)',
				checkpointId,
				totalTokens: totalTokens || undefined,
			});
			deps.sessionsProvider.refresh();

			const status = hadError ? 'failed' : 'ok';
			const { digestPath } = await deps.scheduleService.recordRunAndDigest(root, {
				jobId: job.id,
				jobName: job.name,
				startedAt,
				finishedAt: new Date().toISOString(),
				status,
				actionType: 'agent',
				sessionId: session.id,
				checkpointId,
				output: output.trim(),
				error: hadError ? 'Agent reported an error during scheduled run.' : undefined,
				tokensUsed: totalTokens,
			});
			deps.outputChannel.appendLine(`[Schedule] Agent job "${job.name}" finished (${status}, session ${session.id}). Digest: ${digestPath}`);
			const openLabel = vscode.l10n.t('Open Digest');
			void vscode.window.showInformationMessage(
				vscode.l10n.t('Scheduled agent job "{0}" finished ({1}).', job.name, status),
				openLabel,
			).then(choice => {
				if (choice === openLabel) {
					void vscode.workspace.openTextDocument(digestPath).then(doc => vscode.window.showTextDocument(doc));
				}
			});
		} finally {
			inFlightJobs.delete(job.id);
		}
	};

	// Background 60-second cron tick (strictly Workspace Trust gated)
	const tickInterval = setInterval(() => {
		if (!vscode.workspace.isTrusted) {
			return;
		}
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root) {
			return;
		}
		const now = new Date();
		const minuteKey = now.toISOString().slice(0, 16);
		void deps.scheduleService.discover(root).then(({ jobs }) => {
			for (const job of jobs) {
				if (!job.enabled || lastRunMinuteByJob.get(job.id) === minuteKey) {
					continue;
				}
				if (!matchesCronAt(job.cron, now, { timezone: job.timezone, excludeDates: job.excludeDates })) {
					continue;
				}
				lastRunMinuteByJob.set(job.id, minuteKey);
				const delayMs = computeJitterMs(job.jitterSec);
				if (delayMs > 0) {
					const t = setTimeout(() => {
						jitterTimers.delete(t);
						void executeScheduledJob(root, job);
					}, delayMs);
					jitterTimers.add(t);
				} else {
					void executeScheduledJob(root, job);
				}
			}
		}).catch(() => undefined);
	}, 60_000);

	const schedulerDisposable = new vscode.Disposable(() => {
		clearInterval(tickInterval);
		for (const t of jitterTimers) {
			clearTimeout(t);
		}
		jitterTimers.clear();
	});

	return [
		schedulerDisposable,

		vscode.commands.registerCommand('tarot.schedule.open', async () => {
			const picked = await vscode.window.showQuickPick(
				[
					{ label: vscode.l10n.t('$(add) Create Scheduled Cron Job'), command: 'tarot.schedule.create' },
					{ label: vscode.l10n.t('$(play) Run Scheduled Job Now'), command: 'tarot.schedule.runNow' },
					{ label: vscode.l10n.t('$(book) View Latest Digests'), command: 'tarot.schedule.viewDigest' },
				],
				{ title: vscode.l10n.t('Tarot IDE — Schedule & Digests') },
			);
			if (picked) {
				await vscode.commands.executeCommand(picked.command);
			}
		}),

		vscode.commands.registerCommand('tarot.schedule.create', async () => {
			const root = await deps.ensureWorkspaceFolder();
			if (!root) {
				return;
			}
			const name = await vscode.window.showInputBox({
				title: vscode.l10n.t('New Scheduled Job — Name'),
				prompt: vscode.l10n.t('e.g. Nightly Security & Test Digest'),
			});
			if (!name?.trim()) {
				return;
			}
			const cron = await vscode.window.showInputBox({
				title: vscode.l10n.t('Cron Expression (5 fields: min hour dom mon dow)'),
				value: '0 9 * * 1-5',
				validateInput: v => (isValidCronExpression(v) ? undefined : vscode.l10n.t('Enter a valid 5-field cron expression (e.g. 0 9 * * 1-5).')),
			});
			if (!cron?.trim()) {
				return;
			}
			const kindPick = await vscode.window.showQuickPick(
				[
					{ label: vscode.l10n.t('Deterministic Command (0 tokens)'), actionKind: 'command' as const },
					{ label: vscode.l10n.t('Agent Prompt (runs in isolated session with checkpoint)'), actionKind: 'agent' as const },
				],
				{ title: vscode.l10n.t('Scheduled Job Action Type') },
			);
			if (!kindPick) {
				return;
			}
			const body = await vscode.window.showInputBox({
				title: kindPick.actionKind === 'command' ? vscode.l10n.t('Shell Command') : vscode.l10n.t('Agent Prompt'),
				placeHolder: kindPick.actionKind === 'command' ? 'pnpm test' : 'Revise os commits recentes e gere um digest de riscos.',
			});
			if (!body?.trim()) {
				return;
			}
			const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'job';
			const filePath = await deps.scheduleService.createJobFile(
				deps.scheduleService.getWorkspaceSchedulesDir(root),
				slug,
				{ name: name.trim(), cron: cron.trim(), actionType: kindPick.actionKind, commandOrPrompt: body.trim() },
			);
			const doc = await vscode.workspace.openTextDocument(filePath);
			await vscode.window.showTextDocument(doc);
		}),

		vscode.commands.registerCommand('tarot.schedule.runNow', async () => {
			if (!vscode.workspace.isTrusted) {
				vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace before running scheduled jobs.'));
				return;
			}
			const root = await deps.ensureWorkspaceFolder();
			if (!root) {
				return;
			}
			const { jobs } = await deps.scheduleService.discover(root);
			if (jobs.length === 0) {
				vscode.window.showInformationMessage(vscode.l10n.t('No scheduled jobs found in .tarot/schedules/ or ~/.tarot/schedules/.'));
				return;
			}
			const picked = await vscode.window.showQuickPick(
				jobs.map(j => ({
					label: j.name,
					description: `${j.cron} · ${j.action.type}`,
					detail: j.action.command ?? j.action.prompt,
					job: j,
				})),
				{ title: vscode.l10n.t('Run Scheduled Job Now') },
			);
			if (picked) {
				await executeScheduledJob(root, picked.job);
			}
		}),

		vscode.commands.registerCommand('tarot.schedule.viewDigest', async () => {
			const root = await deps.ensureWorkspaceFolder();
			if (!root) {
				return;
			}
			const digests = await deps.scheduleService.listDigests(root);
			if (digests.length === 0) {
				vscode.window.showInformationMessage(vscode.l10n.t('No scheduled job digests recorded yet.'));
				return;
			}
			const picked = await vscode.window.showQuickPick(
				digests.map(d => ({ label: path.basename(d), filePath: d })),
				{ title: vscode.l10n.t('Open Scheduled Job Digest') },
			);
			if (picked) {
				const doc = await vscode.workspace.openTextDocument(picked.filePath);
				await vscode.window.showTextDocument(doc);
			}
		}),

		vscode.commands.registerCommand('tarot.lessons.record', async () => {
			const root = await deps.ensureWorkspaceFolder();
			if (!root) {
				return;
			}
			const ruleText = await vscode.window.showInputBox({
				title: vscode.l10n.t('Record Learned Lesson (.tarot/steering/)'),
				prompt: vscode.l10n.t('Enter the correction or rule agents must follow (e.g. "Always use pnpm, not npm")'),
			});
			if (!ruleText?.trim()) {
				return;
			}
			const saved = await saveLessonToSteering(deps.steeringService.getWorkspaceSteeringDir(root), ruleText.trim());
			deps.steeringProvider.refresh();
			const doc = await vscode.workspace.openTextDocument(saved.filePath);
			await vscode.window.showTextDocument(doc);
			vscode.window.showInformationMessage(vscode.l10n.t('Saved editable lesson to {0}.', path.basename(saved.filePath)));
		}),

		vscode.commands.registerCommand('tarot.lessons.promoteToSkill', async () => {
			if (!vscode.workspace.isTrusted) {
				vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace before promoting lessons to skills.'));
				return;
			}
			const root = await deps.ensureWorkspaceFolder();
			if (!root) {
				return;
			}
			const docs = await deps.steeringService.discover(root);
			if (docs.length === 0) {
				vscode.window.showInformationMessage(vscode.l10n.t('No steering documents found to promote.'));
				return;
			}
			const picked = await vscode.window.showQuickPick(
				docs.map(d => ({ label: d.fileName, description: d.scope, doc: d })),
				{ title: vscode.l10n.t('Promote Steering Lesson to Agent Skill') },
			);
			if (!picked) {
				return;
			}
			const skillName = await vscode.window.showInputBox({
				title: vscode.l10n.t('Skill Name'),
				value: picked.doc.id.replace(/^lesson-/, ''),
			});
			if (!skillName?.trim()) {
				return;
			}
			const promoted = await promoteLessonToSkill(
				deps.skillsService.getWorkspaceSkillsDir(root),
				skillName.trim(),
				picked.doc.description || vscode.l10n.t('Promoted from steering doc {0}', picked.doc.fileName),
				picked.doc.body || picked.doc.raw,
			);
			const doc = await vscode.workspace.openTextDocument(promoted.skillFilePath);
			await vscode.window.showTextDocument(doc);
			vscode.window.showInformationMessage(vscode.l10n.t('Promoted to skill at {0}.', promoted.skillFilePath));
		}),

		vscode.commands.registerCommand('tarot.steering.audit', async () => {
			if (!vscode.workspace.isTrusted) {
				vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace before auditing Steering documents.'));
				return;
			}
			const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			const docs = await deps.steeringService.discover(root);
			if (docs.length === 0) {
				vscode.window.showInformationMessage(vscode.l10n.t('No Steering documents found to audit.'));
				return;
			}
			const findings = auditSteeringDocuments(docs);
			if (findings.length === 0) {
				vscode.window.showInformationMessage(vscode.l10n.t('Steering audit passed: {0} document(s) checked, no redundant or obsolete rules found.', docs.length));
				return;
			}
			const picked = await vscode.window.showQuickPick(
				findings.map(f => ({
					label: `${f.severity === 'warning' ? '$(warning)' : '$(info)'} ${f.fileName}`,
					description: f.kind,
					detail: f.message,
					finding: f,
				})),
				{ title: vscode.l10n.t('Audit / Prune Steering — {0} finding(s)', findings.length) },
			);
			if (!picked) {
				return;
			}
			const openAction = vscode.l10n.t('Open File');
			const pruneAction = vscode.l10n.t('Prune (Delete File)');
			const choice = await vscode.window.showWarningMessage(
				picked.finding.message,
				openAction,
				pruneAction,
			);
			if (choice === openAction) {
				const doc = await vscode.workspace.openTextDocument(picked.finding.filePath);
				await vscode.window.showTextDocument(doc);
			} else if (choice === pruneAction) {
				await fs.rm(picked.finding.filePath, { force: true });
				deps.steeringProvider.refresh();
				vscode.window.showInformationMessage(vscode.l10n.t('Pruned steering file {0}.', picked.finding.fileName));
			}
		}),
	];
}
