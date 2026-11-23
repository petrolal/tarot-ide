/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSimple, resolveBinaryPath } from '../agents/processRunner';

export type SkillScope = 'workspace' | 'global' | 'power';

export interface SkillDefinition {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly scope: SkillScope;
	readonly dirPath: string;
	readonly skillFilePath: string;
	readonly body: string;
	readonly hasScripts: boolean;
	readonly hasReferences: boolean;
}

export interface ResolvedSkillsResult {
	/** Compact name+description catalog always offered for progressive disclosure. */
	readonly catalogContext?: string;
	/** Full instructions for skills explicitly invoked (`/name`, `$name`) or matched to the prompt. */
	readonly activeSkills: readonly SkillDefinition[];
	readonly activeContext?: string;
}

const STOPWORDS = new Set([
	'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'where', 'what', 'which',
	'your', 'have', 'will', 'should', 'must', 'about', 'using', 'used', 'skill', 'skills',
	'para', 'com', 'que', 'uma', 'das', 'dos', 'por', 'como', 'mais', 'quando', 'sobre',
]);

function tokenize(text: string): Set<string> {
	const tokens = text
		.toLowerCase()
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9_-]+/g, ' ')
		.split(/\s+/)
		.filter(t => t.length >= 3 && !STOPWORDS.has(t));
	return new Set(tokens);
}

/** Parses YAML-like frontmatter of a `SKILL.md` file (Agent Skills standard). Pure — unit-testable. */
export function parseSkillMarkdown(raw: string, fallbackName: string): {
	readonly name: string;
	readonly description: string;
	readonly body: string;
} {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) {
		return { name: fallbackName, description: '', body: raw.trim() };
	}
	const frontmatter = match[1];
	const body = match[2].trim();
	let name = fallbackName;
	let description = '';
	for (const line of frontmatter.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) {
			continue;
		}
		const kv = trimmed.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
		if (!kv) {
			continue;
		}
		const val = kv[2].trim().replace(/^["']|["']$/g, '');
		if (kv[1] === 'name' && val) {
			name = val;
		} else if (kv[1] === 'description' && val) {
			description = val;
		}
	}
	return { name, description, body };
}

/**
 * Progressive-disclosure resolution of discovered skills against a user prompt:
 * - Always exposes a lightweight catalog (`name: description`) when skills exist.
 * - Loads full `SKILL.md` instructions when invoked via `/name`, `$name`, or when prompt tokens
 *   strongly overlap the skill's name/description.
 * - Skills >= 30,000 chars are still loaded in full when they fit `maxBudgetChars`.
 */
export function resolveSkillsForPrompt(
	skills: readonly SkillDefinition[],
	prompt: string,
	options?: { readonly explicitSkillIds?: readonly string[]; readonly maxBudgetChars?: number },
): ResolvedSkillsResult {
	if (skills.length === 0) {
		return { activeSkills: [] };
	}

	const maxBudget = options?.maxBudgetChars ?? 120_000;
	const explicit = new Set((options?.explicitSkillIds ?? []).map(s => s.toLowerCase()));
	const promptTokens = tokenize(prompt);

	const active: SkillDefinition[] = [];
	const activeIds = new Set<string>();

	for (const skill of skills) {
		const idLower = skill.id.toLowerCase();
		const nameLower = skill.name.toLowerCase();
		const escapedId = idLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const slashOrDollar = new RegExp(`(?:^|\\s)[/$]${escapedId}(?:\\b|$)`, 'i').test(prompt);
		const isExplicit = explicit.has(idLower) || explicit.has(nameLower) || slashOrDollar;

		let autoMatched = false;
		if (!isExplicit && skill.description) {
			const descTokens = tokenize(`${skill.id} ${skill.name} ${skill.description}`);
			let overlap = 0;
			for (const tok of descTokens) {
				if (promptTokens.has(tok)) {
					overlap++;
				}
			}
			autoMatched = overlap >= 2 || (descTokens.size <= 2 && overlap >= 1);
		}

		if (isExplicit || autoMatched) {
			active.push(skill);
			activeIds.add(idLower);
		}
	}

	const catalogLines = skills.map(s => `- \`/${s.id}\` (${s.scope}): ${s.description || s.name}`);
	const catalogContext = `Available Skills (invoke via /name or $name):\n${catalogLines.join('\n')}`;

	let usedChars = 0;
	const activeBlocks: string[] = [];
	for (const skill of active) {
		const header = `### Skill: ${skill.name} [${skill.scope} · ${skill.skillFilePath}]`;
		const block = `${header}\n${skill.body}`;
		if (usedChars + block.length <= maxBudget || activeBlocks.length === 0) {
			activeBlocks.push(block);
			usedChars += block.length;
		}
	}

	return {
		catalogContext,
		activeSkills: active,
		activeContext: activeBlocks.length > 0 ? activeBlocks.join('\n\n') : undefined,
	};
}

/**
 * Discovers, resolves and imports Agent Skills (`SKILL.md` + optional `scripts/`, `references/`)
 * from `.tarot/skills/` (workspace, higher priority) and `~/.tarot/skills/` (global).
 * Callers must gate workspace discovery on `vscode.workspace.isTrusted`.
 */
export class TarotSkillsService {
	getGlobalSkillsDir(): string {
		return path.join(os.homedir(), '.tarot', 'skills');
	}

	getWorkspaceSkillsDir(workspaceRoot: string): string {
		return path.join(workspaceRoot, '.tarot', 'skills');
	}

