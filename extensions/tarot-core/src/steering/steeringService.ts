/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AttachedContext } from '../agents/types';

export type SteeringScope = 'agentsMd' | 'global' | 'workspace';
export type SteeringInclusion = 'always' | 'fileMatch' | 'auto' | 'manual';

export interface SteeringDocument {
	id: string;
	name?: string;
	fileName: string;
	filePath: string;
	scope: SteeringScope;
	inclusion: SteeringInclusion;
	fileMatchPattern?: string;
	description?: string;
	body: string;
	raw: string;
}

export interface AppliedSteeringDoc {
	doc: SteeringDocument;
	reason: string;
	label: string;
}

export interface ResolvedSteeringResult {
	applied: AppliedSteeringDoc[];
	formattedContext?: string;
}

const STOPWORDS = new Set([
	'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'where', 'what', 'which',
	'your', 'have', 'will', 'should', 'must', 'about', 'using', 'used', 'file', 'files', 'code',
	'para', 'com', 'que', 'uma', 'uns', 'das', 'dos', 'por', 'como', 'mais', 'quando', 'sobre',
	'este', 'esta', 'esse', 'essa', 'arquivo', 'arquivos', 'codigo', 'projeto', 'regras',
]);

export function parseSteeringFrontmatter(raw: string): {
	inclusion: SteeringInclusion;
	name?: string;
	fileMatchPattern?: string;
	description?: string;
	body: string;
} {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) {
		return { inclusion: 'always', body: raw.trim() };
	}

	const yamlBlock = match[1];
	const body = match[2].trim();
	let inclusion: SteeringInclusion = 'always';
	let name: string | undefined;
	let fileMatchPattern: string | undefined;
	let description: string | undefined;

	const lines = yamlBlock.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line || line.startsWith('#')) {
			continue;
		}
		const kv = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
		if (!kv) {
			continue;
		}
		const key = kv[1];
		const rawVal = kv[2].trim().replace(/^["']|["']$/g, '');

		if (key === 'inclusion') {
			if (rawVal === 'always' || rawVal === 'fileMatch' || rawVal === 'auto' || rawVal === 'manual') {
				inclusion = rawVal;
			}
		} else if (key === 'name' && rawVal.length > 0) {
			name = rawVal;
		} else if (key === 'fileMatchPattern') {
			if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
				const patterns = rawVal.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
				if (patterns.length > 0) {
					fileMatchPattern = patterns.join(',');
				}
			} else if (rawVal.length > 0) {
				fileMatchPattern = rawVal;
			} else {
				// Support simple YAML array on subsequent indented lines
				const patterns: string[] = [];
				while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
					i++;
					patterns.push(lines[i].replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, ''));
				}
				if (patterns.length > 0) {
					fileMatchPattern = patterns.join(',');
				}
			}
		} else if (key === 'description' && rawVal.length > 0) {
			description = rawVal;
		}
	}

	return { inclusion, name, fileMatchPattern, description, body };
}

/**
 * Expands live `#[[file:<relativePath>]]` references inside a steering document body (M3.8b),
 * strictly confined within `workspaceRoot` to prevent path traversal outside the repository.
 */
export async function expandLiveFileReferences(body: string, workspaceRoot?: string): Promise<string> {
	if (!workspaceRoot || !body.includes('#[[file:')) {
		return body;
	}
	const rootAbs = path.resolve(workspaceRoot);
	const regex = /#\[\[file:([^\]\n]+)\]\]/g;
	const matches = [...body.matchAll(regex)];
	if (matches.length === 0) {
		return body;
	}
	let result = body;
	for (const m of matches) {
		const rel = m[1].trim();
		const target = path.resolve(rootAbs, rel);
		if (target !== rootAbs && !target.startsWith(rootAbs + path.sep)) {
			continue;
		}
		try {
			const content = (await fs.readFile(target, 'utf8')).slice(0, 12_000);
			result = result.replace(m[0], `\n\`\`\`\n// ${rel}\n${content}\n\`\`\`\n`);
		} catch {
			// Leave reference intact if file does not exist
		}
	}
	return result;
}

