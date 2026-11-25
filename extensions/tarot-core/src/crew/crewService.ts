/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export type CrewScope = 'workspace' | 'global';

export interface CrewmateDefinition {
	readonly id: string;
	readonly name: string;
	readonly role: string;
	readonly description: string;
	readonly scope: CrewScope;
	readonly dirPath: string;
	readonly configPath: string;
	readonly memoryPath: string;
	readonly ledgerPath: string;
	readonly agentProfileId?: string;
	readonly model?: string;
	readonly starred: boolean;
	readonly createdAt: string;
}

export interface CrewLedgerEntry {
	readonly id: string;
	readonly timestamp: string;
	readonly kind: 'task' | 'session' | 'review' | 'note' | 'schedule';
	readonly summary: string;
	readonly status: 'ok' | 'running' | 'failed' | 'info';
	readonly details?: string;
	readonly sessionId?: string;
}

export interface KnowledgeSource {
	readonly id: string;
	readonly label: string;
	readonly targetPath: string;
	readonly kind: 'file' | 'folder';
	readonly status: 'pending' | 'indexed';
	readonly chunkCount: number;
	readonly lastIndexedAt?: string;
}

export interface KnowledgeChunk {
	readonly sourceId: string;
	readonly filePath: string;
	readonly excerpt: string;
	readonly tokens: readonly string[];
}

export interface KnowledgeHit {
	readonly sourceId: string;
	readonly filePath: string;
	readonly excerpt: string;
	readonly score: number;
}

export interface ParsedTaskItem {
	readonly index: number;
	readonly title: string;
	readonly done: boolean;
	readonly lineNumber: number;
}

export interface DiscoveredTaskFile {
	readonly path: string;
	readonly label: string;
	readonly tasks: readonly ParsedTaskItem[];
	readonly doneCount: number;
	readonly totalCount: number;
}

const IGNORED_KNOWLEDGE_DIRS = new Set(['.git', 'node_modules', 'out', 'dist', '.tarot', '.next', 'coverage']);
const INDEXABLE_EXTS = new Set([
	'.md', '.txt', '.ts', '.tsx', '.js', '.jsx', '.json', '.yaml', '.yml',
	'.py', '.go', '.rs', '.java', '.cs', '.rb', '.php', '.sql', '.sh',
]);

function sanitizeSlug(raw: string): string {
	return raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^\.+/, '');
}

function tokenizeText(text: string): string[] {
	return text
		.toLowerCase()
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9_-]+/g, ' ')
		.split(/\s+/)
		.filter(t => t.length >= 3);
}

/** Parses a `TASK.md` file into ordered checklist items (`- [ ]` / `- [x]`). Pure — unit-testable. */
export function parseTaskMarkdown(raw: string): ParsedTaskItem[] {
	const lines = raw.split(/\r?\n/);
	const items: ParsedTaskItem[] = [];
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(/^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/);
		if (m) {
			items.push({
				index: items.length + 1,
				title: m[2].trim(),
				done: m[1].toLowerCase() === 'x',
				lineNumber: i,
			});
		}
	}
	return items;
}

/** Marks a specific task line (0-based `lineNumber`) as completed `- [x]` in `TASK.md`. Pure — unit-testable. */
export function markTaskDoneInMarkdown(raw: string, lineNumber: number): string {
	const lines = raw.split(/\r?\n/);
	if (lineNumber < 0 || lineNumber >= lines.length) {
		return raw;
	}
	lines[lineNumber] = lines[lineNumber].replace(/^(\s*[-*]\s+\[)\s(\]\s+)/, '$1x$2');
	return lines.join('\n');
}

/**
 * Pure Node.js service for Tarot Crew (Kiro Crew parity):
 * - Persistent Crewmates (`.tarot/crew/crewmates/<id>/` & `~/.tarot/crew/crewmates/<id>/`)
 * - Append-only Work Ledgers (`ledger.jsonl`)
 * - Persistent Memory layers (`preferences.md`, `projects.md`, `history/YYYY-MM-DD.md`)
 * - Local Knowledge Library (`sources.json` + `index.json`, explicit Scan confirmation, zero native deps)
 * - Autonomous `TASK.md` discovery & template generation
 *
 * Callers must gate workspace reads/writes on `vscode.workspace.isTrusted`.
 */
