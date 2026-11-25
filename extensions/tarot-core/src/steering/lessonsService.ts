/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SteeringDocument } from './steeringService';

export interface SteeringAuditFinding {
	readonly kind: 'redundant' | 'obsolete-workaround' | 'empty' | 'invalid-frontmatter';
	readonly severity: 'warning' | 'info';
	readonly filePath: string;
	readonly fileName: string;
	readonly message: string;
	readonly relatedFilePath?: string;
}

const LEGACY_MODEL_WORKAROUND_RE = /\b(gpt-3\.5|gpt-4-0314|gpt-4-0613|claude-2|claude-instant|claude-3-opus|claude-3\.5-sonnet|gemini-1\.0|gemini-1\.5|temporary\s+workaround|legacy\s+model\s+workaround|hack\s+for\s+old\s+model)\b/i;

function slugifyLesson(text: string): string {
	return text
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40) || 'lesson';
}

function tokenizeForSimilarity(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.replace(/[^a-z0-9\s]+/g, ' ')
			.split(/\s+/)
			.filter(w => w.length >= 3),
	);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) {
		return 0;
	}
	let intersection = 0;
	for (const token of a) {
		if (b.has(token)) {
			intersection++;
		}
	}
	const union = a.size + b.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

/**
 * Formats a user correction (e.g. `"use pnpm, not npm"`) into an inspectable, editable
 * Steering Markdown document under `.tarot/steering/` (M3.10).
 */
export function formatLessonMarkdown(title: string, ruleText: string, contextNote?: string): string {
	const createdAt = new Date().toISOString();
	const lines = [
		'---',
		'inclusion: always',
		`name: ${title}`,
		'category: lesson',
		`createdAt: ${createdAt}`,
		'---',
		'',
		`# Lição Aprendida — ${title}`,
		'',
		'## Regra Obrigatória',
		`- ${ruleText.trim()}`,
	];
	if (contextNote && contextNote.trim()) {
		lines.push('', '## Contexto', contextNote.trim());
	}
	lines.push('');
	return lines.join('\n');
}

/**
 * Persists a user correction as an editable steering lesson file under `<steeringDir>/lesson-<slug>.md`.
 * Pure Node.js — unit-testable via `node --test`.
 */
export async function saveLessonToSteering(
	steeringDir: string,
	ruleText: string,
	options?: { readonly title?: string; readonly contextNote?: string },
): Promise<{ readonly filePath: string; readonly slug: string }> {
	const title = (options?.title?.trim() || ruleText.trim().slice(0, 52));
	const slug = `lesson-${slugifyLesson(title)}`;
	await fs.mkdir(steeringDir, { recursive: true });
	const filePath = path.join(steeringDir, `${slug}.md`);
	const content = formatLessonMarkdown(title, ruleText, options?.contextNote);
	await fs.writeFile(filePath, content, 'utf8');
	return { filePath, slug };
}

/**
 * Promotes a repeated lesson or steering workflow into an Agent Skill (`<skillsDir>/<slug>/SKILL.md`).
 */
export async function promoteLessonToSkill(
	skillsDir: string,
	name: string,
	description: string,
	instructions: string,
): Promise<{ readonly skillDir: string; readonly skillFilePath: string }> {
	const slug = slugifyLesson(name);
	const skillDir = path.join(skillsDir, slug);
	await fs.mkdir(skillDir, { recursive: true });
	const skillFilePath = path.join(skillDir, 'SKILL.md');
	const body = [
		'---',
		`name: ${name.trim()}`,
		`description: ${description.trim()}`,
		'---',
		'',
		instructions.trim(),
		'',
	].join('\n');
	await fs.writeFile(skillFilePath, body, 'utf8');
	return { skillDir, skillFilePath };
}

/**
 * Audits discovered Steering documents (M3.10 **Audit / Prune Steering**):
 * - Flags empty documents
 * - Flags incomplete frontmatter (`auto` without `description`, `fileMatch` without `fileMatchPattern`)
 * - Flags obsolete model workarounds (`gpt-3.5`, `claude-2`, `gemini-1.5`, `temporary workaround`, etc.)
 * - Flags redundant/near-duplicate steering docs (Jaccard similarity >= 0.7)
 * Pure — zero `vscode` import so it is unit-testable via `node --test`.
 */
export function auditSteeringDocuments(docs: readonly SteeringDocument[]): SteeringAuditFinding[] {
	const findings: SteeringAuditFinding[] = [];
	const tokenCache = docs.map(d => tokenizeForSimilarity(d.body || d.raw));

	for (let i = 0; i < docs.length; i++) {
		const doc = docs[i];
		const text = (doc.body || doc.raw).trim();
		if (text.length < 10) {
			findings.push({
				kind: 'empty',
				severity: 'warning',
				filePath: doc.filePath,
				fileName: doc.fileName,
				message: `Steering file "${doc.fileName}" is empty or nearly empty and can be pruned.`,
			});
			continue;
		}
		if (doc.inclusion === 'auto' && !doc.description) {
			findings.push({
				kind: 'invalid-frontmatter',
				severity: 'warning',
				filePath: doc.filePath,
				fileName: doc.fileName,
				message: `"${doc.fileName}" uses inclusion: auto without a description (will never match automatically).`,
			});
		}
		if (doc.inclusion === 'fileMatch' && !doc.fileMatchPattern) {
			findings.push({
				kind: 'invalid-frontmatter',
				severity: 'warning',
				filePath: doc.filePath,
				fileName: doc.fileName,
				message: `"${doc.fileName}" uses inclusion: fileMatch without a fileMatchPattern.`,
			});
		}
		const legacyMatch = LEGACY_MODEL_WORKAROUND_RE.exec(text);
		if (legacyMatch) {
			findings.push({
				kind: 'obsolete-workaround',
				severity: 'warning',
				filePath: doc.filePath,
				fileName: doc.fileName,
				message: `"${doc.fileName}" contains a potential legacy model workaround ("${legacyMatch[0]}"). Review or prune it.`,
			});
		}

		for (let j = i + 1; j < docs.length; j++) {
			const sim = jaccardSimilarity(tokenCache[i], tokenCache[j]);
			if (sim >= 0.7) {
				findings.push({
					kind: 'redundant',
					severity: 'info',
					filePath: docs[j].filePath,
					fileName: docs[j].fileName,
					relatedFilePath: doc.filePath,
					message: `"${docs[j].fileName}" overlaps heavily (${Math.round(sim * 100)}%) with "${doc.fileName}". Consider merging or pruning.`,
				});
			}
		}
	}

	return findings;
}