function globToRegExp(glob: string): RegExp {
	const normalized = glob.trim().replace(/\\/g, '/');
	let regex = '^';
	let i = 0;
	while (i < normalized.length) {
		const ch = normalized[i];
		if (ch === '*') {
			if (normalized[i + 1] === '*') {
				if (normalized[i + 2] === '/') {
					regex += '(?:.*/)?';
					i += 3;
					continue;
				}
				regex += '.*';
				i += 2;
				continue;
			}
			regex += '[^/]*';
			i++;
			continue;
		}
		if (ch === '?') {
			regex += '[^/]';
			i++;
			continue;
		}
		if (ch === '{') {
			const closeIdx = normalized.indexOf('}', i);
			if (closeIdx > i) {
				const group = normalized
					.slice(i + 1, closeIdx)
					.split(',')
					.map(part => part.replace(/[.+^$|()[\]\\]/g, '\\$&'))
					.join('|');
				regex += `(?:${group})`;
				i = closeIdx + 1;
				continue;
			}
		}
		regex += ch.replace(/[.+^$|()[\]\\]/g, '\\$&');
		i++;
	}
	regex += '$';
	return new RegExp(regex, 'i');
}

export function matchesGlobPattern(filePath: string, patternSpec: string): boolean {
	const normalizedFile = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
	const patterns = patternSpec.split(',').map(p => p.trim()).filter(Boolean);
	for (const pattern of patterns) {
		const re = globToRegExp(pattern);
		if (re.test(normalizedFile)) {
			return true;
		}
		// Also match basename if pattern has no slash (e.g., "*.ts")
		if (!pattern.includes('/') && re.test(path.posix.basename(normalizedFile))) {
			return true;
		}
	}
	return false;
}

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

export class TarotSteeringService {
	getGlobalSteeringDir(): string {
		return path.join(os.homedir(), '.tarot', 'steering');
	}

	getWorkspaceSteeringDir(workspaceRoot: string): string {
		return path.join(workspaceRoot, '.tarot', 'steering');
	}

	async discover(workspaceRoot?: string): Promise<SteeringDocument[]> {
		const docs: SteeringDocument[] = [];

		// 1. Root & nested AGENTS.md (Kiro & cross-agent standard; M3.8b adds subdirectory support)
		if (workspaceRoot) {
			const nestedAgents = await this.discoverAgentsMdFiles(workspaceRoot);
			docs.push(...nestedAgents);
		}

		// 2. Global ~/.tarot/steering/*.md
		const globalDocs = await this.readSteeringDirectory(this.getGlobalSteeringDir(), 'global');
		docs.push(...globalDocs);

		// 3. Workspace .tarot/steering/*.md
		if (workspaceRoot) {
			const workspaceDocs = await this.readSteeringDirectory(this.getWorkspaceSteeringDir(workspaceRoot), 'workspace');
			docs.push(...workspaceDocs);
		}

		return docs;
	}

	private async discoverAgentsMdFiles(workspaceRoot: string, maxDepth = 3): Promise<SteeringDocument[]> {
		const SKIP_DIRS = new Set(['.git', 'node_modules', '.tarot', 'out', 'dist', '.build']);
		const found: SteeringDocument[] = [];
		const walk = async (dir: string, depth: number) => {
			let entries;
			try {
				entries = await fs.readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				if (entry.isFile() && entry.name === 'AGENTS.md') {
					const fullPath = path.join(dir, entry.name);
					try {
						const raw = await fs.readFile(fullPath, 'utf8');
						if (raw.trim().length === 0) {
							continue;
						}
						const parsed = parseSteeringFrontmatter(raw);
						const relDir = path.relative(workspaceRoot, dir).replace(/\\/g, '/');
						const isRoot = relDir === '' || relDir === '.';
						found.push({
							id: isRoot ? 'AGENTS' : `${relDir}/AGENTS`,
							name: parsed.name,
							fileName: isRoot ? 'AGENTS.md' : `${relDir}/AGENTS.md`,
							filePath: fullPath,
							scope: 'agentsMd',
							inclusion: isRoot ? 'always' : 'fileMatch',
							fileMatchPattern: isRoot ? undefined : `${relDir}/**`,
							description: parsed.description ?? (isRoot ? 'Repository root agent instructions' : `Directory instructions for ${relDir}`),
							body: parsed.body,
							raw,
						});
					} catch {
						// Skip unreadable AGENTS.md
					}
				} else if (entry.isDirectory() && depth < maxDepth && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
					await walk(path.join(dir, entry.name), depth + 1);
				}
			}
		};
		await walk(workspaceRoot, 0);
		return found;
	}

