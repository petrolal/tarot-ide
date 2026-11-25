/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSimple, resolveBinaryPath } from '../agents/processRunner';
import { McpServerConfig, parseMcpConfigJson } from '../mcp/mcpConfigService';
import { parseYamlLite } from '../permissions/yamlLite';
import { parseGitSkillUrl, SkillDefinition, TarotSkillsService } from '../skills/skillsService';

export type PowerScope = 'workspace' | 'global';

export interface PowerPluginManifest {
	readonly name: string;
	readonly description: string;
	readonly keywords: readonly string[];
	readonly version?: string;
	readonly author?: string;
}

export interface PowerDefinition {
	readonly id: string;
	readonly manifest: PowerPluginManifest;
	readonly scope: PowerScope;
	readonly dirPath: string;
	readonly manifestPath: string;
	readonly skills: readonly SkillDefinition[];
	readonly mcpServers: readonly McpServerConfig[];
}

export interface PowerActivationResult {
	readonly activePowers: readonly PowerDefinition[];
	readonly skills: readonly SkillDefinition[];
	readonly mcpServers: readonly McpServerConfig[];
	readonly summaryContext?: string;
}

export interface CuratedPowerTemplate {
	readonly id: string;
	readonly name: string;
	readonly version: string;
	readonly author: string;
	readonly description: string;
	readonly keywords: readonly string[];
	readonly skillName: string;
	readonly skillDescription: string;
	readonly skillBodyPtBr: string;
}

/** Offline curated starter Powers available for 1-click installation (zero remote endpoints). */
export const CURATED_POWERS_CATALOG: readonly CuratedPowerTemplate[] = [
	{
		id: 'git-workflow',
		name: 'Git & PR Workflow',
		version: '1.0.0',
		author: 'Tarot IDE',
		description: 'Conventional Commits, atomic branching, diff hygiene, and pre-PR checklists.',
		keywords: ['git', 'commit', 'pr', 'pull request', 'rebase', 'branch', 'merge'],
		skillName: 'git-workflow',
		skillDescription: 'Boas práticas de commits atômicos, revisão de diff e preparação de Pull Requests.',
		skillBodyPtBr: [
			'# Power: Git & PR Workflow',
			'',
			'## Regras de Execução',
			'1. Mantenha commits atômicos, coesos e com mensagens no padrão Conventional Commits em inglês (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`).',
			'2. Antes de commitar, inspecione `git status` e `git diff --stat` para evitar arquivos temporários ou segredos.',
			'3. Em revisões pré-PR, valide regressões, cobertura de testes, segurança e impacto em contratos públicos.',
		].join('\n'),
	},
	{
		id: 'testing-tdd',
		name: 'Testing & TDD Discipline',
		version: '1.0.0',
		author: 'Tarot IDE',
		description: 'Red-Green-Refactor loop, deterministic unit tests, and regression harnesses.',
		keywords: ['test', 'tests', 'tdd', 'unit test', 'coverage', 'jest', 'vitest', 'node:test', 'mocha'],
		skillName: 'testing-tdd',
		skillDescription: 'Fluxo Red-Green-Refactor, isolamento de dependências e testes determinísticos.',
		skillBodyPtBr: [
			'# Power: Testing & TDD Discipline',
			'',
			'## Regras de Execução',
			'1. Para bugs, reproduza a falha em um teste automatizado antes de corrigir o código.',
			'2. Prefira funções puras e injeção de dependências para manter testes rápidos e sem flakiness.',
			'3. Cubra caminhos felizes, bordas (vazio, limites, caracteres especiais) e caminhos de erro/segurança.',
		].join('\n'),
	},
	{
		id: 'security-audit',
		name: 'Security & AppSec Audit',
		version: '1.0.0',
		author: 'Tarot IDE',
		description: 'OWASP Top 10 checks, injection prevention, SSRF/path traversal guards, and CSP hygiene.',
		keywords: ['security', 'appsec', 'xss', 'ssrf', 'csrf', 'csp', 'injection', 'auth', 'vulnerability'],
		skillName: 'security-audit',
		skillDescription: 'Auditoria de segurança focada em injeção, SSRF, path traversal, CSP e gestão de segredos.',
		skillBodyPtBr: [
			'# Power: Security & AppSec Audit',
			'',
			'## Checklist Obrigatório',
			'1. Nunca concatene entrada do usuário em comandos de shell (`shell: false` obrigatório) ou consultas SQL.',
			'2. Valide confinamento de caminhos (`path.resolve` + verificação de prefixo) em toda operação de escrita/remoção.',
			'3. Em webviews e front-end, aplique CSP estrita com `nonce` e jamais injete HTML bruto com dados não confiáveis (prefira `textContent` e DOM seguro).',
			'4. Nunca registre tokens, chaves de API ou credenciais em logs ou arquivos versionados.',
		].join('\n'),
	},
	{
		id: 'docs-architect',
		name: 'Docs & ADR Architect',
		version: '1.0.0',
		author: 'Tarot IDE',
		description: 'Architecture Decision Records (ADRs), C4/Mermaid diagrams, and concise technical documentation.',
		keywords: ['docs', 'documentation', 'adr', 'readme', 'architecture', 'mermaid', 'diagram'],
		skillName: 'docs-architect',
		skillDescription: 'Escrita de ADRs, diagramas Mermaid claros e documentação sincronizada com o código.',
		skillBodyPtBr: [
			'# Power: Docs & ADR Architect',
			'',
			'## Diretrizes',
			'1. Documente decisões arquiteturais no formato ADR (Contexto, Decisão, Alternativas, Consequências).',
			'2. Use diagramas Mermaid válidos (`flowchart`, `sequenceDiagram`, `stateDiagram-v2`) com rótulos entre aspas quando houver símbolos.',
			'3. Mantenha exemplos executáveis e caminhos de arquivo verificados contra o estado atual do repositório.',
		].join('\n'),
	},
	{
		id: 'api-design',
		name: 'API & Contract Design',
		version: '1.0.0',
		author: 'Tarot IDE',
		description: 'REST/OpenAPI/GraphQL schema design, backwards compatibility, pagination, and error envelopes.',
		keywords: ['api', 'rest', 'openapi', 'swagger', 'graphql', 'endpoint', 'schema', 'webhook'],
		skillName: 'api-design',
		skillDescription: 'Design de contratos REST/GraphQL, versionamento, paginação e tratamento consistente de erros.',
		skillBodyPtBr: [
			'# Power: API & Contract Design',
			'',
			'## Diretrizes',
			'1. Garanta compatibilidade retroativa ao evoluir payloads (prefira campos aditivos opcionais).',
			'2. Padronize envelopes de erro com código semântico, mensagem acionável e status HTTP adequado.',
			'3. Valide todos os parâmetros de entrada na fronteira com schemas explícitos e limites de paginação.',
		].join('\n'),
	},
];

