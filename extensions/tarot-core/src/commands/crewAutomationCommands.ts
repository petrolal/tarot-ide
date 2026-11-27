/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { TarotAppsAndRemoteService } from '../crew/appsAndRemoteService';
import { TarotCrewService } from '../crew/crewService';
import { GatewayKind, TarotGatewayService } from '../crew/gatewayService';
import { TarotHeartbeatService } from '../crew/heartbeatService';
import { runHookCommand } from '../hooks/hookRunner';
import { TarotPermissionsService } from '../permissions/permissionsService';
import { TarotAgentPanelProvider } from '../views/agentPanelView';
import {
	CrewAppTreeItem,
	CrewAutomationTreeProvider,
	GatewayTreeItem,
	RemoteSshTreeItem,
	TarotCrewAppPanel,
} from '../views/crewAutomationView';
import { getWorkspaceRoot } from '../views/tarotSidebarViews';

const WEBHOOK_SECRET_KEY = 'tarot.crew.webhook.sharedSecret';

export interface CrewAutomationCommandDeps {
	readonly context: vscode.ExtensionContext;
	readonly crewService: TarotCrewService;
	readonly heartbeatService: TarotHeartbeatService;
	readonly gatewayService: TarotGatewayService;
	readonly appsAndRemoteService: TarotAppsAndRemoteService;
	readonly permissionsService: TarotPermissionsService;
	readonly agentPanelProvider: TarotAgentPanelProvider;
	readonly crewAutomationProvider: CrewAutomationTreeProvider;
	readonly ensureWorkspaceFolder: () => Promise<string | undefined>;
	readonly outputChannel: vscode.OutputChannel;
}