	private async readSteeringDirectory(dirPath: string, scope: 'global' | 'workspace'): Promise<SteeringDocument[]> {
		try {
			const entries = await fs.readdir(dirPath, { withFileTypes: true });
			const mdFiles = entries
				.filter(e => e.isFile() && e.name.endsWith('.md'))
				.sort((a, b) => a.name.localeCompare(b.name));

			const results: SteeringDocument[] = [];
			for (const entry of mdFiles) {
				const fullPath = path.join(dirPath, entry.name);
				try {
					const raw = await fs.readFile(fullPath, 'utf8');
					const parsed = parseSteeringFrontmatter(raw);
					results.push({
						id: entry.name.replace(/\.md$/i, ''),
						name: parsed.name,
						fileName: entry.name,
						filePath: fullPath,
						scope,
						inclusion: parsed.inclusion,
						fileMatchPattern: parsed.fileMatchPattern,
						description: parsed.description,
						body: parsed.body,
						raw,
					});
				} catch {
					// Skip unreadable file
				}
			}
			return results;
		} catch {
			return [];
		}
	}

	async resolveForTurn(params: {
		workspaceRoot?: string;
		prompt: string;
		activeFiles: string[];
		attachments: AttachedContext[];
	}): Promise<ResolvedSteeringResult> {
		const docs = await this.discover(params.workspaceRoot);
		if (docs.length === 0) {
			return { applied: [] };
		}

		const relativeFiles = params.activeFiles.map(f =>
			params.workspaceRoot && f.startsWith(params.workspaceRoot)
				? path.relative(params.workspaceRoot, f).replace(/\\/g, '/')
				: f.replace(/\\/g, '/')
		);

		const promptTokens = tokenize(params.prompt);
		const promptLower = params.prompt.toLowerCase();
		const attachedSteeringPaths = new Set(
			params.attachments
				.filter(a => a.kind === 'steering' && a.path)
				.map(a => a.path!)
		);

		const applied: AppliedSteeringDoc[] = [];

		for (const doc of docs) {
			if (!doc.body) {
				continue;
			}

			// Avoid duplicating a file already explicitly attached via #Steering
			if (attachedSteeringPaths.has(doc.filePath)) {
				applied.push({
					doc,
					reason: 'manual (#Steering)',
					label: `${doc.fileName} (manual)`,
				});
				continue;
			}

			switch (doc.inclusion) {
				case 'always': {
					applied.push({
						doc,
						reason: doc.scope === 'agentsMd' ? 'root AGENTS.md' : 'always',
						label: `${doc.fileName} (always)`,
					});
					break;
				}

				case 'fileMatch': {
					if (doc.fileMatchPattern && relativeFiles.some(f => matchesGlobPattern(f, doc.fileMatchPattern!))) {
						applied.push({
							doc,
							reason: `fileMatch: ${doc.fileMatchPattern}`,
							label: `${doc.fileName} (fileMatch)`,
						});
					}
					break;
				}

				case 'auto': {
					// M3.8b: `auto` steering requires `name` + `description` to auto-match on prompt
					// tokens (explicit `/id` or `#id` still works).
					const escapedId = doc.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
					const explicitRef = new RegExp(`(?:^|\\s)[#/]${escapedId}(?:\\b|$)`, 'i').test(params.prompt)
						|| promptLower.includes(`#${doc.id.toLowerCase()}`);
					let overlap = 0;
					let descTokensSize = 0;
					if (doc.name && doc.description) {
						const descTokens = tokenize(`${doc.id} ${doc.name} ${doc.description}`);
						descTokensSize = descTokens.size;
						for (const token of descTokens) {
							if (promptTokens.has(token)) {
								overlap++;
							}
						}
					}
					if (explicitRef || (doc.name && doc.description && (overlap >= 2 || (descTokensSize <= 2 && overlap >= 1)))) {
						applied.push({
							doc,
							reason: 'auto (relevante ao prompt)',
							label: `${doc.fileName} (auto)`,
						});
					}
					break;
				}

				case 'manual': {
					const escapedId = doc.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
					const refPattern = new RegExp(`(?:^|\\s)[#/]${escapedId}(?:\\b|$)`, 'i');
					if (refPattern.test(params.prompt)) {
						applied.push({
							doc,
							reason: `manual (/${doc.id})`,
							label: `${doc.fileName} (manual)`,
						});
					}
					break;
				}
			}
		}

		// Only serialize docs that aren't already injected verbatim via attached #Steering
		const blocks: string[] = [];
		for (const item of applied) {
			if (attachedSteeringPaths.has(item.doc.filePath)) {
				continue;
			}
			const expandedBody = await expandLiveFileReferences(item.doc.body, params.workspaceRoot);
			blocks.push(`### ${item.doc.fileName} [${item.doc.scope} · ${item.reason}]\n${expandedBody}`);
		}

		return {
			applied,
			formattedContext: blocks.length > 0 ? blocks.join('\n\n') : undefined,
		};
	}