function sanitizePowerId(raw: string): string {
	return raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^\.+/, '');
}

/** Parses a Power `plugin.json` manifest (Agent Plugins format). Pure — unit-testable. */
export function parsePowerManifest(raw: unknown, fallbackName: string): PowerPluginManifest | undefined {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return undefined;
	}
	const obj = raw as Record<string, unknown>;
	const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : fallbackName;
	const description = typeof obj.description === 'string' ? obj.description.trim() : '';
	const keywords = Array.isArray(obj.keywords)
		? obj.keywords.filter((k): k is string => typeof k === 'string' && k.trim().length > 0).map(k => k.trim().toLowerCase())
		: [];
	const version = typeof obj.version === 'string' && obj.version.trim() ? obj.version.trim() : undefined;
	const author = typeof obj.author === 'string' && obj.author.trim() ? obj.author.trim() : undefined;
	return { name, description, keywords, version, author };
}

/** Parses a legacy/compat `POWER.md` manifest with YAML frontmatter. Pure — unit-testable. */
export function parsePowerMarkdown(raw: string, fallbackName: string): {
	readonly manifest: PowerPluginManifest;
	readonly body: string;
} {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) {
		return {
			manifest: { name: fallbackName, description: '', keywords: [] },
			body: raw.trim(),
		};
	}
	let meta: Record<string, unknown> = {};
	try {
		const parsed = parseYamlLite(match[1]);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			meta = parsed as Record<string, unknown>;
		}
	} catch {
		// Ignore malformed frontmatter
	}
	const manifest = parsePowerManifest(meta, fallbackName) ?? { name: fallbackName, description: '', keywords: [] };
	return { manifest, body: match[2].trim() };
}