export class TarotCrewService {
	getGlobalCrewDir(): string {
		return path.join(os.homedir(), '.tarot', 'crew');
	}

	getWorkspaceCrewDir(workspaceRoot: string): string {
		return path.join(workspaceRoot, '.tarot', 'crew');
	}

	getCrewmatesDir(root: string | undefined, scope: CrewScope): string {
		const base = scope === 'workspace' && root ? this.getWorkspaceCrewDir(root) : this.getGlobalCrewDir();
		return path.join(base, 'crewmates');
	}

	getMemoryPaths(workspaceRoot?: string): {
		readonly dir: string;
		readonly preferences: string;
		readonly projects: string;
		readonly historyDir: string;
		readonly todayHistory: string;
		readonly lessons: string;
	} {
		const base = workspaceRoot ? this.getWorkspaceCrewDir(workspaceRoot) : this.getGlobalCrewDir();
		const dir = path.join(base, 'memory');
		const today = new Date().toISOString().slice(0, 10);
		return {
			dir,
			preferences: path.join(dir, 'preferences.md'),
			projects: path.join(dir, 'projects.md'),
			historyDir: path.join(dir, 'history'),
			todayHistory: path.join(dir, 'history', `${today}.md`),
			lessons: workspaceRoot
				? path.join(workspaceRoot, '.tarot', 'steering', 'learned-lessons.md')
				: path.join(os.homedir(), '.tarot', 'steering', 'learned-lessons.md'),
		};
	}

	async discoverCrewmates(workspaceRoot?: string): Promise<CrewmateDefinition[]> {
		const byId = new Map<string, CrewmateDefinition>();
		for (const c of await this.readCrewmatesDir(this.getCrewmatesDir(undefined, 'global'), 'global')) {
			byId.set(c.id.toLowerCase(), c);
		}
		if (workspaceRoot) {
			for (const c of await this.readCrewmatesDir(this.getCrewmatesDir(workspaceRoot, 'workspace'), 'workspace')) {
				byId.set(c.id.toLowerCase(), c);
			}
		}
		return [...byId.values()].sort((a, b) => {
			if (a.starred !== b.starred) {
				return a.starred ? -1 : 1;
			}
			return a.name.localeCompare(b.name);
		});
	}

