/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { TarotCustomAgentService } from '../agents/customAgentService';
import { AgentRuntimeManager } from '../agents/runtimeManager';
import {
	CrewmateDefinition,
	CrewScope,
	markTaskDoneInMarkdown,
	parseTaskMarkdown,
	TarotCrewService,
} from '../crew/crewService';
import { TarotGitReviewService } from '../git/gitReviewService';
import { TarotScheduleService } from '../schedule/scheduleService';
import { TarotAgentPanelProvider } from '../views/agentPanelView';
import {
	CrewmatesTreeProvider,
	CrewmateTreeItem,
	CrewMemoryKnowledgeTreeProvider,
	CrewSchedulesTreeProvider,
	CrewTaskFileTreeItem,
	CrewTasksTreeProvider,
	KnowledgeSourceTreeItem,
	ScheduleJobTreeItem,
	TarotCrewmateDashboardPanel,
} from '../views/crewView';
import { getWorkspaceRoot } from '../views/tarotSidebarViews';

export interface CrewCommandDeps {
	readonly crewService: TarotCrewService;
	readonly customAgentService: TarotCustomAgentService;
	readonly scheduleService: TarotScheduleService;
	readonly runtimeManager: AgentRuntimeManager;
	readonly gitReviewService: TarotGitReviewService;
	readonly agentPanelProvider: TarotAgentPanelProvider;
	readonly crewmatesProvider: CrewmatesTreeProvider;
	readonly crewTasksProvider: CrewTasksTreeProvider;
	readonly crewMemoryKnowledgeProvider: CrewMemoryKnowledgeTreeProvider;
	readonly crewSchedulesProvider: CrewSchedulesTreeProvider;
	readonly ensureWorkspaceFolder: () => Promise<string | undefined>;
	readonly outputChannel: vscode.OutputChannel;
}

