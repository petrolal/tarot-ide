/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { formatMarkdownReviewBatch } from '../specs/markdownReview';
import { computeSpecStepperSteps, parsePbtCounterExample, TarotSpecService } from '../specs/specService';

describe('specService & M3.6.6 UX helpers', () => {
	it('computes stepper order for Requirements-First, Design-First and Bugfix', () => {
		const reqFirst = computeSpecStepperSteps('design.md', 'feature', false);
		assert.deepEqual(reqFirst.map(s => s.fileName), ['requirements.md', 'design.md', 'tasks.md']);
		assert.equal(reqFirst[1].active, true);

		const designFirst = computeSpecStepperSteps('design.md', 'feature', true);
		assert.deepEqual(designFirst.map(s => s.fileName), ['design.md', 'requirements.md', 'tasks.md']);
		assert.equal(designFirst[0].active, true);

		const bugfix = computeSpecStepperSteps('bugfix.md', 'bugfix', false);
		assert.deepEqual(bugfix.map(s => s.fileName), ['bugfix.md', 'design.md', 'tasks.md']);
		assert.equal(bugfix[0].active, true);
	});

	it('extracts PBT Counter-example and Error blocks', () => {
		const parsed = parsePbtCounterExample(
			'Property failed after 14 runs.\nCounter-example: { coupon: "SAVE100", total: -5 }\nError: Discount cannot exceed total',
		);
		assert.ok(parsed);
		assert.equal(parsed.counterExample, '{ coupon: "SAVE100", total: -5 }');
		assert.equal(parsed.error, 'Discount cannot exceed total');
		assert.equal(parsePbtCounterExample('All 48 tests passed.'), undefined);
	});

	it('formats Markdown review comments as a single batch prompt', () => {
		assert.equal(formatMarkdownReviewBatch('requirements.md', []), '');
		const batch = formatMarkdownReviewBatch('requirements.md', [
			{
				filePath: '/repo/.tarot/specs/auth/requirements.md',
				fileName: 'requirements.md',
				startLine: 10,
				endLine: 12,
				excerpt: 'WHEN token expires THE SYSTEM SHALL refresh',
				comment: 'Specify max retry count',
			},
		]);
		assert.match(batch, /requirements\.md:L10-L12/);
		assert.match(batch, /Specify max retry count/);
	});

	it('creates spec templates separating boundary/contract tests and builds Analyze/Quick Spec prompts', async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tarot-specservice-'));
		const service = new TarotSpecService();
		try {
			const { dirPath } = await service.createSpec(tmpDir, 'rate-limiter', 'quick-spec');
			const loaded = await service.loadSpecContext(dirPath);
			assert.equal(loaded.slug, 'rate-limiter');
			assert.equal(loaded.kind, 'feature');
			assert.match(loaded.contextText, /Boundary & Contract Tests/);
			assert.match(loaded.contextText, /Implementation Unit Tests/);

			const analyze = service.buildAnalyzeRequirementsPrompt(loaded);
			assert.match(analyze, /Analyze Requirements/);
			assert.match(analyze, /Inconsistências lógicas/);

			const quick = service.buildQuickSpecPrompt(loaded, 'Add Redis rate limiter');
			assert.match(quick, /Quick Spec/);
			assert.match(quick, /Add Redis rate limiter/);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	// TD-12: buildTaskExecutionPrompt/buildPhaseAdvancePrompt previously built their prompt body
	// in English, breaking the project's PT-BR rule for text sent to the BYOA agent CLI
	// (AGENTS.md §2e), unlike every sibling prompt-builder in this file.
	it('builds Task Execution and Phase Advance prompts in PT-BR (TD-12)', async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tarot-specservice-ptbr-'));
		const service = new TarotSpecService();
		try {
			const { dirPath } = await service.createSpec(tmpDir, 'rate-limiter', 'quick-spec');
			const loaded = await service.loadSpecContext(dirPath);
			const task = {
				lineIndex: 0, index: 1, title: 'Implementar o rate limiter', completed: false, rawLine: '', optional: false,
			} as import('../specs/taskParser').SpecTask;

			const taskPrompt = service.buildTaskExecutionPrompt(loaded, task);
			assert.match(taskPrompt, /Execute APENAS a Tarefa #1/);
			assert.doesNotMatch(taskPrompt, /Execute ONLY Task/i);

			const designPrompt = service.buildPhaseAdvancePrompt(loaded, 'design');
			assert.match(designPrompt, /Com base no/);
			assert.doesNotMatch(designPrompt, /Based on the approved/i);

			const tasksPrompt = service.buildPhaseAdvancePrompt(loaded, 'tasks');
			assert.doesNotMatch(tasksPrompt, /Based on the approved/i);

			const requirementsPrompt = service.buildPhaseAdvancePrompt(loaded, 'requirements');
			assert.doesNotMatch(requirementsPrompt, /^Refine .* using strict/im);

			const bugfixPrompt = service.buildPhaseAdvancePrompt(loaded, 'bugfix');
			assert.doesNotMatch(bugfixPrompt, /^Refine .* with the 3 EARS/im);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});
});
