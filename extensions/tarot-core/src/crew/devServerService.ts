/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface DiscoveredDevServerScript {
	readonly id: string;
	readonly name: string;
	readonly command: string;
	readonly packageDir: string;
}

const DEV_SCRIPT_NAME_RE = /^(dev|start|serve|preview|watch|storybook)(:|$|-)/i;

/**
 * Pure parser that discovers dev-server scripts (`dev`, `start`, `serve`, `preview`, `watch*`)
 * from a workspace's `package.json`. Unit-testable without VS Code host.
 */
export function extractDevServerScripts(rawPackageJson: unknown, packageDir: string): DiscoveredDevServerScript[] {
	if (!rawPackageJson || typeof rawPackageJson !== 'object' || Array.isArray(rawPackageJson)) {
		return [];
	}
	const scripts = (rawPackageJson as { scripts?: unknown }).scripts;
	if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) {
		return [];
	}
	const out: DiscoveredDevServerScript[] = [];
	for (const [name, value] of Object.entries(scripts as Record<string, unknown>)) {
		if (typeof value !== 'string' || !value.trim()) {
			continue;
		}
		if (!DEV_SCRIPT_NAME_RE.test(name)) {
			continue;
		}
		out.push({
			id: `${path.basename(packageDir)}:${name}`,
			name,
			command: value.trim(),
			packageDir,
		});
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

export class TarotDevServerService {
	async discoverScripts(workspaceRoot: string): Promise<DiscoveredDevServerScript[]> {
		const pkgPath = path.join(workspaceRoot, 'package.json');
		try {
			const raw = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
			return extractDevServerScripts(raw, workspaceRoot);
		} catch {
			return [];
		}
	}
}
