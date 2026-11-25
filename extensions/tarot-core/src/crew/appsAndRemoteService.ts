/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execSimple, resolveBinaryPath } from '../agents/processRunner';

export interface CrewAppAction {
	readonly id: string;
	readonly label: string;
	readonly kind: 'prompt' | 'command';
	readonly value: string;
}

export interface CrewAppManifest {
	readonly id: string;
	readonly name: string;
	readonly version: string;
	readonly description: string;
	readonly manifestPath: string;
	readonly actions: readonly CrewAppAction[];
}

export interface RemoteSshProfile {
	readonly id: string;
	readonly label: string;
	readonly host: string;
	readonly user?: string;
	readonly port?: number;
	readonly remoteCrewDir: string;
}

function sanitizeSlug(raw: string): string {
	return raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^\.+/, '');
}

/** Validates SSH host/user/dir fields to prevent option injection (`-o`, `--`) and shell metacharacters. */
export function validateRemoteSshProfile(raw: Partial<RemoteSshProfile>): { readonly ok: boolean; readonly error?: string } {
	const host = raw.host?.trim() ?? '';
	if (!host || host.startsWith('-') || !/^[a-zA-Z0-9._-]+$/.test(host)) {
		return { ok: false, error: 'Invalid SSH host (must be alphanumeric/dots/hyphens and not start with "-").' };
	}
	if (raw.user !== undefined && raw.user.trim()) {
		const u = raw.user.trim();
		if (u.startsWith('-') || !/^[a-zA-Z0-9._-]+$/.test(u)) {
			return { ok: false, error: 'Invalid SSH username.' };
		}
	}
	if (raw.port !== undefined) {
		if (!Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) {
			return { ok: false, error: 'SSH port must be between 1 and 65535.' };
		}
	}
	const dir = raw.remoteCrewDir?.trim() ?? '';
	if (!dir || dir.startsWith('-') || /[\r\n\0;&|`$<>]/.test(dir)) {
		return { ok: false, error: 'Invalid remote crew directory path.' };
	}
	return { ok: true };
}

/**
 * Pure Node.js service for Tarot Crew Apps SDK (`.tarot/crew/apps/<id>/app.json`) and
 * Remote Crew instances over SSH (`.tarot/crew/remotes.json`).
 */
export class TarotAppsAndRemoteService {
	getAppsDir(workspaceRoot: string): string {
		return path.join(workspaceRoot, '.tarot', 'crew', 'apps');
	}

	getRemotesPath(workspaceRoot: string): string {
		return path.join(workspaceRoot, '.tarot', 'crew', 'remotes.json');
	}

	// ---- Crew Apps SDK ----

	async discoverApps(workspaceRoot: string): Promise<CrewAppManifest[]> {
		const dir = this.getAppsDir(workspaceRoot);
		let entries;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return [];
		}
		const apps: CrewAppManifest[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}
			const manifestPath = path.join(dir, entry.name, 'app.json');
			try {
				const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
				const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : entry.name;
				const version = typeof raw.version === 'string' && raw.version.trim() ? raw.version.trim() : '0.1.0';
				const description = typeof raw.description === 'string' ? raw.description.trim() : '';
				const actions: CrewAppAction[] = [];
				if (Array.isArray(raw.actions)) {
					for (const a of raw.actions) {
						if (!a || typeof a !== 'object') {
							continue;
						}
						const obj = a as Record<string, unknown>;
						if (
							typeof obj.id === 'string' && obj.id.trim()
							&& typeof obj.label === 'string' && obj.label.trim()
							&& (obj.kind === 'prompt' || obj.kind === 'command')
							&& typeof obj.value === 'string' && obj.value.trim()
						) {
							actions.push({
								id: obj.id.trim(),
								label: obj.label.trim(),
								kind: obj.kind,
								value: obj.value.trim(),
							});
						}
					}
				}
				apps.push({ id: entry.name, name, version, description, manifestPath, actions });
			} catch {
				// Skip invalid app directory
			}
		}
		return apps.sort((a, b) => a.name.localeCompare(b.name));
	}

	async createAppTemplate(workspaceRoot: string, rawName: string, description: string): Promise<CrewAppManifest> {
		const id = sanitizeSlug(rawName);
		if (!id || id === '.' || id === '..') {
			throw new Error('Invalid Crew App name.');
		}
		const rootAbs = path.resolve(this.getAppsDir(workspaceRoot));
		const appDir = path.resolve(rootAbs, id);
		if (!appDir.startsWith(rootAbs + path.sep)) {
			throw new Error('Crew App destination escapes .tarot/crew/apps/.');
		}
		await fs.mkdir(appDir, { recursive: true });
		const manifestPath = path.join(appDir, 'app.json');
		const manifestObj = {
			id,
			name: rawName.trim(),
			version: '0.1.0',
			description: description.trim() || `Micro-app personalizado ${rawName.trim()} para Tarot Crew.`,
			actions: [
				{
					id: 'health-check',
					label: 'Run Git Status Check',
					kind: 'command',
					value: 'git status -sb',
				},
				{
					id: 'summarize',
					label: 'Ask Crewmate for Status Summary',
					kind: 'prompt',
					value: 'Resuma o estado atual do repositório, alterações pendentes e próximos passos recomendados.',
				},
			],
		};
		await fs.writeFile(manifestPath, JSON.stringify(manifestObj, null, 2) + '\n', 'utf8');
		return {
			id,
			name: manifestObj.name,
			version: manifestObj.version,
			description: manifestObj.description,
			manifestPath,
			actions: manifestObj.actions as CrewAppAction[],
		};
	}

	// ---- Remote SSH Crew Instances ----

	async listRemotes(workspaceRoot: string): Promise<RemoteSshProfile[]> {
		try {
			const raw = JSON.parse(await fs.readFile(this.getRemotesPath(workspaceRoot), 'utf8'));
			if (!Array.isArray(raw)) {
				return [];
			}
			return raw.filter((r): r is RemoteSshProfile =>
				Boolean(r && typeof r === 'object' && validateRemoteSshProfile(r as Partial<RemoteSshProfile>).ok),
			);
		} catch {
			return [];
		}
	}

	async saveRemote(workspaceRoot: string, profile: RemoteSshProfile): Promise<void> {
		const check = validateRemoteSshProfile(profile);
		if (!check.ok) {
			throw new Error(check.error);
		}
		const existing = await this.listRemotes(workspaceRoot);
		const next = [...existing.filter(r => r.id !== profile.id), profile];
		const filePath = this.getRemotesPath(workspaceRoot);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, JSON.stringify(next, null, 2) + '\n', 'utf8');
	}

	/** Checks connectivity and lists remote Crewmates over SSH (`BatchMode=yes`, `shell: false`). */
	async checkRemoteCrewStatus(profile: RemoteSshProfile): Promise<{ readonly ok: boolean; readonly output: string }> {
		const check = validateRemoteSshProfile(profile);
		if (!check.ok) {
			return { ok: false, output: check.error ?? 'Invalid SSH profile.' };
		}
		const sshBin = await resolveBinaryPath('ssh');
		if (!sshBin) {
			return { ok: false, output: 'ssh binary was not found on PATH.' };
		}
		const target = profile.user ? `${profile.user}@${profile.host}` : profile.host;
		const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8'];
		if (profile.port) {
			args.push('-p', String(profile.port));
		}
		const safeDir = profile.remoteCrewDir.replace(/'/g, `'\\''`);
		args.push('--', target, `ls -1 '${safeDir}/crewmates' 2>/dev/null || echo "(no remote crewmates found)"`);
		const res = await execSimple(sshBin, args, 12_000);
		if (res.exitCode !== 0) {
			return { ok: false, output: res.stderr.trim() || `ssh exited with code ${res.exitCode}` };
		}
		return { ok: true, output: res.stdout.trim() || 'Connected (empty crewmates dir)' };
	}
}
