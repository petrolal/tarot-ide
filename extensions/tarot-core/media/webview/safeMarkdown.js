/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

(function () {
	'use strict';

	function appendInline(parent, text) {
		// Supports `code`, **bold**, and *italic* via safe DOM text nodes only.
		const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*)/g;
		let lastIndex = 0;
		let match;
		while ((match = pattern.exec(text)) !== null) {
			if (match.index > lastIndex) {
				parent.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
			}
			const token = match[0];
			if (token.startsWith('`')) {
				const code = document.createElement('code');
				code.className = 'tmd-inline-code';
				code.textContent = token.slice(1, -1);
				parent.appendChild(code);
			} else if (token.startsWith('**')) {
				const strong = document.createElement('strong');
				strong.textContent = token.slice(2, -2);
				parent.appendChild(strong);
			} else if (token.startsWith('*')) {
				const em = document.createElement('em');
				em.textContent = token.slice(1, -1);
				parent.appendChild(em);
			}
			lastIndex = pattern.lastIndex;
		}
		if (lastIndex < text.length) {
			parent.appendChild(document.createTextNode(text.slice(lastIndex)));
		}
	}

	function parseTableRow(line) {
		return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
	}

	function isTableSeparator(line) {
		return /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(line);
	}

	function renderMarkdown(container, rawText) {
		const frag = document.createDocumentFragment();
		const text = String(rawText || '').replace(/\r\n/g, '\n');
		if (!text.trim()) {
			container.replaceChildren(frag);
			return;
		}

		const lines = text.split('\n');
		let i = 0;

		while (i < lines.length) {
			const line = lines[i];
			const trimmed = line.trim();

			if (!trimmed) {
				i++;
				continue;
			}

			// Special Tarot workflow [SEND_MESSAGE:level] banner
			const sendMsg = trimmed.match(/^\[SEND_MESSAGE:([a-zA-Z0-9_-]+)\]\s*(.*)$/);
			if (sendMsg) {
				const level = sendMsg[1].toLowerCase();
				const banner = document.createElement('div');
				banner.className = `tmd-banner tmd-banner-${level}`;
				const tag = document.createElement('span');
				tag.className = 'tmd-banner-tag';
				tag.textContent = level.toUpperCase();
				banner.appendChild(tag);
				const body = document.createElement('div');
				body.className = 'tmd-banner-body';
				appendInline(body, sendMsg[2]);
				banner.appendChild(body);
				frag.appendChild(banner);
				i++;
				continue;
			}

			// Fenced code block
			if (trimmed.startsWith('```')) {
				const lang = trimmed.slice(3).trim();
				const codeLines = [];
				i++;
				while (i < lines.length && !lines[i].trim().startsWith('```')) {
					codeLines.push(lines[i]);
					i++;
				}
				if (i < lines.length) {
					i++;
				}
				const pre = document.createElement('pre');
				pre.className = 'tmd-code-block';
				if (lang) {
					pre.dataset.lang = lang;
				}
				const code = document.createElement('code');
				code.textContent = codeLines.join('\n');
				pre.appendChild(code);
				frag.appendChild(pre);
				continue;
			}

			// Headings # .. ####
			const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
			if (heading) {
				const level = Math.min(4, heading[1].length);
				const h = document.createElement(`h${level + 1}`);
				h.className = `tmd-h tmd-h${level}`;
				appendInline(h, heading[2]);
				frag.appendChild(h);
				i++;
				continue;
			}

			// GFM Table
			if (trimmed.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
				const headers = parseTableRow(lines[i]);
				i += 2;
				const table = document.createElement('table');
				table.className = 'tmd-table';
				const thead = document.createElement('thead');
				const trH = document.createElement('tr');
				for (const cell of headers) {
					const th = document.createElement('th');
					appendInline(th, cell);
					trH.appendChild(th);
				}
				thead.appendChild(trH);
				table.appendChild(thead);

				const tbody = document.createElement('tbody');
				while (i < lines.length && lines[i].trim().includes('|') && !lines[i].trim().startsWith('#')) {
					const cells = parseTableRow(lines[i]);
					const tr = document.createElement('tr');
					for (const cell of cells) {
						const td = document.createElement('td');
						appendInline(td, cell);
						tr.appendChild(td);
					}
					tbody.appendChild(tr);
					i++;
				}
				table.appendChild(tbody);
				frag.appendChild(table);
				continue;
			}

			// Unordered list
			if (/^\s*[-*]\s+/.test(line)) {
				const ul = document.createElement('ul');
				ul.className = 'tmd-list';
				while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
					const li = document.createElement('li');
					appendInline(li, lines[i].replace(/^\s*[-*]\s+/, ''));
					ul.appendChild(li);
					i++;
				}
				frag.appendChild(ul);
				continue;
			}

			// Ordered list
			if (/^\s*\d+\.\s+/.test(line)) {
				const ol = document.createElement('ol');
				ol.className = 'tmd-list';
				while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
					const li = document.createElement('li');
					appendInline(li, lines[i].replace(/^\s*\d+\.\s+/, ''));
					ol.appendChild(li);
					i++;
				}
				frag.appendChild(ol);
				continue;
			}

			// Paragraph (collect consecutive plain lines)
			const pLines = [];
			while (
				i < lines.length
				&& lines[i].trim()
				&& !lines[i].trim().startsWith('#')
				&& !lines[i].trim().startsWith('```')
				&& !lines[i].trim().startsWith('[SEND_MESSAGE:')
				&& !/^\s*[-*]\s+/.test(lines[i])
				&& !/^\s*\d+\.\s+/.test(lines[i])
				&& !(lines[i].includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
			) {
				pLines.push(lines[i].trim());
				i++;
			}
			const p = document.createElement('p');
			p.className = 'tmd-p';
			appendInline(p, pLines.join(' '));
			frag.appendChild(p);
		}

		container.replaceChildren(frag);
	}

	window.TarotSafeMarkdown = { render: renderMarkdown };
})();
