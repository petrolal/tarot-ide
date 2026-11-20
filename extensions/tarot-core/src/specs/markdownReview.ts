/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

export interface MarkdownReviewComment {
	readonly filePath: string;
	readonly fileName: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly excerpt: string;
	readonly comment: string;
}

/**
 * Formats queued inline Markdown review comments into a single structured prompt
 * to send in batch to the active local agent. Pure helper (zero `vscode` dependency).
 */
export function formatMarkdownReviewBatch(
	fileName: string,
	comments: readonly MarkdownReviewComment[],
): string {
	if (comments.length === 0) {
		return '';
	}

	const blocks = comments.map((item, idx) => {
		const range = item.startLine === item.endLine
			? `L${item.startLine}`
			: `L${item.startLine}-L${item.endLine}`;
		return (
			`### Comentário ${idx + 1} (${item.fileName}:${range})\n` +
			`Trecho selecionado:\n` +
			`> ${item.excerpt.replace(/\r?\n/g, '\n> ')}\n\n` +
			`Ajuste solicitado: ${item.comment}`
		);
	});

	return (
		`[Tarot Markdown Review — ${fileName}]\n` +
		`Aplique todos os ${comments.length} comentários de revisão abaixo no documento \`${fileName}\`, mantendo consistência com a notação EARS e com os demais arquivos da Spec:\n\n` +
		blocks.join('\n\n')
	);
}