export function registerCrewAutomationCommands(deps: CrewAutomationCommandDeps): vscode.Disposable[] {
	const checkCommandAllowed = async (command: string): Promise<boolean> => {
		const res = await deps.permissionsService.evaluateShellCommand(command, { headless: true });
		return res.decision.effect === 'allow';
	};

	const notifyAlert = async (summary: string): Promise<void> => {
		vscode.window.showWarningMessage(vscode.l10n.t('Tarot Crew Heartbeat Alert: {0}', summary));
		const root = getWorkspaceRoot();
		if (!root) {
			return;
		}
		const gateways = (await deps.gatewayService.listGateways(root)).filter(g => g.enabled);
		for (const gw of gateways) {
			const secret = await deps.context.secrets.get(`tarot.crew.gateway.secret.${gw.id}`);
			if (secret) {
				await deps.gatewayService.sendGatewayMessage(gw, secret, 'Heartbeat Alert', summary);
			}
		}
	};

	const appPanel = new TarotCrewAppPanel({
		openManifest: async manifestPath => {
			const doc = await vscode.workspace.openTextDocument(manifestPath);
			await vscode.window.showTextDocument(doc);
		},
		runAction: async (app, action) => {
			if (!vscode.workspace.isTrusted) {
				return 'Workspace must be trusted to run Crew App actions.';
			}
			const root = getWorkspaceRoot();
			if (!root) {
				return 'No workspace open.';
			}
			if (action.kind === 'prompt') {
				await deps.agentPanelProvider.runExternalPrompt(`[Crew App: ${app.name}] ${action.value}`, 'vibe');
				return `Dispatched prompt to Tarot Agent Panel: ${action.value}`;
			}
			const allowed = await checkCommandAllowed(action.value);
			if (!allowed) {
				return `Denied by Tarot permissions policy: ${action.value}`;
			}
			const res = await runHookCommand(
				action.value,
				{ hook_event_name: 'Stop', cwd: root, session_id: `crew-app-${app.id}` },
				15,
			);
			if (res.kind === 'ok') {
				return res.stdout.trim() || '(ok)';
			}
			return res.kind === 'timeout'
				? 'Timed out after 15s.'
				: (res.stderr.trim() || `Exit ${res.kind === 'warn' ? (res.exitCode ?? 'error') : 2}`);
		},
	});

	return [
		appPanel,

		vscode.commands.registerCommand('tarot.crew.heartbeat.toggle', async () => {
			if (!vscode.workspace.isTrusted) {
				vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace to run the Crew Heartbeat Daemon.'));
				return;
			}
			const root = await deps.ensureWorkspaceFolder();
			if (!root) {
				return;
			}
			if (deps.heartbeatService.isRunning()) {
				deps.heartbeatService.stop();
				deps.crewAutomationProvider.refresh();
				vscode.window.showInformationMessage(vscode.l10n.t('Tarot Crew Heartbeat Daemon stopped.'));
				return;
			}
			const cfg = await deps.heartbeatService.loadConfig(root);
			deps.heartbeatService.start(root, cfg.intervalSec, {
				checkCommandAllowed,
				onTick: () => deps.crewAutomationProvider.refresh(),
				onAlert: async rec => {
					const summary = rec.results.filter(r => r.status !== 'ok').map(r => `${r.name}: ${r.summary}`).join(' · ');
					await notifyAlert(summary);
				},
			});
			deps.crewAutomationProvider.refresh();
			vscode.window.showInformationMessage(vscode.l10n.t('Tarot Crew Heartbeat Daemon started (every {0}s).', cfg.intervalSec));
		}),

		vscode.commands.registerCommand('tarot.crew.heartbeat.runOnce', async () => {
			if (!vscode.workspace.isTrusted) {
				vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace to run Heartbeat checks.'));
				return;
			}
			const root = await deps.ensureWorkspaceFolder();
			if (!root) {
				return;
			}
			const record = await deps.heartbeatService.runOnce(root, { checkCommandAllowed });
			deps.crewAutomationProvider.refresh();
			const summary = record.results.map(r => `${r.name}: ${r.summary}`).join(' | ');
			vscode.window.showInformationMessage(vscode.l10n.t('Heartbeat ({0}): {1}', record.status, summary));
		}),

		vscode.commands.registerCommand('tarot.crew.heartbeat.openConfig', async () => {
			if (!vscode.workspace.isTrusted) {
				return;
			}
			const root = await deps.ensureWorkspaceFolder();
			if (!root) {
				return;
			}
			const cfgPath = await deps.heartbeatService.ensureConfigFile(root);
			const doc = await vscode.workspace.openTextDocument(cfgPath);
			await vscode.window.showTextDocument(doc);
		}),

		vscode.commands.registerCommand('tarot.crew.webhook.toggleServer', async () => {
			if (!vscode.workspace.isTrusted) {
				vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace to start the local Webhook Server.'));
				return;
			}
			if (deps.gatewayService.isWebhookServerRunning()) {
				await deps.gatewayService.stopWebhookServer();
				deps.crewAutomationProvider.refresh();
				vscode.window.showInformationMessage(vscode.l10n.t('Local Crew Webhook Server stopped.'));
				return;
			}
			let secret = await deps.context.secrets.get(WEBHOOK_SECRET_KEY);
			if (!secret) {
				secret = crypto.randomBytes(24).toString('hex');
				await deps.context.secrets.store(WEBHOOK_SECRET_KEY, secret);
			}
			const root = getWorkspaceRoot();
			const port = await deps.gatewayService.startWebhookServer(secret, async event => {
				deps.outputChannel.appendLine(`[Crew Webhook] Verified POST /webhook/${event.hookId} at ${event.receivedAt}`);
				if (root) {
					await deps.crewService.appendDailyHistory(root, `Webhook verificado /webhook/${event.hookId}`);
				}
				vscode.window.showInformationMessage(vscode.l10n.t('Verified Crew webhook received: /webhook/{0}', event.hookId));
			});
			deps.crewAutomationProvider.refresh();
			const copyLabel = vscode.l10n.t('Copy Endpoint');
			const choice = await vscode.window.showInformationMessage(
				vscode.l10n.t('Local Crew Webhook Server listening on http://127.0.0.1:{0}/webhook/<id> (HMAC-SHA256 secret stored in SecretStorage).', port),
				copyLabel,
			);
			if (choice === copyLabel) {
				await vscode.env.clipboard.writeText(`http://127.0.0.1:${port}/webhook/default`);
			}
		}),

		vscode.commands.registerCommand('tarot.crew.gateway.configure', async () => {
			if (!vscode.workspace.isTrusted) {
				vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace to configure Crew Gateways.'));
				return;
			}
			const root = await deps.ensureWorkspaceFolder();
			if (!root) {
				return;
			}
			const kindPick = await vscode.window.showQuickPick([
				{ label: 'Slack (Incoming Webhook)', gatewayKind: 'slack' as GatewayKind },
				{ label: 'Discord (Webhook)', gatewayKind: 'discord' as GatewayKind },
				{ label: 'Telegram (Bot Token + Chat ID)', gatewayKind: 'telegram' as GatewayKind },
				{ label: 'Microsoft Teams (Webhook)', gatewayKind: 'teams' as GatewayKind },
			], { title: vscode.l10n.t('Select Omnichannel Gateway') });
			if (!kindPick) {
				return;
			}
			const label = await vscode.window.showInputBox({
				title: vscode.l10n.t('Gateway Label'),
				placeHolder: `${kindPick.gatewayKind}-alerts`,
			});
			if (!label?.trim()) {
				return;
			}
			let chatId: string | undefined;
			if (kindPick.gatewayKind === 'telegram') {
				chatId = await vscode.window.showInputBox({
					title: vscode.l10n.t('Telegram Chat ID'),
					placeHolder: '123456789',
				});
				if (!chatId?.trim()) {
					return;
				}
			}
			const secretValue = await vscode.window.showInputBox({
				title: kindPick.gatewayKind === 'telegram' ? vscode.l10n.t('Telegram Bot Token') : vscode.l10n.t('HTTPS Webhook URL'),
				prompt: vscode.l10n.t('Stored securely in OS SecretStorage — never written to .tarot/.'),
				password: true,
			});
			if (!secretValue?.trim()) {
				return;
			}
			const id = `${kindPick.gatewayKind}-${Date.now().toString(36)}`;
			await deps.context.secrets.store(`tarot.crew.gateway.secret.${id}`, secretValue.trim());
			await deps.gatewayService.saveGateway(root, {
				id,
				kind: kindPick.gatewayKind,
				label: label.trim(),
				enabled: true,
				chatId: chatId?.trim(),
			});
			deps.crewAutomationProvider.refresh();
			vscode.window.showInformationMessage(vscode.l10n.t('Gateway "{0}" saved (secret stored in SecretStorage).', label.trim()));
		}),

		vscode.commands.registerCommand('tarot.crew.gateway.testSend', async (item?: GatewayTreeItem) => {
			// TD-04: trust was enforced only by the tree view filtering its own arguments; a
			// direct executeCommand() call bypassed it entirely and still sent a real HTTP POST.
			if (!vscode.workspace.isTrusted) {
				vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace to send Crew Gateway test messages.'));
				return;
			}
			if (!item?.gateway) {
				return;
			}
			const secret = await deps.context.secrets.get(`tarot.crew.gateway.secret.${item.gateway.id}`);
			if (!secret) {
				vscode.window.showWarningMessage(vscode.l10n.t('No secret found in SecretStorage for gateway "{0}".', item.gateway.label));
				return;
			}
			const res = await deps.gatewayService.sendGatewayMessage(
				item.gateway,
				secret,
				'Connectivity Test',
				'Test message sent from Tarot IDE Crew.',
			);
			if (res.ok) {
				vscode.window.showInformationMessage(vscode.l10n.t('Test message delivered to "{0}".', item.gateway.label));
			} else {
				vscode.window.showErrorMessage(vscode.l10n.t('Gateway delivery failed: {0}', res.error ?? String(res.status)));
			}
		}),

		vscode.commands.registerCommand('tarot.crew.apps.create', async () => {
			if (!vscode.workspace.isTrusted) {
				vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace to create Crew Apps.'));
				return;
			}
			const root = await deps.ensureWorkspaceFolder();
			if (!root) {
				return;
			}
			const name = await vscode.window.showInputBox({
				title: vscode.l10n.t('New Tarot Crew App'),
				placeHolder: 'Release Dashboard',
			});
			if (!name?.trim()) {
				return;
			}
			const description = await vscode.window.showInputBox({
				title: vscode.l10n.t('Crew App Description'),
				placeHolder: 'Quick release checks and agent prompts',
			});
			if (description === undefined) {
				return;
			}
			const app = await deps.appsAndRemoteService.createAppTemplate(root, name, description);
			deps.crewAutomationProvider.refresh();
			appPanel.show(app);
		}),

		vscode.commands.registerCommand('tarot.crew.apps.open', (item?: CrewAppTreeItem) => {
			if (item?.app) {
				appPanel.show(item.app);
			}
		}),

		vscode.commands.registerCommand('tarot.crew.remote.add', async () => {
			if (!vscode.workspace.isTrusted) {
				vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace to register Remote SSH Crew hosts.'));
				return;
			}
			const root = await deps.ensureWorkspaceFolder();
			if (!root) {
				return;
			}
			const label = await vscode.window.showInputBox({ title: vscode.l10n.t('Remote Crew Label'), placeHolder: 'Build Server' });
			if (!label?.trim()) {
				return;
			}
			const host = await vscode.window.showInputBox({ title: vscode.l10n.t('SSH Hostname'), placeHolder: 'dev.example.com' });
			if (!host?.trim()) {
				return;
			}
			const user = await vscode.window.showInputBox({ title: vscode.l10n.t('SSH Username (Optional)'), placeHolder: 'ubuntu' });
			if (user === undefined) {
				return;
			}
			const remoteCrewDir = await vscode.window.showInputBox({
				title: vscode.l10n.t('Remote .tarot/crew Directory'),
				value: '~/.tarot/crew',
			});
			if (!remoteCrewDir?.trim()) {
				return;
			}
			try {
				await deps.appsAndRemoteService.saveRemote(root, {
					id: `ssh-${Date.now().toString(36)}`,
					label: label.trim(),
					host: host.trim(),
					user: user.trim() || undefined,
					remoteCrewDir: remoteCrewDir.trim(),
				});
				deps.crewAutomationProvider.refresh();
				vscode.window.showInformationMessage(vscode.l10n.t('Remote SSH Crew host "{0}" saved.', label.trim()));
			} catch (err) {
				vscode.window.showErrorMessage(vscode.l10n.t('Invalid SSH profile: {0}', err instanceof Error ? err.message : String(err)));
			}
		}),

		vscode.commands.registerCommand('tarot.crew.remote.check', async (item?: RemoteSshTreeItem) => {
			// TD-04: trust was enforced only by the tree view filtering its own arguments; a
			// direct executeCommand() call bypassed it entirely and still spawned a real ssh.
			if (!vscode.workspace.isTrusted) {
				vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace to check Remote Crew hosts.'));
				return;
			}
			if (!item?.remote) {
				return;
			}
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Checking Remote Crew on {0}...', item.remote.host) },
				async () => {
					const res = await deps.appsAndRemoteService.checkRemoteCrewStatus(item.remote);
					if (res.ok) {
						vscode.window.showInformationMessage(vscode.l10n.t('Remote Crew ({0}): {1}', item.remote.label, res.output));
					} else {
						vscode.window.showWarningMessage(vscode.l10n.t('Remote Crew ({0}) error: {1}', item.remote.label, res.output));
					}
				},
			);
		}),
	];
}