export function registerCrewCommands(deps: CrewCommandDeps): vscode.Disposable[] {
	const refreshAll = (): void => {
		deps.crewmatesProvider.refresh();
		deps.crewTasksProvider.refresh();
		deps.crewMemoryKnowledgeProvider.refresh();
		deps.crewSchedulesProvider.refresh();
	};

	const startCrewmateSession = async (crewmate: CrewmateDefinition): Promise<void> => {
		const root = vscode.workspace.isTrusted ? getWorkspaceRoot() : undefined;
		const crewContext = await deps.crewService.buildCrewContext(root, crewmate);
		await deps.crewService.appendLedgerEntry(crewmate, {
			kind: 'session',
			summary: `Sessão iniciada com ${crewmate.name} (${crewmate.role}).`,
			status: 'ok',
		});
		await deps.crewService.appendDailyHistory(root, `Sessão iniciada com Crewmate ${crewmate.name}.`);
		deps.agentPanelProvider.createNewSession('vibe');
		const kickoffPrompt = [
			`Você está atuando como o Crewmate **${crewmate.name}** (${crewmate.role}).`,
			crewmate.description ? `Descrição: ${crewmate.description}` : '',
			crewContext ? `\n${crewContext}\n` : '',
			'Confirme brevemente que assumiu o papel, resuma o contexto carregado e aguarde a próxima tarefa.',
		].filter(Boolean).join('\n');
		await deps.agentPanelProvider.runExternalPrompt(kickoffPrompt, 'vibe');
	};

	const dashboardPanel = new TarotCrewmateDashboardPanel({
		startSession: startCrewmateSession,
		openFile: async filePath => {
			const doc = await vscode.workspace.openTextDocument(filePath);
			await vscode.window.showTextDocument(doc);
		},
		appendNote: async (crewmate, note) => {
			const entry = await deps.crewService.appendLedgerEntry(crewmate, {
				kind: 'note',
				summary: note,
				status: 'info',
			});
			return entry;
		},
		toggleStar: async crewmate => {
			const next = await deps.crewService.toggleStar(crewmate);
			deps.crewmatesProvider.refresh();
			return next;
		},
		loadState: async crewmate => {
			const [memory, ledger] = await Promise.all([
				deps.crewService.readCrewmateMemory(crewmate),
				deps.crewService.readLedger(crewmate, 50),
			]);
			return { memory, ledger };
		},
	});

	return [
		dashboardPanel,

		vscode.commands.registerCommand('tarot.crew.createCrewmate', async () => {
			const name = await vscode.window.showInputBox({
				title: vscode.l10n.t('New Crewmate'),
				prompt: vscode.l10n.t('Enter a name for your persistent AI teammate (e.g. Atlas, Security Reviewer).'),
				placeHolder: 'Atlas',
			});
			if (!name?.trim()) {
				return;
			}
			const role = await vscode.window.showInputBox({
				title: vscode.l10n.t('Crewmate Role'),
				prompt: vscode.l10n.t('Define the role or specialty of this Crewmate.'),
				placeHolder: 'Release Engineer & QA Auditor',
			});
			if (role === undefined) {
				return;
			}
			const description = await vscode.window.showInputBox({
				title: vscode.l10n.t('Crewmate Description'),
				prompt: vscode.l10n.t('Optional short description of responsibilities.'),
			});
			if (description === undefined) {
				return;
			}

			const root = getWorkspaceRoot();
			const scopeItems: Array<{ label: string; scope: CrewScope; requiresTrust: boolean }> = [];
			if (root) {
				scopeItems.push({ label: vscode.l10n.t('Workspace (.tarot/crew/crewmates/)'), scope: 'workspace', requiresTrust: true });
			}
			scopeItems.push({ label: vscode.l10n.t('Global (~/.tarot/crew/crewmates/)'), scope: 'global', requiresTrust: false });
			const pickedScope = await vscode.window.showQuickPick(scopeItems, { title: vscode.l10n.t('Select Crewmate Scope') });
			if (!pickedScope) {
				return;
			}
			if (pickedScope.requiresTrust && !vscode.workspace.isTrusted) {
				vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace to create Crewmates under .tarot/crew/.'));
				return;
			}

			const profiles = await deps.customAgentService.discover(vscode.workspace.isTrusted ? root : undefined);
			const profilePick = await vscode.window.showQuickPick(
				[
					{ label: vscode.l10n.t('$(dash) None (use active agent)'), id: undefined as string | undefined },
					...profiles.map(p => ({ label: p.name, description: p.origin, id: p.id as string | undefined })),
				],
				{ title: vscode.l10n.t('Link Custom Agent Profile (Optional)') },
			);
			if (!profilePick) {
				return;
			}

			try {
				const created = await deps.crewService.createCrewmate({
					workspaceRoot: root,
					scope: pickedScope.scope,
					name,
					role,
					description,
					agentProfileId: profilePick.id,
				});
				deps.crewmatesProvider.refresh();
				await dashboardPanel.show(created);
			} catch (err) {
				vscode.window.showErrorMessage(vscode.l10n.t('Failed to create Crewmate: {0}', err instanceof Error ? err.message : String(err)));
			}
		}),

		vscode.commands.registerCommand('tarot.crew.openDashboard', async (item?: CrewmateTreeItem) => {
			let crewmate = item?.crewmate;
			if (!crewmate) {
				const root = vscode.workspace.isTrusted ? getWorkspaceRoot() : undefined;
				const all = await deps.crewService.discoverCrewmates(root);
				if (all.length === 0) {
					vscode.window.showInformationMessage(vscode.l10n.t('No Crewmates found. Create one first.'));
					return;
				}
				const picked = await vscode.window.showQuickPick(
					all.map(c => ({ label: c.name, description: `${c.role} · ${c.scope}`, crewmate: c })),
					{ title: vscode.l10n.t('Open Crewmate Dashboard') },
				);
				crewmate = picked?.crewmate;
			}
			if (crewmate) {
				await dashboardPanel.show(crewmate);
			}
		}),

		vscode.commands.registerCommand('tarot.crew.toggleStar', async (item?: CrewmateTreeItem) => {
			if (!item?.crewmate) {
				return;
			}
			await deps.crewService.toggleStar(item.crewmate);
			deps.crewmatesProvider.refresh();
		}),

		vscode.commands.registerCommand('tarot.crew.startSession', async (item?: CrewmateTreeItem) => {
			if (!item?.crewmate) {
				return;
			}
			await startCrewmateSession(item.crewmate);
		}),

		vscode.commands.registerCommand('tarot.crew.createTaskFile', async () => {
			if (!vscode.workspace.isTrusted) {
				vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace to create Crew task files.'));
				return;
			}
			const root = await deps.ensureWorkspaceFolder();
			if (!root) {
				return;
			}
			const title = await vscode.window.showInputBox({
				title: vscode.l10n.t('New Autonomous Task File (TASK.md)'),
				prompt: vscode.l10n.t('Enter a short title for the autonomous task specification.'),
				placeHolder: 'Refactor auth middleware',
			});
			if (!title?.trim()) {
				return;
			}
			try {
				const filePath = await deps.crewService.createTaskTemplate(root, title, title);
				deps.crewTasksProvider.refresh();
				const doc = await vscode.workspace.openTextDocument(filePath);
				await vscode.window.showTextDocument(doc);
			} catch (err) {
				vscode.window.showErrorMessage(vscode.l10n.t('Failed to create task file: {0}', err instanceof Error ? err.message : String(err)));
			}
		}),

		vscode.commands.registerCommand('tarot.crew.runTaskFile', async (item?: CrewTaskFileTreeItem) => {
			if (!vscode.workspace.isTrusted) {
				vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace to run autonomous Crew tasks.'));
				return;
			}
			const root = await deps.ensureWorkspaceFolder();
			if (!root) {
				return;
			}
			let taskFilePath = item?.taskFile.path;
			if (!taskFilePath) {
				const files = await deps.crewService.discoverTaskFiles(root);
				if (files.length === 0) {
					vscode.window.showInformationMessage(vscode.l10n.t('No TASK.md files found. Create one first.'));
					return;
				}
				const picked = await vscode.window.showQuickPick(
					files.map(f => ({ label: f.label, description: `${f.doneCount}/${f.totalCount}`, filePath: f.path })),
					{ title: vscode.l10n.t('Select Task File to Run Autonomously') },
				);
				taskFilePath = picked?.filePath;
			}
			if (!taskFilePath) {
				return;
			}

			const raw = await fs.readFile(taskFilePath, 'utf8');
			const tasks = parseTaskMarkdown(raw);
			const pending = tasks.filter(t => !t.done);
			if (pending.length === 0) {
				vscode.window.showInformationMessage(vscode.l10n.t('All tasks in {0} are already completed.', path.basename(taskFilePath)));
				return;
			}

			const crewmates = await deps.crewService.discoverCrewmates(root);
			const activeCrewmate = crewmates[0];
			const targetPath = taskFilePath;

			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: vscode.l10n.t('Tarot Crew Task Runner: {0}', path.basename(targetPath)),
					cancellable: true,
				},
				async (progress, token) => {
					let currentRaw = raw;
					let completedCount = 0;

					for (const task of pending) {
						if (token.isCancellationRequested) {
							break;
						}
						progress.report({ message: vscode.l10n.t('Task {0}/{1}: {2}', task.index, tasks.length, task.title) });
						deps.outputChannel.appendLine(`[Crew Task Runner] Starting task #${task.index}: ${task.title}`);

						const crewCtx = await deps.crewService.buildCrewContext(root, activeCrewmate, task.title);
						let passed = false;
						let lastFailure = '';

						const adapter = deps.runtimeManager.getAdapter();
						if (!adapter) {
							vscode.window.showWarningMessage(vscode.l10n.t('No local AI agent CLI available to run Crew tasks.'));
							break;
						}

						for (let attempt = 1; attempt <= 3; attempt++) {
							if (token.isCancellationRequested) {
								break;
							}
							const prompt = [
								`Você é o Tarot Crew Task Runner executando a tarefa #${task.index} de \`${path.relative(root, targetPath)}\`.`,
								`Tarefa: ${task.title}`,
								attempt > 1 ? `Tentativa ${attempt}/3. Falha anterior a corrigir:\n${lastFailure}` : '',
								crewCtx ? `\n${crewCtx}\n` : '',
								'Execute a tarefa de forma completa, valide com testes relevantes e responda com um resumo objetivo do que foi feito.',
							].filter(Boolean).join('\n\n');

							let hadError = false;
							let errorText = '';
							try {
								await adapter.run(
									{
										prompt,
										mode: 'vibe',
										autonomy: 'acceptFileChanges',
										cwd: root,
										systemContext: crewCtx,
										timeoutMs: 300_000,
									},
									ev => {
										if (ev.type === 'error' && ev.content) {
											hadError = true;
											errorText += ev.content;
										}
									},
									token,
								);
							} catch (err) {
								hadError = true;
								errorText = err instanceof Error ? err.message : String(err);
							}

							if (!hadError && !token.isCancellationRequested) {
								// Independent git diff verification summary
								const changed = await deps.gitReviewService.getChangedFiles(root);
								deps.outputChannel.appendLine(`[Crew Task Runner] Task #${task.index} attempt ${attempt} succeeded (${changed.length} changed files).`);
								passed = true;
								break;
							}
							lastFailure = errorText.slice(-500) || 'Task execution failed.';
							deps.outputChannel.appendLine(`[Crew Task Runner] Task #${task.index} attempt ${attempt} failed: ${lastFailure}`);
						}

						if (passed) {
							currentRaw = markTaskDoneInMarkdown(currentRaw, task.lineNumber);
							await fs.writeFile(targetPath, currentRaw, 'utf8');
							completedCount++;
							if (activeCrewmate) {
								await deps.crewService.appendLedgerEntry(activeCrewmate, {
									kind: 'task',
									summary: `TASK.md #${task.index} concluída: ${task.title}`,
									status: 'ok',
								});
							}
							await deps.crewService.appendDailyHistory(root, `Task Runner concluiu: ${task.title}`);
							deps.crewTasksProvider.refresh();
						} else {
							if (activeCrewmate) {
								await deps.crewService.appendLedgerEntry(activeCrewmate, {
									kind: 'task',
									summary: `TASK.md #${task.index} falhou após tentativas: ${task.title}`,
									status: 'failed',
									details: lastFailure,
								});
							}
							vscode.window.showWarningMessage(vscode.l10n.t('Task #{0} failed after retries. Stopping Task Runner.', task.index));
							break;
						}
					}

					vscode.window.showInformationMessage(
						vscode.l10n.t('Crew Task Runner finished: {0}/{1} pending task(s) completed.', completedCount, pending.length),
					);
				},
			);
		}),

		vscode.commands.registerCommand('tarot.crew.openMemoryFile', async (kind?: 'preferences' | 'projects' | 'todayHistory' | 'lessons') => {
			const root = vscode.workspace.isTrusted ? getWorkspaceRoot() : undefined;
			const targetKind = kind ?? 'preferences';
			let filePath: string;
			if (targetKind === 'lessons') {
				filePath = deps.crewService.getMemoryPaths(root).lessons;
				await fs.mkdir(path.dirname(filePath), { recursive: true });
				await fs.access(filePath).catch(() => fs.writeFile(filePath, '# Lições Aprendidas (Tarot IDE)\n\n', 'utf8'));
			} else {
				filePath = await deps.crewService.ensureMemoryFile(root, targetKind);
			}
			const doc = await vscode.workspace.openTextDocument(filePath);
			await vscode.window.showTextDocument(doc);
		}),

		vscode.commands.registerCommand('tarot.crew.addKnowledgeSource', async () => {
			if (!vscode.workspace.isTrusted) {
				vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace to index Knowledge Library sources.'));
				return;
			}
			const root = await deps.ensureWorkspaceFolder();
			if (!root) {
				return;
			}
			const picked = await vscode.window.showOpenDialog({
				canSelectFiles: true,
				canSelectFolders: true,
				canSelectMany: false,
				defaultUri: vscode.Uri.file(root),
				openLabel: vscode.l10n.t('Add to Knowledge Library'),
			});
			if (!picked?.[0]) {
				return;
			}
			try {
				const source = await deps.crewService.addKnowledgeSource(root, picked[0].fsPath);
				deps.crewMemoryKnowledgeProvider.refresh();
				const scanLabel = vscode.l10n.t('Start Scanning');
				const choice = await vscode.window.showInformationMessage(
					vscode.l10n.t('Added "{0}" to Knowledge Library (pending scan). Index now?', source.label),
					scanLabel,
				);
				if (choice === scanLabel) {
					await vscode.commands.executeCommand('tarot.crew.scanKnowledgeSource', new KnowledgeSourceTreeItem(source.label, source));
				}
			} catch (err) {
				vscode.window.showErrorMessage(vscode.l10n.t('Failed to add Knowledge Source: {0}', err instanceof Error ? err.message : String(err)));
			}
		}),

		vscode.commands.registerCommand('tarot.crew.scanKnowledgeSource', async (item?: KnowledgeSourceTreeItem) => {
			if (!vscode.workspace.isTrusted) {
				return;
			}
			const root = await deps.ensureWorkspaceFolder();
			if (!root || !item?.source) {
				return;
			}
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Scanning Knowledge Source "{0}"...', item.source.label) },
				async () => {
					const updated = await deps.crewService.scanKnowledgeSource(root, item.source.id);
					deps.crewMemoryKnowledgeProvider.refresh();
					vscode.window.showInformationMessage(
						vscode.l10n.t('Indexed "{0}" ({1} chunks).', updated.label, updated.chunkCount),
					);
				},
			);
		}),

		vscode.commands.registerCommand('tarot.crew.removeKnowledgeSource', async (item?: KnowledgeSourceTreeItem) => {
			if (!vscode.workspace.isTrusted) {
				return;
			}
			const root = await deps.ensureWorkspaceFolder();
			if (!root || !item?.source) {
				return;
			}
			await deps.crewService.removeKnowledgeSource(root, item.source.id);
			deps.crewMemoryKnowledgeProvider.refresh();
		}),

		vscode.commands.registerCommand('tarot.crew.searchKnowledge', async () => {
			if (!vscode.workspace.isTrusted) {
				return;
			}
			const root = await deps.ensureWorkspaceFolder();
			if (!root) {
				return;
			}
			const query = await vscode.window.showInputBox({
				title: vscode.l10n.t('Search Knowledge Library'),
				prompt: vscode.l10n.t('Enter keywords to query indexed Knowledge Library chunks.'),
			});
			if (!query?.trim()) {
				return;
			}
			const hits = await deps.crewService.queryKnowledge(root, query, 10);
			if (hits.length === 0) {
				vscode.window.showInformationMessage(vscode.l10n.t('No Knowledge Library matches found for "{0}".', query));
				return;
			}
			const picked = await vscode.window.showQuickPick(
				hits.map(h => ({
					label: path.relative(root, h.filePath),
					description: `score ${h.score.toFixed(2)}`,
					detail: h.excerpt.replace(/\s+/g, ' ').slice(0, 140),
					filePath: h.filePath,
				})),
				{ title: vscode.l10n.t('Knowledge Library Results ({0})', hits.length) },
			);
			if (picked) {
				const doc = await vscode.workspace.openTextDocument(picked.filePath);
				await vscode.window.showTextDocument(doc);
			}
		}),

		vscode.commands.registerCommand('tarot.crew.toggleSchedule', async (item?: ScheduleJobTreeItem) => {
			if (!item?.job) {
				return;
			}
			try {
				const raw = JSON.parse(await fs.readFile(item.job.sourceFile, 'utf8')) as { jobs?: Array<Record<string, unknown>> } & Record<string, unknown>;
				if (Array.isArray(raw.jobs)) {
					for (const j of raw.jobs) {
						if (j.id === item.job.id || j.name === item.job.name) {
							j.enabled = !item.job.enabled;
						}
					}
				} else {
					raw.enabled = !item.job.enabled;
				}
				await fs.writeFile(item.job.sourceFile, JSON.stringify(raw, null, 2) + '\n', 'utf8');
				deps.crewSchedulesProvider.refresh();
			} catch (err) {
				vscode.window.showErrorMessage(vscode.l10n.t('Failed to toggle schedule: {0}', err instanceof Error ? err.message : String(err)));
			}
		}),

		vscode.commands.registerCommand('tarot.crew.refresh', () => {
			refreshAll();
		}),
	];
}
