/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola. All rights reserved.
 *  Licensed under the GNU General Public License v3.0. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { composeWorkflowStepPrompt, extractArtifactsFromOutput } from '../workflows/workflowAgentProfiles';

describe('workflows.workflowAgentProfiles', () => {
	it('prepends bundled role prompt, send_message protocol, and artifact instructions', () => {
		const prompt = composeWorkflowStepPrompt('wf-coder', 'Implement feature X', ['patch_summary']);
		assert.match(prompt, /wf-coder/);
		assert.match(prompt, /Implement feature X/);
		assert.match(prompt, /\[SEND_MESSAGE:warning\]/);
		assert.match(prompt, /patch_summary/);
		assert.match(prompt, /\[ARTIFACT:<nome>\]/);
	});

	it('extracts declared [ARTIFACT:name]...[/ARTIFACT] blocks and ignores undeclared ones when filtered', () => {
		const output = [
			'Done!',
			'[ARTIFACT:plan]',
			'1. Step A',
			'2. Step B',
			'[/ARTIFACT]',
			'[ARTIFACT:ignored]',
			'noise',
			'[/ARTIFACT]',
		].join('\n');

		const filtered = extractArtifactsFromOutput(output, ['plan']);
		assert.deepEqual(filtered, { plan: '1. Step A\n2. Step B' });

		const unfiltered = extractArtifactsFromOutput(output);
		assert.deepEqual(unfiltered, { plan: '1. Step A\n2. Step B', ignored: 'noise' });
	});
});
