/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { getPanelStrings } from './panelStrings';

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

export function buildAgentPanelHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const nonce = crypto.randomBytes(16).toString('base64');
	const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'webview', 'panel.css'));
	const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'webview', 'panel.js'));
	const arcanaArt = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'arcana', file)).toString();
	const arcanaSvg = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'icons', 'arcana', file)).toString();
	const arcanaPayload = JSON.stringify({
		art: {
			vibe: arcanaArt('00-the-fool.png'),
			spec: arcanaArt('05-the-hierophant.png'),
			plan: arcanaArt('09-the-hermit.png'),
			bugfix: arcanaArt('16-the-tower.png'),
		},
		icons: {
			error: arcanaSvg('16-the-tower.svg'),
		},
	}).replace(/</g, '\\u003c');

	const rawStrings = getPanelStrings();
	const s = Object.fromEntries(
		Object.entries(rawStrings).map(([k, v]) => [k, escapeHtml(v)]),
	) as unknown as typeof rawStrings;
	// Catalog consumed by media/webview/panel.js for strings it renders at runtime.
	// `<` escaping keeps the JSON safe to embed inside a <script> element.
	const l10nPayload = JSON.stringify(rawStrings).replace(/</g, '\\u003c');

	return `<!DOCTYPE html>
<html lang="${escapeHtml(vscode.env.language)}">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource};" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link rel="stylesheet" href="${cssUri}" />
	<title>Tarot Agent</title>
</head>
<body>
	<div class="tarot-shell">
		<header class="session-tabbar">
			<span class="tabbar-brand">TAROT</span>
			<div id="session-tabs" class="session-tabs" role="tablist"></div>
			<button id="btn-new-session" class="tabbar-add-btn" type="button" title="${s.newSession}">
				<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 3.2v9.6M3.2 8h9.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
			</button>
			<button id="btn-session-history" class="tabbar-add-btn tabbar-secondary-btn" type="button" title="${s.sessionHistory}">
				<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.4"/><path d="M8 5v3.2l2.2 1.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
			</button>
			<button id="btn-dock-editor" class="tabbar-add-btn tabbar-secondary-btn" type="button" title="${s.dockEditorTab}">
				<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M9.5 2.5h4v4M13.5 2.5L8.5 7.5M6.5 13.5h-4v-4M2.5 13.5l5-5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
			</button>
			<button id="btn-focus-mode" class="tabbar-add-btn tabbar-secondary-btn" type="button" title="${s.toggleFocusMode}">
				<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="2" y="2.5" width="12" height="11" rx="1.8" stroke="currentColor" stroke-width="1.4"/><path d="M6 2.5v11" stroke="currentColor" stroke-width="1.3"/></svg>
			</button>
		</header>

		<main id="messages" class="tarot-messages" aria-live="polite"></main>

		<footer class="tarot-composer-wrap">
			<div id="review-bar" class="review-bar hidden">
				<div class="review-bar-header">
					<button id="btn-review-toggle" class="review-toggle-btn" type="button">
						<span id="review-summary-text">0 ${s.filesChanged}</span>
					</button>
					<button id="btn-review-refresh" class="review-mini-btn" type="button" title="${s.refreshGitDiff}">↻</button>
				</div>
				<div id="review-file-list" class="review-file-list hidden"></div>
			</div>

			<div id="context-menu" class="context-popup hidden" role="menu">
				<div class="context-popup-header">${s.contextProvidersTitle}</div>
				<button class="context-menu-item" type="button" data-kind="file"><span class="ctx-tag">#File</span><span class="ctx-desc">${s.contextFileDesc}</span></button>
				<button class="context-menu-item" type="button" data-kind="folder"><span class="ctx-tag">#Folder</span><span class="ctx-desc">${s.contextFolderDesc}</span></button>
				<button class="context-menu-item" type="button" data-kind="spec"><span class="ctx-tag">#Spec</span><span class="ctx-desc">${s.contextSpecDesc}</span></button>
				<button class="context-menu-item" type="button" data-kind="problems"><span class="ctx-tag">#Problems</span><span class="ctx-desc">${s.contextProblemsDesc}</span></button>
				<button class="context-menu-item" type="button" data-kind="gitDiff"><span class="ctx-tag">#Git Diff</span><span class="ctx-desc">${s.contextGitDiffDesc}</span></button>
				<button class="context-menu-item" type="button" data-kind="codebase"><span class="ctx-tag">#Codebase</span><span class="ctx-desc">${s.contextCodebaseDesc}</span></button>
				<button class="context-menu-item" type="button" data-kind="terminal"><span class="ctx-tag">#Terminal</span><span class="ctx-desc">${s.contextTerminalDesc}</span></button>
				<button class="context-menu-item" type="button" data-kind="steering"><span class="ctx-tag">#Steering</span><span class="ctx-desc">${s.contextSteeringDesc}</span></button>
				<button class="context-menu-item" type="button" data-kind="mcp"><span class="ctx-tag">#MCP</span><span class="ctx-desc">${s.contextMcpDesc}</span></button>
				<button class="context-menu-item" type="button" data-kind="current"><span class="ctx-tag">#Current</span><span class="ctx-desc">${s.contextCurrentDesc}</span></button>
				<button class="context-menu-item" type="button" data-kind="code"><span class="ctx-tag">#Code</span><span class="ctx-desc">${s.contextCodeDesc}</span></button>
				<button class="context-menu-item" type="button" data-kind="url"><span class="ctx-tag">#URL</span><span class="ctx-desc">${s.contextUrlDesc}</span></button>
				<button class="context-menu-item" type="button" data-kind="repository"><span class="ctx-tag">#Repository</span><span class="ctx-desc">${s.contextRepositoryDesc}</span></button>
				<button class="context-menu-item" type="button" data-kind="docs"><span class="ctx-tag">#Docs</span><span class="ctx-desc">${s.contextDocsDesc}</span></button>
			</div>

			<div id="slash-menu" class="context-popup hidden" role="menu">
				<div class="context-popup-header">${s.slashCommandsTitle}</div>
				<button class="slash-menu-item" type="button" data-cmd="/spec"><span class="ctx-tag">/spec</span><span class="ctx-desc">${s.slashSpecDesc}</span></button>
				<button class="slash-menu-item" type="button" data-cmd="/quick-spec"><span class="ctx-tag">/quick-spec</span><span class="ctx-desc">${s.slashQuickSpecDesc}</span></button>
				<button class="slash-menu-item" type="button" data-cmd="/generate-spec"><span class="ctx-tag">/generate-spec</span><span class="ctx-desc">${s.slashGenerateSpecDesc}</span></button>
				<button class="slash-menu-item" type="button" data-cmd="/plan"><span class="ctx-tag">/plan</span><span class="ctx-desc">${s.slashPlanDesc}</span></button>
				<button class="slash-menu-item" type="button" data-cmd="/steering"><span class="ctx-tag">/steering</span><span class="ctx-desc">${s.slashSteeringDesc}</span></button>
				<button class="slash-menu-item" type="button" data-cmd="/review"><span class="ctx-tag">/review</span><span class="ctx-desc">${s.slashReviewDesc}</span></button>
				<button class="slash-menu-item" type="button" data-cmd="/focus"><span class="ctx-tag">/focus</span><span class="ctx-desc">${s.slashFocusDesc}</span></button>
				<button class="slash-menu-item" type="button" data-cmd="/clear"><span class="ctx-tag">/clear</span><span class="ctx-desc">${s.slashClearDesc}</span></button>
			</div>

			<div id="model-menu" class="context-popup model-popover hidden" role="menu">
				<div class="popover-section">
					<div class="context-popup-header">${s.agentCliHeader}</div>
					<div id="model-agent-pills" class="pill-row"></div>
				</div>
				<div class="popover-section">
					<div class="context-popup-header">${s.modelHeader}</div>
					<div id="model-options-list" class="model-options-list"></div>
				</div>
				<div class="popover-section">
					<div class="context-popup-header">${s.reasoningEffortHeader}</div>
					<div id="effort-pills" class="pill-row effort-row"></div>
				</div>
			</div>

			<div id="mode-menu" class="context-popup mode-popover hidden" role="menu">
				<div class="context-popup-header">${s.modeAria}</div>
				<button class="mode-menu-item" type="button" data-mode="vibe"><span class="ctx-tag">${s.modeDefaultTitle}</span><span class="ctx-desc">${s.modeVibeDesc}</span></button>
				<button class="mode-menu-item" type="button" data-mode="spec"><span class="ctx-tag">${s.modeSpecTitle}</span><span class="ctx-desc">${s.modeSpecDesc}</span></button>
				<button class="mode-menu-item" type="button" data-mode="plan"><span class="ctx-tag">${s.modePlanTitle}</span><span class="ctx-desc">${s.slashPlanDesc}</span></button>
			</div>

			<div id="autonomy-menu" class="context-popup mode-popover hidden" role="menu">
				<div class="context-popup-header">${s.autonomyMenuHeader}</div>
				<button class="mode-menu-item" type="button" data-autonomy="supervised"><span class="ctx-tag">${s.autonomySupervisedTitle}</span><span class="ctx-desc">${s.autonomySupervisedDesc}</span></button>
				<button class="mode-menu-item" type="button" data-autonomy="acceptFileChanges"><span class="ctx-tag">${s.autonomyAcceptTitle}</span><span class="ctx-desc">${s.autonomyAcceptDesc}</span></button>
				<button class="mode-menu-item" type="button" data-autonomy="approveForMe"><span class="ctx-tag">${s.autonomyApproveTitle}</span><span class="ctx-desc">${s.autonomyApproveDesc}</span></button>
			</div>

			<div id="status-row" class="status-row hidden">
				<span class="status-dot"></span>
				<span id="status-indicator" class="status-text"></span>
			</div>

			<div class="composer-card">
				<div id="attachments" class="attachments-bar hidden"></div>

				<div class="composer-input-row">
					<textarea
						id="prompt-input"
						rows="1"
						placeholder="${s.promptPlaceholder}"
					></textarea>
					<button id="btn-send" class="action-icon-btn" type="button" title="${s.send}" disabled>
						<svg id="icon-send" width="14" height="14" viewBox="0 0 16 16" fill="none">
							<path d="M8 12.5V3.5M4 7.5L8 3.5L12 7.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
						</svg>
						<svg id="icon-stop" class="hidden" width="11" height="11" viewBox="0 0 16 16" fill="none">
							<rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor"/>
						</svg>
					</button>
				</div>

				<div class="composer-bottom">
					<div class="composer-left">
						<button id="btn-hash" class="tool-icon-btn" type="button" title="${s.contextProvidersHint}">
							<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M6.2 2.5L4.8 13.5M11.2 2.5L9.8 13.5M2.8 6h10.8M2.4 10h10.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
						</button>
						<button id="btn-attach" class="tool-icon-btn" type="button" title="${s.attachActiveFile}">
							<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M10.5 4.5L5.8 9.2a1.75 1.75 0 1 0 2.48 2.48l5.3-5.3a3 3 0 0 0-4.24-4.24l-5.5 5.5a4.25 4.25 0 0 0 6.01 6.01l4.4-4.4" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>
						</button>
						<span id="context-ring" class="context-ring">
							<svg width="14" height="14" viewBox="0 0 16 16">
								<circle class="context-ring-track" cx="8" cy="8" r="5.5" fill="none" stroke-width="1.7"/>
								<circle id="context-ring-arc" class="context-ring-fill" cx="8" cy="8" r="5.5" fill="none" stroke-width="1.7" stroke-dasharray="34.56" stroke-dashoffset="34.56" stroke-linecap="round" transform="rotate(-90 8 8)"/>
							</svg>
						</span>
						<button id="btn-model-picker" class="picker-trigger-btn" type="button" aria-label="${s.localAgentAria}">
							<span id="model-picker-label">${s.autoLabel}</span>
							<svg class="picker-chevron" width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M4.5 6.2L8 9.8l3.5-3.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
						</button>
					</div>

					<div class="composer-right">
						<button id="btn-mode-picker" class="picker-trigger-btn" type="button" aria-label="${s.modeAria}">
							<span id="mode-picker-label">${s.modeDefaultTitle}</span>
							<svg class="picker-chevron" width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M4.5 6.2L8 9.8l3.5-3.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
						</button>
						<button id="btn-autonomy-picker" class="picker-trigger-btn" type="button" aria-label="${s.autonomyAria}" title="${s.autonomyAria}">
							<span id="autonomy-enforcement-dot" class="enforcement-dot" title=""></span>
							<span id="autonomy-picker-label">${s.autonomyAcceptTitle}</span>
							<svg class="picker-chevron" width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M4.5 6.2L8 9.8l3.5-3.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
						</button>
					</div>
				</div>
			</div>
		</footer>
	</div>
	<script nonce="${nonce}">window.__tarotL10n = ${l10nPayload};window.__tarotArcana = ${arcanaPayload};</script>
	<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}
