/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { execSimple, resolveBinaryPath } from '../agents/processRunner';
import { AttachedContext, ContextProviderKind } from '../agents/types';
import { formatMcpContext, TarotMcpConfigService } from '../mcp/mcpConfigService';
import { TarotSpecService } from '../specs/specService';
import { TarotSteeringService } from '../steering/steeringService';

const MAX_CONTENT_CHARS = 12_000;
const steeringService = new TarotSteeringService();
const specService = new TarotSpecService();
const mcpConfigService = new TarotMcpConfigService();

function truncate(text: string, max = MAX_CONTENT_CHARS): string {
	if (text.length <= max) {
		return text;
	}
	return `${text.slice(0, max)}\n... (truncado: ${text.length - max} caracteres omitidos)`;
}

function getWorkspaceRoot(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export async function resolveContextProvider(kind: ContextProviderKind): Promise<AttachedContext | undefined> {
	const root = getWorkspaceRoot();

	switch (kind) {
		case 'file': {
			const uris = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,out,dist,.build}/**', 500);
			if (uris.length === 0) {
				vscode.window.showInformationMessage(vscode.l10n.t('No file found in the workspace.'));
				return undefined;
			}
			const items = uris
				.map(uri => ({
					label: vscode.workspace.asRelativePath(uri, false),
					uri,
				}))
				.sort((a, b) => a.label.localeCompare(b.label));

			const picked = await vscode.window.showQuickPick(items, {
				title: vscode.l10n.t('#File — Pick a file for the context'),
				placeHolder: vscode.l10n.t('Type the file name...'),
			});
			if (!picked) {
				return undefined;
			}
			const raw = await fs.readFile(picked.uri.fsPath, 'utf8').catch(() => '');
			return {
				kind: 'file',
				label: picked.label,
				path: picked.uri.fsPath,
				content: truncate(raw),
			};
		}

		case 'folder': {
			if (!root) {
				return undefined;
			}
			const entries = await fs.readdir(root, { withFileTypes: true });
			const dirs = entries
				.filter(e => e.isDirectory() && !['node_modules', '.git', 'out', 'dist', '.build'].includes(e.name))
				.map(e => e.name)
				.sort();
			const picked = await vscode.window.showQuickPick(dirs, {
				title: vscode.l10n.t('#Folder — Pick a workspace folder'),
				placeHolder: vscode.l10n.t('Pick a folder...'),
			});
			if (!picked) {
				return undefined;
			}
			const folderPath = path.join(root, picked);
			const subEntries = await fs.readdir(folderPath, { withFileTypes: true }).catch(() => []);
			const listing = subEntries.map(e => `${e.isDirectory() ? '[dir] ' : ''}${e.name}`).join('\n');
			return {
				kind: 'folder',
				label: `${picked}/`,
				path: folderPath,
				content: truncate(`Directory listing of ${picked}/:\n${listing}`),
			};
		}

		case 'problems': {
			const all = vscode.languages.getDiagnostics();
			const lines: string[] = [];
			for (const [uri, diags] of all) {
				const rel = vscode.workspace.asRelativePath(uri, false);
				for (const d of diags) {
					if (d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning) {
						const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' : 'WARN';
						const line = d.range.start.line + 1;
						lines.push(`[${sev}] ${rel}:${line} — ${d.message}`);
					}
				}
			}
			const summary = lines.length > 0 ? lines.slice(0, 120).join('\n') : vscode.l10n.t('No active error or warning in the Problems panel.');
			return {
				kind: 'problems',
				label: `Problems (${lines.length})`,
				content: truncate(summary),
			};
		}

		case 'gitDiff': {
			if (!root) {
				return undefined;
			}
			const gitPath = await resolveBinaryPath('git');
			if (!gitPath) {
				vscode.window.showWarningMessage(vscode.l10n.t('Git not found on PATH.'));
				return undefined;
			}
			const statusRes = await execSimple(gitPath, ['-C', root, 'status', '--short']).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }));
			const diffRes = await execSimple(gitPath, ['-C', root, 'diff', 'HEAD']).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }));
			// A non-zero exitCode (not a git repo, no commits yet, git failure) left stdout empty
			// just like a genuinely clean tree would — the old fallback could not tell them apart
			// and reported "Working tree clean." either way, feeding the agent active
			// misinformation instead of surfacing that the command actually failed.
			const parts: string[] = [];
			if (statusRes.exitCode !== 0) {
				parts.push(`## git status\n(git status failed: ${statusRes.stderr.trim() || `exit code ${statusRes.exitCode}`})`);
			} else if (statusRes.stdout) {
				parts.push(`## git status --short\n${statusRes.stdout}`);
			} else {
				parts.push('## git status\nWorking tree clean.');
			}
			if (diffRes.exitCode !== 0) {
				parts.push(`## git diff HEAD\n(git diff failed: ${diffRes.stderr.trim() || `exit code ${diffRes.exitCode}`})`);
			} else if (diffRes.stdout) {
				parts.push(`## git diff HEAD\n${diffRes.stdout}`);
			}
			const combined = parts.join('\n\n');
			return {
				kind: 'gitDiff',
				label: 'Git Diff',
				path: root,
				content: truncate(combined),
			};
		}

		case 'terminal': {
			const active = vscode.window.activeTerminal;
			const name = active ? active.name : vscode.l10n.t('no active terminal');
			return {
				kind: 'terminal',
				label: `Terminal (${name})`,
				content: `Active terminal: ${name}. Workspace: ${root ?? 'none'}.`,
			};
		}

		case 'codebase': {
			if (!root) {
				return undefined;
			}
			const uris = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,out,dist,.build}/**', 250);
			const tree = uris.map(u => vscode.workspace.asRelativePath(u, false)).sort().join('\n');
			return {
				kind: 'codebase',
				label: `Codebase (${uris.length} files)`,
				path: root,
				content: truncate(`Workspace files (${uris.length} sampled):\n${tree}`),
			};
		}

		case 'spec': {
			if (!root) {
				return undefined;
			}
			const specs = await specService.listSpecs(root);
			if (specs.length === 0) {
				vscode.window.showInformationMessage(vscode.l10n.t('No Spec found in .tarot/specs/.'));
				return undefined;
			}
			const picked = await vscode.window.showQuickPick(
				specs.map(s => ({
					label: s.slug,
					description: `${s.kind} · ${s.taskSummary.done}/${s.taskSummary.total} tasks`,
					spec: s,
				})),
				{ title: vscode.l10n.t('#Spec — Pick a Spec from the project') },
			);
			if (!picked) {
				return undefined;
			}
			const loaded = await specService.loadSpecContext(picked.spec.dirPath);
			return {
				kind: 'spec',
				label: `spec/${loaded.slug}`,
				path: loaded.dirPath,
				content: truncate(loaded.contextText),
			};
		}

		case 'steering': {
			if (!vscode.workspace.isTrusted) {
				vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace before attaching Steering documents.'));
				return undefined;
			}
			const docs = await steeringService.discover(root);
			if (docs.length === 0) {
				vscode.window.showInformationMessage(vscode.l10n.t('No Steering file found in .tarot/steering/, ~/.tarot/steering/ or AGENTS.md.'));
				return undefined;
			}
			const picked = await vscode.window.showQuickPick(
				docs.map(doc => ({
					label: doc.fileName,
					description: `${doc.scope} · ${doc.inclusion}${doc.fileMatchPattern ? ` (${doc.fileMatchPattern})` : ''}`,
					detail: doc.description,
					doc,
				})),
				{
					title: vscode.l10n.t('#Steering — Pick a Steering file'),
					matchOnDescription: true,
					matchOnDetail: true,
				},
			);
			if (!picked) {
				return undefined;
			}
			return {
				kind: 'steering',
				label: `steering/${picked.doc.fileName}`,
				path: picked.doc.filePath,
				content: truncate(picked.doc.body || picked.doc.raw),
			};
		}

		case 'mcp': {
			if (!vscode.workspace.isTrusted) {
				vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace before loading MCP server configurations.'));
				return undefined;
			}
			const { servers } = await mcpConfigService.discover(root);
			if (servers.length === 0) {
				vscode.window.showInformationMessage(vscode.l10n.t('No MCP servers found in .tarot/settings/mcp.json or ~/.tarot/settings/mcp.json.'));
				return undefined;
			}
			const picked = await vscode.window.showQuickPick(
				[
					{ label: vscode.l10n.t('All MCP Servers ({0})', servers.length), description: vscode.l10n.t('Attach summary of all configured servers'), server: undefined },
					...servers.map(s => ({
						label: s.name,
						description: `${s.scope} · ${s.transport}${s.enabled ? '' : ' (disabled)'}`,
						detail: s.transport === 'remote' ? s.url : `${s.command} ${(s.args ?? []).join(' ')}`.trim(),
						server: s,
					})),
				],
				{ title: vscode.l10n.t('#MCP — Pick an MCP Server') },
			);
			if (!picked) {
				return undefined;
			}
			const selectedServers = picked.server ? [picked.server] : servers;
			return {
				kind: 'mcp',
				label: picked.server ? `mcp/${picked.server.name}` : `mcp (${servers.length})`,
				path: picked.server?.sourceFile,
				content: truncate(formatMcpContext(selectedServers)),
			};
		}
	}
}