/**
 * Activates Powers on demand when the prompt mentions any of their declared `keywords` (or
 * `/power:<id>`, `#<id>`, `/<id>`), and naturally deactivates them on subsequent turns when the
 * topic changes. Pure — unit-testable.
 */
export function matchPowersForPrompt(powers: readonly PowerDefinition[], prompt: string): PowerActivationResult {
	const promptLower = prompt.toLowerCase();
	const activePowers: PowerDefinition[] = [];

	for (const power of powers) {
		const idLower = power.id.toLowerCase();
		const escapedId = idLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const explicit = new RegExp(`(?:^|\\s)(?:/power:|#|/)${escapedId}(?:\\b|$)`, 'i').test(promptLower);
		const keywordHit = power.manifest.keywords.some(kw => {
			const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			return new RegExp(`(?:^|[^a-z0-9_])${escaped}(?:[^a-z0-9_]|$)`, 'i').test(promptLower);
		});
		if (explicit || keywordHit) {
			activePowers.push(power);
		}
	}

	const skills = activePowers.flatMap(p => p.skills);
	const mcpServers = activePowers.flatMap(p => p.mcpServers);
	const summaryContext = activePowers.length > 0
		? `Active Powers: ${activePowers.map(p => `${p.manifest.name} (${p.skills.length} skills, ${p.mcpServers.length} MCP servers)`).join(', ')}`
		: undefined;

	return { activePowers, skills, mcpServers, summaryContext };
}

/**
 * Discovers, installs, creates and removes Powers (`plugin.json` or `POWER.md` + optional
 * `skills/` + optional `mcp.json`) from `.tarot/powers/` (workspace) and `~/.tarot/powers/`
 * (global). Callers must gate workspace discovery on `vscode.workspace.isTrusted`.
 */
export class TarotPowersService {
	constructor(private readonly skillsService: TarotSkillsService) { }

	getGlobalPowersDir(): string {
		return path.join(os.homedir(), '.tarot', 'powers');
	}

	getWorkspacePowersDir(workspaceRoot: string): string {
		return path.join(workspaceRoot, '.tarot', 'powers');
	}

	getCuratedCatalog(): readonly CuratedPowerTemplate[] {
		return CURATED_POWERS_CATALOG;
	}

	async discover(workspaceRoot?: string): Promise<PowerDefinition[]> {
		const byId = new Map<string, PowerDefinition>();
		for (const p of await this.readPowersDir(this.getGlobalPowersDir(), 'global')) {
			byId.set(p.id.toLowerCase(), p);
		}
		if (workspaceRoot) {
			for (const p of await this.readPowersDir(this.getWorkspacePowersDir(workspaceRoot), 'workspace')) {
				byId.set(p.id.toLowerCase(), p);
			}
		}
		return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
	}

	async readSinglePower(powerDir: string, id: string, scope: PowerScope): Promise<PowerDefinition | undefined> {
		const pluginFile = path.join(powerDir, 'plugin.json');
		const powerMdFile = path.join(powerDir, 'POWER.md');
		let manifest: PowerPluginManifest | undefined;
		let manifestPath = pluginFile;
		let inlinePowerSkill: SkillDefinition | undefined;

		try {
			const raw = JSON.parse(await fs.readFile(pluginFile, 'utf8'));
			manifest = parsePowerManifest(raw, id);
		} catch {
			// Try POWER.md fallback
			try {
				const rawMd = await fs.readFile(powerMdFile, 'utf8');
				const parsedMd = parsePowerMarkdown(rawMd, id);
				manifest = parsedMd.manifest;
				manifestPath = powerMdFile;
				if (parsedMd.body) {
					inlinePowerSkill = {
						id,
						name: parsedMd.manifest.name,
						description: parsedMd.manifest.description,
						scope: 'power',
						dirPath: powerDir,
						skillFilePath: powerMdFile,
						body: parsedMd.body,
						hasScripts: false,
						hasReferences: false,
					};
				}
			} catch {
				return undefined;
			}
		}

		if (!manifest) {
			return undefined;
		}
		const dirSkills = await this.skillsService.readSkillsDir(path.join(powerDir, 'skills'), 'power');
		const skills = inlinePowerSkill && dirSkills.length === 0 ? [inlinePowerSkill] : dirSkills;
		let mcpServers: McpServerConfig[] = [];
		try {
			const mcpRaw = JSON.parse(await fs.readFile(path.join(powerDir, 'mcp.json'), 'utf8'));
			mcpServers = parseMcpConfigJson(mcpRaw, path.join(powerDir, 'mcp.json'), scope).servers;
		} catch {
			// Optional mcp.json
		}
		return { id, manifest, scope, dirPath: powerDir, manifestPath, skills, mcpServers };
	}

