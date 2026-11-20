/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { execSimple, resolveBinaryPath } from '../agents/processRunner';
import { AttachedContext, ContextProviderKind } from '../agents/types';
import { TarotSteeringService } from '../steering/steeringService';

const MAX_CONTENT_CHARS = 12_000;
const steeringService = new TarotSteeringService();

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
				vscode.window.showInformationMessage('Nenhum arquivo encontrado no workspace.');
				return undefined;
			}
			const items = uris
				.map(uri => ({
					label: vscode.workspace.asRelativePath(uri, false),
					uri,
				}))
				.sort((a, b) => a.label.localeCompare(b.label));

			const picked = await vscode.window.showQuickPick(items, {
				title: '#File — Selecionar arquivo para contexto',
				placeHolder: 'Digite o nome do arquivo...',
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
				title: '#Folder — Selecionar pasta do workspace',
				placeHolder: 'Escolha uma pasta...',
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
			const summary = lines.length > 0 ? lines.slice(0, 120).join('\n') : 'Nenhum erro ou warning ativo no painel Problems.';
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
				vscode.window.showWarningMessage('Git não encontrado no PATH.');
				return undefined;
			}
			const statusRes = await execSimple(gitPath, ['-C', root, 'status', '--short']).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }));
			const diffRes = await execSimple(gitPath, ['-C', root, 'diff', 'HEAD']).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }));
			const combined = [
				statusRes.stdout ? `## git status --short\n${statusRes.stdout}` : '## git status\nWorking tree clean.',
				diffRes.stdout ? `## git diff HEAD\n${diffRes.stdout}` : '',
			].filter(Boolean).join('\n\n');
			return {
				kind: 'gitDiff',
				label: 'Git Diff',
				path: root,
				content: truncate(combined),
			};
		}

		case 'terminal': {
			const active = vscode.window.activeTerminal;
			const name = active ? active.name : 'nenhum terminal ativo';
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

		case 'steering': {
			const docs = await steeringService.discover(root);
			if (docs.length === 0) {
				vscode.window.showInformationMessage('Nenhum arquivo de Steering encontrado em .tarot/steering/, ~/.tarot/steering/ ou AGENTS.md.');
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
					title: '#Steering — Selecionar arquivo de Steering',
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
	}
}
