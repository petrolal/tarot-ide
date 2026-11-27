/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure 5-field cron evaluator (`minute hour dayOfMonth month dayOfWeek`) with timezone
 * support (via `Intl.DateTimeFormat`), `excludeDates` (`YYYY-MM-DD`), and bounded jitter.
 * Zero `vscode` import so it is unit-testable via `node --test`.
 */

export interface CronDateParts {
	readonly year: number;
	readonly month: number; // 1..12
	readonly day: number; // 1..31
	readonly hour: number; // 0..23
	readonly minute: number; // 0..59
	readonly dayOfWeek: number; // 0..6 (0 = Sunday)
	readonly isoDate: string; // YYYY-MM-DD
}

const WEEKDAY_MAP: Readonly<Record<string, number>> = {
	Sun: 0,
	Mon: 1,
	Tue: 2,
	Wed: 3,
	Thu: 4,
	Fri: 5,
	Sat: 6,
};

/** Extracts calendar parts for `date` in the given IANA timezone (defaults to local/UTC fallback). */
export function getDatePartsInTimezone(date: Date, timezone?: string): CronDateParts {
	const fmt = new Intl.DateTimeFormat('en-US', {
		timeZone: timezone || undefined,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		weekday: 'short',
		hourCycle: 'h23',
	});
	const parts = fmt.formatToParts(date);
	const get = (type: string): string => parts.find(p => p.type === type)?.value ?? '0';
	const year = Number.parseInt(get('year'), 10);
	const month = Number.parseInt(get('month'), 10);
	const day = Number.parseInt(get('day'), 10);
	const rawHour = Number.parseInt(get('hour'), 10);
	const hour = rawHour === 24 ? 0 : rawHour;
	const minute = Number.parseInt(get('minute'), 10);
	const weekdayStr = get('weekday');
	const dayOfWeek = WEEKDAY_MAP[weekdayStr] ?? date.getDay();
	const isoDate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
	return { year, month, day, hour, minute, dayOfWeek, isoDate };
}

function matchCronField(field: string, value: number, min: number, max: number): boolean {
	const tokens = field.split(',').map(t => t.trim()).filter(Boolean);
	if (tokens.length === 0) {
		return false;
	}
	for (const token of tokens) {
		if (token === '*') {
			return true;
		}
		const [rangePart, stepPart] = token.split('/');
		const step = stepPart !== undefined ? Number.parseInt(stepPart, 10) : 1;
		if (!Number.isInteger(step) || step <= 0) {
			return false;
		}
		if (rangePart === '*') {
			if ((value - min) % step === 0) {
				return true;
			}
			continue;
		}
		if (rangePart.includes('-')) {
			const [startStr, endStr] = rangePart.split('-');
			const start = Number.parseInt(startStr, 10);
			const end = Number.parseInt(endStr, 10);
			if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
				return false;
			}
			if (value >= start && value <= end && (value - start) % step === 0) {
				return true;
			}
			continue;
		}
		const exact = Number.parseInt(rangePart, 10);
		if (!Number.isInteger(exact) || exact < min || exact > max) {
			return false;
		}
		if (value === exact) {
			return true;
		}
	}
	return false;
}

/** Validates basic 5-field cron syntax (`min hour dom mon dow`). */
export function isValidCronExpression(expr: string): boolean {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) {
		return false;
	}
	return fields.every(f => /^[0-9*,/-]+$/.test(f));
}

/**
 * Returns true if `cronExpr` matches `date` in `timezone`, respecting `excludeDates` (`YYYY-MM-DD`).
 */
export function matchesCronAt(
	cronExpr: string,
	date: Date,
	options?: { readonly timezone?: string; readonly excludeDates?: readonly string[] },
): boolean {
	if (!isValidCronExpression(cronExpr)) {
		return false;
	}
	const parts = getDatePartsInTimezone(date, options?.timezone);
	if (options?.excludeDates?.includes(parts.isoDate)) {
		return false;
	}
	const [minF, hourF, domF, monF, dowF] = cronExpr.trim().split(/\s+/);
	// Support both 0 and 7 as Sunday in day-of-week field
	const dowMatched = matchCronField(dowF, parts.dayOfWeek, 0, 7)
		|| (parts.dayOfWeek === 0 && matchCronField(dowF, 7, 0, 7));
	const domMatched = matchCronField(domF, parts.day, 1, 31);

	// TD-11: standard cron semantics — when BOTH day-of-month and day-of-week are restricted
	// (neither is `*`), the day matches if EITHER field matches, not only when both do at once
	// (e.g. "0 9 1 * MON" means "the 1st OR every Monday", not "the 1st when it's also a Monday").
	// When only one (or neither) is restricted, the unrestricted `*` field always matches on its
	// own, so plain AND already reduces to "whichever field is restricted must match".
	const domRestricted = domF !== '*';
	const dowRestricted = dowF !== '*';
	const dayMatched = (domRestricted && dowRestricted)
		? (domMatched || dowMatched)
		: (domMatched && dowMatched);

	return (
		matchCronField(minF, parts.minute, 0, 59)
		&& matchCronField(hourF, parts.hour, 0, 23)
		&& matchCronField(monF, parts.month, 1, 12)
		&& dayMatched
	);
}

/** Computes a bounded random jitter delay in milliseconds (`0 .. jitterSec * 1000`). */
export function computeJitterMs(jitterSec?: number, rng: () => number = Math.random): number {
	if (!jitterSec || !Number.isFinite(jitterSec) || jitterSec <= 0) {
		return 0;
	}
	return Math.floor(Math.min(jitterSec, 3600) * 1000 * Math.max(0, Math.min(0.999999, rng())));
}