	private async readPowersDir(dirPath: string, scope: PowerScope): Promise<PowerDefinition[]> {
		let entries;
		try {
			entries = await fs.readdir(dirPath, { withFileTypes: true });
		} catch {
			return [];
		}
		const results: PowerDefinition[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}
			const powerDir = path.join(dirPath, entry.name);
			const def = await this.readSinglePower(powerDir, entry.name, scope);
			if (def) {
				results.push(def);
			}
		}
		return results;
	}

	/** Installs a Power from a local folder containing `plugin.json` or `POWER.md`. */
	async installFromLocalFolder(sourceDir: string, targetRootDir: string, overrideId?: string): Promise<PowerDefinition> {
		const hasPlugin = await fs.access(path.join(sourceDir, 'plugin.json')).then(() => true).catch(() => false);
		const hasPowerMd = await fs.access(path.join(sourceDir, 'POWER.md')).then(() => true).catch(() => false);
		if (!hasPlugin && !hasPowerMd) {
			throw new Error('Power folder must contain plugin.json or POWER.md.');
		}
		const folderName = sanitizePowerId(overrideId ?? path.basename(sourceDir));
		if (!folderName || folderName === '.' || folderName === '..') {
			throw new Error('Invalid power identifier.');
		}
		const targetRootAbs = path.resolve(targetRootDir);
		const destDir = path.resolve(targetRootAbs, folderName);
		if (!destDir.startsWith(targetRootAbs + path.sep)) {
			throw new Error('Power destination escapes the powers directory.');
		}
		await fs.mkdir(targetRootAbs, { recursive: true });
		await fs.cp(sourceDir, destDir, {
			recursive: true,
			force: true,
			filter: src => path.basename(src) !== '.git',
		});
		const scope: PowerScope = targetRootAbs === path.resolve(this.getGlobalPowersDir()) ? 'global' : 'workspace';
		const installed = await this.readSinglePower(destDir, folderName, scope);
		if (!installed) {
			throw new Error('Installed power manifest could not be parsed.');
		}
		return installed;
	}

	/**
	 * Installs a Power from a public GitHub/GitLab URL (optionally with `/tree/<branch>/<subpath>`)
	 * using `git clone --depth 1` with `{ shell: false }` and hardened URL validation.
	 */
	async installFromGitUrl(rawUrl: string, targetRootDir: string): Promise<PowerDefinition> {
		const parsed = parseGitSkillUrl(rawUrl);
		if (!parsed) {
			throw new Error('Provide a valid https:// GitHub or GitLab repository URL.');
		}
		const gitPath = await resolveBinaryPath('git');
		if (!gitPath) {
			throw new Error('git was not found on PATH.');
		}
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tarot-power-import-'));
		try {
			const cloneArgs = ['clone', '--depth', '1'];
			if (parsed.branch) {
				cloneArgs.push('--branch', parsed.branch);
			}
			cloneArgs.push('--', parsed.repoUrl, tmpDir);
			const res = await execSimple(gitPath, cloneArgs, 60_000);
			if (res.exitCode !== 0) {
				throw new Error(res.stderr.trim() || `git clone failed (exit ${res.exitCode}).`);
			}
			const tmpRootAbs = path.resolve(tmpDir);
			const sourceDir = parsed.subpath ? path.resolve(tmpRootAbs, parsed.subpath) : tmpRootAbs;
			if (sourceDir !== tmpRootAbs && !sourceDir.startsWith(tmpRootAbs + path.sep)) {
				throw new Error('Power subpath escapes the cloned repository.');
			}
			const fallbackName = parsed.subpath ? undefined : parsed.repoName;
			return await this.installFromLocalFolder(sourceDir, targetRootDir, fallbackName);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	/** Materializes a Power from `CURATED_POWERS_CATALOG` into `targetRootDir`. */
	async installCuratedPower(powerId: string, targetRootDir: string): Promise<PowerDefinition> {
		const template = CURATED_POWERS_CATALOG.find(p => p.id === powerId);
		if (!template) {
			throw new Error(`Curated power "${powerId}" not found.`);
		}
		const targetRootAbs = path.resolve(targetRootDir);
		const destDir = path.resolve(targetRootAbs, template.id);
		if (!destDir.startsWith(targetRootAbs + path.sep)) {
			throw new Error('Power destination escapes the powers directory.');
		}
		const skillDir = path.join(destDir, 'skills', template.skillName);
		await fs.mkdir(skillDir, { recursive: true });
		const manifestObj = {
			name: template.name,
			version: template.version,
			author: template.author,
			description: template.description,
			keywords: [...template.keywords],
		};
		await fs.writeFile(path.join(destDir, 'plugin.json'), JSON.stringify(manifestObj, null, 2) + '\n', 'utf8');
		const skillMd = [
			'---',
			`name: ${template.skillName}`,
			`description: ${template.skillDescription}`,
			'---',
			'',
			template.skillBodyPtBr,
			'',
		].join('\n');
		await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillMd, 'utf8');
		const scope: PowerScope = targetRootAbs === path.resolve(this.getGlobalPowersDir()) ? 'global' : 'workspace';
		const installed = await this.readSinglePower(destDir, template.id, scope);
		if (!installed) {
			throw new Error('Failed to load installed curated power.');
		}
		return installed;
	}

	/** Creates a custom Power scaffold (`plugin.json` + `skills/<id>/SKILL.md`) with path confinement. */
	async createPowerTemplate(
		targetRootDir: string,
		rawId: string,
		description: string,
		keywords: readonly string[],
	): Promise<PowerDefinition> {
		const folderName = sanitizePowerId(rawId);
		if (!folderName || folderName === '.' || folderName === '..') {
			throw new Error('Invalid power identifier.');
		}
		const targetRootAbs = path.resolve(targetRootDir);
		const destDir = path.resolve(targetRootAbs, folderName);
		if (!destDir.startsWith(targetRootAbs + path.sep)) {
			throw new Error('Power destination escapes the powers directory.');
		}
		const skillDir = path.join(destDir, 'skills', folderName);
		await fs.mkdir(skillDir, { recursive: true });
		const cleanKeywords = keywords.map(k => k.trim().toLowerCase()).filter(Boolean);
		const manifestObj = {
			name: folderName,
			version: '0.1.0',
			description: description.trim() || `Power personalizado ${folderName}.`,
			keywords: cleanKeywords.length > 0 ? cleanKeywords : [folderName],
		};
		await fs.writeFile(path.join(destDir, 'plugin.json'), JSON.stringify(manifestObj, null, 2) + '\n', 'utf8');
		const skillMd = [
			'---',
			`name: ${folderName}`,
			`description: ${manifestObj.description}`,
			'---',
			'',
			`# Power: ${folderName}`,
			'',
			'## Instruções',
			'1. Descreva aqui as regras de domínio ativadas sob demanda por este Power.',
			'2. Opcionalmente adicione `mcp.json` na raiz do Power para acoplar servidores MCP.',
			'',
		].join('\n');
		await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillMd, 'utf8');
		const scope: PowerScope = targetRootAbs === path.resolve(this.getGlobalPowersDir()) ? 'global' : 'workspace';
		const created = await this.readSinglePower(destDir, folderName, scope);
		if (!created) {
			throw new Error('Failed to load created power.');
		}
		return created;
	}

	/** Safely removes an installed Power after verifying strict containment inside allowed roots. */
	async uninstallPower(powerDir: string, allowedRoots: readonly string[]): Promise<void> {
		const targetAbs = path.resolve(powerDir);
		const isContained = allowedRoots.some(root => {
			const rootAbs = path.resolve(root);
			return targetAbs !== rootAbs && targetAbs.startsWith(rootAbs + path.sep);
		});
		if (!isContained) {
			throw new Error('Refusing to uninstall power outside allowed powers directories.');
		}
		await fs.rm(targetAbs, { recursive: true, force: false });
	}
}
