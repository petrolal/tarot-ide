/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchesCronAt } from '../schedule/cronParser';

describe('cronParser.matchesCronAt (TD-11: dom/dow OR semantics)', () => {
	// 2026-11-02 is a Monday; 2026-11-01 is a Sunday; 2026-11-03 is a Tuesday.
	it('matches every day when both dom and dow are "*"', () => {
		assert.equal(matchesCronAt('0 9 * * *', new Date('2026-11-03T09:00:00Z'), { timezone: 'UTC' }), true);
	});

	it('matches only the restricted field when the other is "*"', () => {
		assert.equal(matchesCronAt('0 9 1 * *', new Date('2026-11-01T09:00:00Z'), { timezone: 'UTC' }), true);
		assert.equal(matchesCronAt('0 9 1 * *', new Date('2026-11-02T09:00:00Z'), { timezone: 'UTC' }), false);
		// dow=1 is Monday (WEEKDAY_MAP), and this parser's fields are numeric only (no "MON").
		assert.equal(matchesCronAt('0 9 * * 1', new Date('2026-11-02T09:00:00Z'), { timezone: 'UTC' }), true);
		assert.equal(matchesCronAt('0 9 * * 1', new Date('2026-11-03T09:00:00Z'), { timezone: 'UTC' }), false);
	});

	it('when BOTH dom and dow are restricted, matches on EITHER (not only when both hold)', () => {
		// "0 9 1 * 1" = 9am on the 1st OR every Monday.
		assert.equal(matchesCronAt('0 9 1 * 1', new Date('2026-11-01T09:00:00Z'), { timezone: 'UTC' }), true, 'the 1st (a Sunday, not Monday) must still match');
		assert.equal(matchesCronAt('0 9 1 * 1', new Date('2026-11-02T09:00:00Z'), { timezone: 'UTC' }), true, 'a Monday that is not the 1st must still match');
		assert.equal(matchesCronAt('0 9 1 * 1', new Date('2026-11-03T09:00:00Z'), { timezone: 'UTC' }), false, 'neither the 1st nor a Monday must not match');
	});
});