	async ensureFoundationalTemplates(workspaceRoot: string): Promise<string[]> {
		const dir = this.getWorkspaceSteeringDir(workspaceRoot);
		await fs.mkdir(dir, { recursive: true });

		const projectName = path.basename(workspaceRoot);
		const templates: Array<{ fileName: string; content: string }> = [
			{
				fileName: 'product.md',
				content:
					`---\ninclusion: always\ndescription: Visão de produto, público-alvo e objetivos de negócio de ${projectName}\n---\n\n` +
					`# Product Overview — ${projectName}\n\n` +
					`## Propósito\nDescreva o problema que este projeto resolve e o valor entregue aos usuários.\n\n` +
					`## Casos de Uso Principais\n- ...\n\n` +
					`## Princípios de UX & Qualidade\n- ...\n`,
			},
			{
				fileName: 'tech.md',
				content:
					`---\ninclusion: always\ndescription: Stack tecnológica, frameworks, ferramentas de build, testes e restrições técnicas\n---\n\n` +
					`# Technology Stack — ${projectName}\n\n` +
					`## Linguagens & Frameworks\n- ...\n\n` +
					`## Comandos Principais\n- Build: ...\n- Testes: ...\n- Lint / Typecheck: ...\n\n` +
					`## Regras Técnicas Obrigatórias\n- ...\n`,
			},
			{
				fileName: 'structure.md',
				content:
					`---\ninclusion: always\ndescription: Organização de pastas, módulos, convenções de nomeação e arquitetura\n---\n\n` +
					`# Project Structure — ${projectName}\n\n` +
					`## Layout de Diretórios\n- ...\n\n` +
					`## Convenções de Código & Imports\n- ...\n`,
			},
		];

		const created: string[] = [];
		for (const tpl of templates) {
			const fullPath = path.join(dir, tpl.fileName);
			try {
				await fs.access(fullPath);
			} catch {
				await fs.writeFile(fullPath, tpl.content, 'utf8');
				created.push(fullPath);
			}
		}
		return created;
	}

	buildGenerateSteeringPrompt(workspaceRoot: string): string {
		const projectName = path.basename(workspaceRoot);
		return (
			`Analyze the repository "${projectName}" and populate the 3 foundational Tarot Steering documents in \`.tarot/steering/\`:\n` +
			`1. \`.tarot/steering/product.md\` (product purpose, target users, key use cases, UX principles)\n` +
			`2. \`.tarot/steering/tech.md\` (stack, runtime versions, package manager, build/test commands, security/architecture constraints)\n` +
			`3. \`.tarot/steering/structure.md\` (directory tree, module boundaries, naming & import conventions)\n\n` +
			`Preserve the YAML frontmatter (\`inclusion: always\` and \`description\`) at the top of each file and keep every document concise, factual, and grounded in the actual files of this workspace.`
		);
	}
}
