/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';

export interface TemplateContext {
	readonly input: string;
	readonly inputs?: Readonly<Record<string, string>>;
	readonly previousOutput?: string;
	readonly stepOutputs: Readonly<Record<string, string>>;
	readonly artifacts: Readonly<Record<string, string>>;
}

export interface TemplateResolutionResult {
	readonly resolved: string;
	readonly warnings: readonly string[];
}

const TEMPLATE_EXPR_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

/**
 * Wraps captured step output in tamper-resistant boundary delimiters (MIGRATION_PLAN.md M3.9a)
 * so untrusted model output cannot forge prompt instructions or escape its container.
 */
export function wrapCapturedOutput(label: string, content: string): string {
	const nonce = crypto.randomBytes(4).toString('hex');
	return `<<<TAROT_OUTPUT:${label}:${nonce}>>>\n${content}\n<<<END_TAROT_OUTPUT:${label}:${nonce}>>>`;
}

/**
 * Resolves `{{input}}`, `{{previous.output}}`, `{{step-id.output}}`, `{{artifacts.name}}` and
 * declared input variables. Undeclared bare variables are left literal with a warning.
 * Pure — unit-testable.
 */
export function resolveWorkflowTemplate(template: string, ctx: TemplateContext): TemplateResolutionResult {
	const warnings: string[] = [];

	const resolved = template.replace(TEMPLATE_EXPR_RE, (fullMatch, expr: string) => {
		if (expr === 'input') {
			return ctx.input;
		}
		if (expr === 'previous.output') {
			if (ctx.previousOutput === undefined) {
				warnings.push(`Template "{{previous.output}}" has no previous step output.`);
				return fullMatch;
			}
			return wrapCapturedOutput('previous', ctx.previousOutput);
		}
		if (expr.startsWith('artifacts.')) {
			const name = expr.slice('artifacts.'.length);
			if (name in ctx.artifacts) {
				return ctx.artifacts[name];
			}
			warnings.push(`Undeclared artifact reference "${fullMatch}" left literal.`);
			return fullMatch;
		}
		if (expr.endsWith('.output')) {
			const stepId = expr.slice(0, -'.output'.length);
			if (stepId in ctx.stepOutputs) {
				return wrapCapturedOutput(stepId, ctx.stepOutputs[stepId]);
			}
			warnings.push(`Unknown step output reference "${fullMatch}" left literal.`);
			return fullMatch;
		}
		if (ctx.inputs && expr in ctx.inputs) {
			return ctx.inputs[expr];
		}
		warnings.push(`Undeclared variable "${fullMatch}" left literal.`);
		return fullMatch;
	});

	return { resolved, warnings };
}