	async discover(workspaceRoot?: string, extraPowerSkills?: readonly SkillDefinition[]): Promise<SkillDefinition[]> {
		const byId = new Map<string, SkillDefinition>();

		// 1. Global ~/.tarot/skills/<name>/SKILL.md
		for (const s of await this.readSkillsDir(this.getGlobalSkillsDir(), 'global')) {
			byId.set(s.id.toLowerCase(), s);
		}
		// 2. Active Power skills
		for (const s of extraPowerSkills ?? []) {
			byId.set(s.id.toLowerCase(), s);
		}
		// 3. Workspace .tarot/skills/<name>/SKILL.md (wins over global/power)
		if (workspaceRoot) {
			for (const s of await this.readSkillsDir(this.getWorkspaceSkillsDir(workspaceRoot), 'workspace')) {
				byId.set(s.id.toLowerCase(), s);
			}
		}

		return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
	}

	async readSkillsDir(dirPath: string, scope: SkillScope): Promise<SkillDefinition[]> {
		let entries;
		try {
			entries = await fs.readdir(dirPath, { withFileTypes: true });
		} catch {
			return [];
		}

		const results: SkillDefinition[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}
			const skillDir = path.join(dirPath, entry.name);
			const skillFile = path.join(skillDir, 'SKILL.md');
			try {
				const raw = await fs.readFile(skillFile, 'utf8');
				const parsed = parseSkillMarkdown(raw, entry.name);
				const hasScripts = await fs.stat(path.join(skillDir, 'scripts')).then(s => s.isDirectory()).catch(() => false);
				const hasReferences = await fs.stat(path.join(skillDir, 'references')).then(s => s.isDirectory()).catch(() => false);
				results.push({
					id: entry.name,
					name: parsed.name,
					description: parsed.description,
					scope,
					dirPath: skillDir,
					skillFilePath: skillFile,
					body: parsed.body,
					hasScripts,
					hasReferences,
				});
			} catch {
				// Directory without SKILL.md; skip.
			}
		}
		return results;
	}

	/** Imports a skill from a local folder containing `SKILL.md` into workspace or global skills dir. */
	async importFromLocalFolder(sourceDir: string, targetRootDir: string): Promise<SkillDefinition> {
		const skillFile = path.join(sourceDir, 'SKILL.md');
		await fs.access(skillFile);
		const folderName = path.basename(sourceDir).replace(/[^a-zA-Z0-9._-]+/g, '-');
		const destDir = path.join(targetRootDir, folderName);
		await fs.mkdir(targetRootDir, { recursive: true });
		await fs.cp(sourceDir, destDir, { recursive: true, force: true });
		const raw = await fs.readFile(path.join(destDir, 'SKILL.md'), 'utf8');
		const parsed = parseSkillMarkdown(raw, folderName);
		return {
			id: folderName,
			name: parsed.name,
			description: parsed.description,
			scope: targetRootDir === this.getGlobalSkillsDir() ? 'global' : 'workspace',
			dirPath: destDir,
			skillFilePath: path.join(destDir, 'SKILL.md'),
			body: parsed.body,
			hasScripts: await fs.stat(path.join(destDir, 'scripts')).then(s => s.isDirectory()).catch(() => false),
			hasReferences: await fs.stat(path.join(destDir, 'references')).then(s => s.isDirectory()).catch(() => false),
		};
	}

	/**
	 * Imports a skill from a GitHub/GitLab repository URL (optionally pointing at a subpath like
	 * `https://github.com/org/repo/tree/main/skills/my-skill`) using `git clone --depth 1` with
	 * `{ shell: false }`.
	 */
	async importFromGitUrl(rawUrl: string, targetRootDir: string): Promise<SkillDefinition> {
		const parsed = parseGitSkillUrl(rawUrl);
		if (!parsed) {
			throw new Error('Provide a valid https:// GitHub or GitLab repository URL.');
		}
		const gitPath = await resolveBinaryPath('git');
		if (!gitPath) {
			throw new Error('git was not found on PATH.');
		}
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tarot-skill-import-'));
		try {
			const cloneArgs = ['clone', '--depth', '1'];
			if (parsed.branch) {
				cloneArgs.push('--branch', parsed.branch);
			}
			cloneArgs.push(parsed.repoUrl, tmpDir);
			const res = await execSimple(gitPath, cloneArgs, 60_000);
			if (res.exitCode !== 0) {
				throw new Error(res.stderr.trim() || `git clone failed (exit ${res.exitCode}).`);
			}
			const sourceDir = parsed.subpath ? path.join(tmpDir, parsed.subpath) : tmpDir;
			return await this.importFromLocalFolder(sourceDir, targetRootDir);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
		}
	}
}

export function parseGitSkillUrl(rawUrl: string): { repoUrl: string; branch?: string; subpath?: string } | undefined {
	const trimmed = rawUrl.trim();
	if (!/^https:\/\/[a-zA-Z0-9.-]+\//.test(trimmed)) {
		return undefined;
	}
	// GitHub / GitLab tree URL: https://github.com/owner/repo/tree/<branch>/<subpath>
	const treeMatch = /^(https:\/\/[^/]+\/[^/]+\/[^/]+?)(?:\.git)?\/(?:-\/)?tree\/([^/]+)(?:\/(.+))?$/.exec(trimmed);
	if (treeMatch) {
		return {
			repoUrl: `${treeMatch[1]}.git`,
			branch: treeMatch[2],
			subpath: treeMatch[3]?.replace(/\/+$/, ''),
		};
	}
	return { repoUrl: trimmed };
}