	private async readCrewmatesDir(dirPath: string, scope: CrewScope): Promise<CrewmateDefinition[]> {
		let entries;
		try {
			entries = await fs.readdir(dirPath, { withFileTypes: true });
		} catch {
			return [];
		}
		const results: CrewmateDefinition[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}
			const crewmateDir = path.join(dirPath, entry.name);
			const configPath = path.join(crewmateDir, 'crewmate.json');
			try {
				const raw = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
				results.push({
					id: entry.name,
					name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : entry.name,
					role: typeof raw.role === 'string' && raw.role.trim() ? raw.role.trim() : 'Autonomous Teammate',
					description: typeof raw.description === 'string' ? raw.description.trim() : '',
					scope,
					dirPath: crewmateDir,
					configPath,
					memoryPath: path.join(crewmateDir, 'memory.md'),
					ledgerPath: path.join(crewmateDir, 'ledger.jsonl'),
					agentProfileId: typeof raw.agentProfileId === 'string' && raw.agentProfileId.trim() ? raw.agentProfileId.trim() : undefined,
					model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : undefined,
					starred: raw.starred === true,
					createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString(),
				});
			} catch {
				// Skip invalid crewmate directory
			}
		}
		return results;
	}

	async createCrewmate(options: {
		readonly workspaceRoot?: string;
		readonly scope: CrewScope;
		readonly name: string;
		readonly role: string;
		readonly description: string;
		readonly agentProfileId?: string;
	}): Promise<CrewmateDefinition> {
		const id = sanitizeSlug(options.name);
		if (!id || id === '.' || id === '..') {
			throw new Error('Invalid crewmate name.');
		}
		const rootDir = path.resolve(this.getCrewmatesDir(options.workspaceRoot, options.scope));
		const crewmateDir = path.resolve(rootDir, id);
		if (!crewmateDir.startsWith(rootDir + path.sep)) {
			throw new Error('Crewmate destination escapes the crewmates directory.');
		}
		await fs.mkdir(crewmateDir, { recursive: true });
		const createdAt = new Date().toISOString();
		const configPath = path.join(crewmateDir, 'crewmate.json');
		const memoryPath = path.join(crewmateDir, 'memory.md');
		const ledgerPath = path.join(crewmateDir, 'ledger.jsonl');
		const config = {
			id,
			name: options.name.trim(),
			role: options.role.trim() || 'Autonomous Teammate',
			description: options.description.trim(),
			agentProfileId: options.agentProfileId,
			starred: false,
			createdAt,
		};
		await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
		const memoryTemplate = [
			`# Memória Privada — ${config.name}`,
			'',
			`- **Papel**: ${config.role}`,
			`- **Escopo**: ${options.scope}`,
			'',
			'## Notas & Preferências',
			'- Registre aqui decisões recorrentes, convenções e aprendizados específicos deste Crewmate.',
			'',
		].join('\n');
		await fs.writeFile(memoryPath, memoryTemplate, 'utf8');
		const initEntry: CrewLedgerEntry = {
			id: `led-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
			timestamp: createdAt,
			kind: 'note',
			summary: `Crewmate ${config.name} criado (${config.role}).`,
			status: 'info',
		};
		await fs.writeFile(ledgerPath, JSON.stringify(initEntry) + '\n', 'utf8');

		return {
			id,
			name: config.name,
			role: config.role,
			description: config.description,
			scope: options.scope,
			dirPath: crewmateDir,
			configPath,
			memoryPath,
			ledgerPath,
			agentProfileId: config.agentProfileId,
			starred: false,
			createdAt,
		};
	}

	async toggleStar(crewmate: CrewmateDefinition): Promise<boolean> {
		const raw = JSON.parse(await fs.readFile(crewmate.configPath, 'utf8')) as Record<string, unknown>;
		const next = raw.starred !== true;
		raw.starred = next;
		await fs.writeFile(crewmate.configPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
		return next;
	}

	async appendLedgerEntry(crewmate: CrewmateDefinition, entry: Omit<CrewLedgerEntry, 'id' | 'timestamp'>): Promise<CrewLedgerEntry> {
		const full: CrewLedgerEntry = {
			id: `led-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
			timestamp: new Date().toISOString(),
			...entry,
		};
		await fs.appendFile(crewmate.ledgerPath, JSON.stringify(full) + '\n', 'utf8');
		return full;
	}

	async readLedger(crewmate: CrewmateDefinition, limit = 50): Promise<CrewLedgerEntry[]> {
		try {
			const raw = await fs.readFile(crewmate.ledgerPath, 'utf8');
			const entries: CrewLedgerEntry[] = [];
			for (const line of raw.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed) {
					continue;
				}
				try {
					entries.push(JSON.parse(trimmed) as CrewLedgerEntry);
				} catch {
					// Skip malformed JSONL line
				}
			}
			return entries.slice(-limit).reverse();
		} catch {
			return [];
		}
	}

	async readCrewmateMemory(crewmate: CrewmateDefinition): Promise<string> {
		try {
			return await fs.readFile(crewmate.memoryPath, 'utf8');
		} catch {
			return '';
		}
	}

	async ensureMemoryFile(workspaceRoot: string | undefined, kind: 'preferences' | 'projects' | 'todayHistory'): Promise<string> {
		const paths = this.getMemoryPaths(workspaceRoot);
		const filePath = kind === 'preferences'
			? paths.preferences
			: kind === 'projects'
				? paths.projects
				: paths.todayHistory;
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		try {
			await fs.access(filePath);
		} catch {
			const template = kind === 'preferences'
				? '# Preferências do Usuário (Tarot Crew)\n\n- Estilo de comunicação: direto e técnico.\n- Ferramentas preferidas: pnpm, testes automatizados antes de concluir.\n'
				: kind === 'projects'
					? '# Projetos Ativos (Tarot Crew)\n\n- Liste aqui branches, PRs, objetivos em andamento e bloqueios.\n'
					: `# Histórico Diário — ${new Date().toISOString().slice(0, 10)}\n\n`;
			await fs.writeFile(filePath, template, 'utf8');
		}
		return filePath;
	}

	async appendDailyHistory(workspaceRoot: string | undefined, line: string): Promise<void> {
		const filePath = await this.ensureMemoryFile(workspaceRoot, 'todayHistory');
		const time = new Date().toISOString().slice(11, 19);
		await fs.appendFile(filePath, `- [${time}] ${line.trim()}\n`, 'utf8');
	}

	// ---- Local Knowledge Library ----

	private getKnowledgeDir(workspaceRoot: string): string {
		return path.join(this.getWorkspaceCrewDir(workspaceRoot), 'knowledge');
	}

	async listKnowledgeSources(workspaceRoot: string): Promise<KnowledgeSource[]> {
		const filePath = path.join(this.getKnowledgeDir(workspaceRoot), 'sources.json');
		try {
			const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
			return Array.isArray(raw) ? raw as KnowledgeSource[] : [];
		} catch {
			return [];
		}
	}

	private async saveKnowledgeSources(workspaceRoot: string, sources: readonly KnowledgeSource[]): Promise<void> {
		const dir = this.getKnowledgeDir(workspaceRoot);
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, 'sources.json'), JSON.stringify(sources, null, 2) + '\n', 'utf8');
	}

	/** Registers a knowledge source in `pending` state (requires explicit Scan before indexing). */
	async addKnowledgeSource(workspaceRoot: string, targetPath: string): Promise<KnowledgeSource> {
		const stat = await fs.stat(targetPath);
		const kind: 'file' | 'folder' = stat.isDirectory() ? 'folder' : 'file';
		const sources = await this.listKnowledgeSources(workspaceRoot);
		const existing = sources.find(s => path.resolve(s.targetPath) === path.resolve(targetPath));
		if (existing) {
			return existing;
		}
		const source: KnowledgeSource = {
			id: `kn-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
			label: path.basename(targetPath) || targetPath,
			targetPath: path.resolve(targetPath),
			kind,
			status: 'pending',
			chunkCount: 0,
		};
		await this.saveKnowledgeSources(workspaceRoot, [...sources, source]);
		return source;
	}

	async removeKnowledgeSource(workspaceRoot: string, sourceId: string): Promise<void> {
		const sources = await this.listKnowledgeSources(workspaceRoot);
		await this.saveKnowledgeSources(workspaceRoot, sources.filter(s => s.id !== sourceId));
		const indexPath = path.join(this.getKnowledgeDir(workspaceRoot), 'index.json');
		try {
			const chunks = JSON.parse(await fs.readFile(indexPath, 'utf8')) as KnowledgeChunk[];
			if (Array.isArray(chunks)) {
				await fs.writeFile(indexPath, JSON.stringify(chunks.filter(c => c.sourceId !== sourceId)) + '\n', 'utf8');
			}
		} catch {
			// No index yet
		}
	}

	/** Scans and indexes a registered Knowledge Source into `.tarot/crew/knowledge/index.json`. */
	async scanKnowledgeSource(workspaceRoot: string, sourceId: string, maxFiles = 150): Promise<KnowledgeSource> {
		const sources = await this.listKnowledgeSources(workspaceRoot);
		const source = sources.find(s => s.id === sourceId);
		if (!source) {
			throw new Error(`Knowledge source "${sourceId}" not found.`);
		}
		const files: string[] = [];
		const collect = async (p: string): Promise<void> => {
			if (files.length >= maxFiles) {
				return;
			}
			const st = await fs.stat(p).catch(() => undefined);
			if (!st) {
				return;
			}
			if (st.isFile()) {
				const ext = path.extname(p).toLowerCase();
				if (INDEXABLE_EXTS.has(ext) && st.size <= 256 * 1024) {
					files.push(p);
				}
				return;
			}
			if (st.isDirectory()) {
				const entries = await fs.readdir(p, { withFileTypes: true }).catch(() => []);
				for (const entry of entries) {
					if (files.length >= maxFiles) {
						break;
					}
					if (entry.isDirectory() && IGNORED_KNOWLEDGE_DIRS.has(entry.name)) {
						continue;
					}
					await collect(path.join(p, entry.name));
				}
			}
		};
		await collect(source.targetPath);

		const newChunks: KnowledgeChunk[] = [];
		for (const file of files) {
			const content = await fs.readFile(file, 'utf8').catch(() => '');
			if (!content.trim()) {
				continue;
			}
			// Split into ~1200-char overlapping chunks on paragraph boundaries
			const paragraphs = content.split(/\r?\n\r?\n+/);
			let buffer = '';
			const flush = (): void => {
				const trimmed = buffer.trim();
				if (trimmed.length >= 20) {
					const excerpt = trimmed.slice(0, 1200);
					const tokens = [...new Set(tokenizeText(excerpt))].slice(0, 120);
					if (tokens.length > 0) {
						newChunks.push({ sourceId, filePath: file, excerpt, tokens });
					}
				}
				buffer = '';
			};
			for (const para of paragraphs) {
				if (buffer.length + para.length > 1100 && buffer.length > 0) {
					flush();
				}
				buffer += (buffer ? '\n\n' : '') + para;
			}
			flush();
		}

		const dir = this.getKnowledgeDir(workspaceRoot);
		await fs.mkdir(dir, { recursive: true });
		const indexPath = path.join(dir, 'index.json');
		let existingChunks: KnowledgeChunk[] = [];
		try {
			const parsed = JSON.parse(await fs.readFile(indexPath, 'utf8'));
			if (Array.isArray(parsed)) {
				existingChunks = (parsed as KnowledgeChunk[]).filter(c => c.sourceId !== sourceId);
			}
		} catch {
			// Fresh index
		}
		await fs.writeFile(indexPath, JSON.stringify([...existingChunks, ...newChunks]) + '\n', 'utf8');

		const updated: KnowledgeSource = {
			...source,
			status: 'indexed',
			chunkCount: newChunks.length,
			lastIndexedAt: new Date().toISOString(),
		};
		await this.saveKnowledgeSources(workspaceRoot, sources.map(s => s.id === sourceId ? updated : s));
		return updated;
	}

	async queryKnowledge(workspaceRoot: string, query: string, topK = 5): Promise<KnowledgeHit[]> {
		const qTokens = new Set(tokenizeText(query));
		if (qTokens.size === 0) {
			return [];
		}
		const indexPath = path.join(this.getKnowledgeDir(workspaceRoot), 'index.json');
		let chunks: KnowledgeChunk[] = [];
		try {
			const parsed = JSON.parse(await fs.readFile(indexPath, 'utf8'));
			if (Array.isArray(parsed)) {
				chunks = parsed as KnowledgeChunk[];
			}
		} catch {
			return [];
		}
		const scored: KnowledgeHit[] = [];
		for (const chunk of chunks) {
			let overlap = 0;
			for (const tok of chunk.tokens) {
				if (qTokens.has(tok)) {
					overlap++;
				}
			}
			if (overlap > 0) {
				const score = overlap / Math.sqrt(chunk.tokens.length + qTokens.size);
				scored.push({ sourceId: chunk.sourceId, filePath: chunk.filePath, excerpt: chunk.excerpt, score });
			}
		}
		return scored.sort((a, b) => b.score - a.score).slice(0, topK);
	}

	// ---- Autonomous TASK.md discovery & templates ----

	async discoverTaskFiles(workspaceRoot: string): Promise<DiscoveredTaskFile[]> {
		const candidates: string[] = [];
		const rootTask = path.join(workspaceRoot, 'TASK.md');
		if (await fs.access(rootTask).then(() => true).catch(() => false)) {
			candidates.push(rootTask);
		}
		const crewTasksDir = path.join(this.getWorkspaceCrewDir(workspaceRoot), 'tasks');
		try {
			const entries = await fs.readdir(crewTasksDir, { withFileTypes: true });
			for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
				if (entry.isFile() && entry.name.endsWith('.md')) {
					candidates.push(path.join(crewTasksDir, entry.name));
				}
			}
		} catch {
			// Optional tasks dir
		}

		const results: DiscoveredTaskFile[] = [];
		for (const filePath of candidates) {
			try {
				const raw = await fs.readFile(filePath, 'utf8');
				const tasks = parseTaskMarkdown(raw);
				results.push({
					path: filePath,
					label: path.relative(workspaceRoot, filePath),
					tasks,
					doneCount: tasks.filter(t => t.done).length,
					totalCount: tasks.length,
				});
			} catch {
				// Skip unreadable file
			}
		}
		return results;
	}

	async createTaskTemplate(workspaceRoot: string, rawSlug: string, title: string): Promise<string> {
		const slug = sanitizeSlug(rawSlug);
		if (!slug || slug === '.' || slug === '..') {
			throw new Error('Invalid task file name.');
		}
		const tasksDir = path.resolve(this.getWorkspaceCrewDir(workspaceRoot), 'tasks');
		const filePath = path.resolve(tasksDir, `${slug}.md`);
		if (!filePath.startsWith(tasksDir + path.sep)) {
			throw new Error('Task file escapes .tarot/crew/tasks/.');
		}
		await fs.mkdir(tasksDir, { recursive: true });
		const content = [
			`# TASK: ${title.trim() || slug}`,
			'',
			'## Objetivo',
			'Descreva o objetivo completo para execução autônoma pelo Tarot Crew Task Runner.',
			'',
			'## Etapas',
			'- [ ] Analisar o código relevante e mapear os arquivos impactados',
			'- [ ] Implementar a solução seguindo as regras de arquitetura do projeto',
			'- [ ] Escrever/atualizar testes automatizados e validar que tudo passa',
			'',
			'## Critérios de Aceite',
			'- Zero erros de compilação ou tipagem.',
			'- Todos os testes relevantes passando.',
			'',
		].join('\n');
		await fs.writeFile(filePath, content, 'utf8');
		return filePath;
	}

	/** Builds concise Crew context (memory layers + optional crewmate memory + knowledge hits). */
	async buildCrewContext(workspaceRoot: string | undefined, crewmate?: CrewmateDefinition, prompt?: string): Promise<string | undefined> {
		const sections: string[] = [];
		const paths = this.getMemoryPaths(workspaceRoot);
		const readTrimmed = async (p: string, maxChars: number): Promise<string | undefined> => {
			try {
				const raw = (await fs.readFile(p, 'utf8')).trim();
				return raw ? raw.slice(0, maxChars) : undefined;
			} catch {
				return undefined;
			}
		};

		const prefs = await readTrimmed(paths.preferences, 1500);
		if (prefs) {
			sections.push(`### Crew Preferences\n${prefs}`);
		}
		const projects = await readTrimmed(paths.projects, 1500);
		if (projects) {
			sections.push(`### Active Projects\n${projects}`);
		}
		if (crewmate) {
			const cmMem = await readTrimmed(crewmate.memoryPath, 2000);
			if (cmMem) {
				sections.push(`### Crewmate Memory (${crewmate.name} — ${crewmate.role})\n${cmMem}`);
			}
		}
		if (workspaceRoot && prompt) {
			const hits = await this.queryKnowledge(workspaceRoot, prompt, 3);
			if (hits.length > 0) {
				const formatted = hits.map(h => `- **${path.relative(workspaceRoot, h.filePath)}**:\n${h.excerpt.slice(0, 600)}`).join('\n\n');
				sections.push(`### Knowledge Library Matches\n${formatted}`);
			}
		}
		return sections.length > 0 ? sections.join('\n\n') : undefined;
	}
}
