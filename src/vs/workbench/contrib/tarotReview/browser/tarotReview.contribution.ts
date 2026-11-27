/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import './tarotReview.css';
import { $, addDisposableListener, clearNode } from '../../../../base/browser/dom.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { ICodeEditor, IOverlayWidget, IOverlayWidgetPosition, OverlayWidgetPositionPreference } from '../../../../editor/browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../../editor/browser/editorExtensions.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { Range } from '../../../../editor/common/core/range.js';
import { IEditorContribution, IEditorDecorationsCollection } from '../../../../editor/common/editorCommon.js';
import { IModelDeltaDecoration, OverviewRulerLane } from '../../../../editor/common/model.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';

export interface ITarotInlineHunk {
	readonly id: number;
	/** 1-based start line in the working file (1 when inserted at top). */
	readonly startLine: number;
	/** Number of added/modified lines in the working file (0 for pure deletions). */
	readonly lineCount: number;
	/** Removed lines from the pre-turn snapshot, rendered inline above this hunk. */
	readonly removedLines: readonly string[];
}

export interface ITarotInlineFileReview {
	readonly fsPath: string;
	readonly relativePath: string;
	readonly fileIndex: number;
	readonly totalFiles: number;
	readonly hunks: readonly ITarotInlineHunk[];
}

export interface ITarotInlineReviewPayload {
	readonly files: readonly ITarotInlineFileReview[];
}

const HUNK_BAR_HEIGHT_PX = 30;

function normalizePath(p: string): string {
	return p.replace(/\\/g, '/');
}

class TarotInlineReviewStore {
	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange = this._onDidChange.event;
	private readonly filesByPath = new Map<string, ITarotInlineFileReview>();

	setPayload(payload: ITarotInlineReviewPayload | undefined): void {
		this.filesByPath.clear();
		if (payload && Array.isArray(payload.files)) {
			for (const file of payload.files) {
				if (file && typeof file.fsPath === 'string') {
					this.filesByPath.set(normalizePath(file.fsPath), file);
				}
			}
		}
		this._onDidChange.fire();
	}

	getForPath(fsPath: string): ITarotInlineFileReview | undefined {
		return this.filesByPath.get(normalizePath(fsPath));
	}
}

const reviewStore = new TarotInlineReviewStore();

CommandsRegistry.registerCommand('_tarot.inlineReview.setState', (_accessor, payload?: ITarotInlineReviewPayload) => {
	reviewStore.setPayload(payload);
});

/**
 * Native Cursor-style inline diff review overlay themed with Tarot Arcana palette:
 * - Renders removed lines inline in Tarot Crimson via Monaco ViewZones
 * - Highlights added/modified lines in Tarot Teal-Jade via decorations
 * - Reserves a dedicated non-overlapping ViewZone strip below each hunk paired with
 *   a right-aligned OverlayWidget containing high-contrast Accept / Reject pills
 * - Displays a floating bottom-right review bar (OverlayWidget) for hunk/file navigation & Accept/Reject File
 */
class TarotInlineReviewContribution extends Disposable implements IEditorContribution {
	static readonly ID = 'tarot.contrib.inlineReview';

	private readonly decorations: IEditorDecorationsCollection;
	private readonly renderDisposables = this._register(new DisposableStore());
	private readonly bottomBarDomNode: HTMLElement;
	private readonly bottomBarWidget: IOverlayWidget;
	private bottomBarAttached = false;
	private viewZoneIds: string[] = [];
	private hunkOverlayWidgets: IOverlayWidget[] = [];
	private currentHunkIndex = 0;

	constructor(
		private readonly editor: ICodeEditor,
		@ICommandService private readonly commandService: ICommandService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustManagementService: IWorkspaceTrustManagementService,
	) {
		super();

		this.decorations = this.editor.createDecorationsCollection();
		this.bottomBarDomNode = $('.tarot-review-floating-bar', {
			role: 'toolbar',
			'aria-label': localize('tarotInlineReview.toolbarAria', "Tarot agent change review"),
		});
		this.bottomBarWidget = {
			getId: () => 'tarot.inlineReview.bottomBar',
			getDomNode: () => this.bottomBarDomNode,
			getPosition: (): IOverlayWidgetPosition => ({
				preference: OverlayWidgetPositionPreference.BOTTOM_RIGHT_CORNER,
			}),
		};

		this._register(this.editor.onDidChangeModel(() => {
			this.currentHunkIndex = 0;
			this.update();
		}));
		this._register(this.editor.onDidChangeConfiguration(e => {
			if (e.hasChanged(EditorOption.fontInfo) || e.hasChanged(EditorOption.lineHeight)) {
				this.update();
			}
		}));
		this._register(reviewStore.onDidChange(() => this.update()));
		this._register(this.workspaceTrustManagementService.onDidChangeTrust(() => this.update()));
		this.update();
	}

	private update(): void {
		if (this._store.isDisposed || !this.workspaceTrustManagementService.isWorkspaceTrusted()) {
			this.teardown();
			return;
		}
		const model = this.editor.getModel();
		const uri = model?.uri;
		if (!uri || uri.scheme !== Schemas.file) {
			this.teardown();
			return;
		}

		const review = reviewStore.getForPath(uri.fsPath);
		if (!review || review.hunks.length === 0) {
			this.teardown();
			return;
		}

		if (this.currentHunkIndex >= review.hunks.length) {
			this.currentHunkIndex = Math.max(0, review.hunks.length - 1);
		}

		this.clearDynamicElements();

		const maxLine = Math.max(1, model.getLineCount());
		const fontInfo = this.editor.getOption(EditorOption.fontInfo);
		const lineHeight = this.editor.getOption(EditorOption.lineHeight);
		const newDecorations: IModelDeltaDecoration[] = [];

		// 1. Added/modified Tarot Teal decorations + inline Tarot Crimson ViewZones + non-overlapping per-hunk bar
		this.editor.changeViewZones(accessor => {
			for (const hunk of review.hunks) {
				if (hunk.lineCount > 0) {
					const startLine = Math.max(1, Math.min(hunk.startLine, maxLine));
					const endLine = Math.max(startLine, Math.min(hunk.startLine + hunk.lineCount - 1, maxLine));
					newDecorations.push({
						range: new Range(startLine, 1, endLine, 1),
						options: {
							description: 'tarot-inline-review-added',
							isWholeLine: true,
							className: 'tarot-review-added-line',
							linesDecorationsClassName: 'tarot-review-added-gutter',
							overviewRuler: {
								color: 'rgba(79, 209, 197, 0.9)',
								position: OverviewRulerLane.Left,
							},
						},
					});
				}

				if (hunk.removedLines.length > 0) {
					const afterLineNumber = Math.max(0, Math.min(hunk.startLine - 1, maxLine));
					const zoneDom = $('.tarot-review-removed-zone');
					zoneDom.style.fontFamily = fontInfo.fontFamily;
					zoneDom.style.fontSize = `${fontInfo.fontSize}px`;
					zoneDom.style.lineHeight = `${lineHeight}px`;

					for (const text of hunk.removedLines) {
						const lineEl = $('.tarot-review-removed-line', undefined, text.length > 0 ? text : ' ');
						lineEl.style.height = `${lineHeight}px`;
						zoneDom.appendChild(lineEl);
					}

					const zoneId = accessor.addZone({
						afterLineNumber,
						heightInLines: hunk.removedLines.length,
						domNode: zoneDom,
						suppressMouseDown: true,
					});
					this.viewZoneIds.push(zoneId);
				}

				// Dedicated non-overlapping action strip right below this hunk (ViewZone + synced OverlayWidget)
				const anchorAfterLine = hunk.lineCount > 0
					? Math.max(1, Math.min(hunk.startLine + hunk.lineCount - 1, maxLine))
					: Math.max(0, Math.min(hunk.startLine - 1, maxLine));

				const pillDom = $('.tarot-review-hunk-strip', {
					role: 'group',
					'aria-label': localize('tarotInlineReview.hunkActionsAria', "Change actions"),
				});

				const actionsInner = $('.tarot-review-hunk-actions');

				const acceptBtn = $<HTMLButtonElement>('button.tarot-review-pill.tarot-review-pill-accept', {
					type: 'button',
					title: localize('tarotInlineReview.acceptHunkTitle', "Accept this change"),
				},
					$('span.tarot-review-pill-icon', { 'aria-hidden': 'true' }, '✓'),
					$('span', undefined, localize('tarotInlineReview.acceptHunk', "Accept")),
				);

				const rejectBtn = $<HTMLButtonElement>('button.tarot-review-pill.tarot-review-pill-reject', {
					type: 'button',
					title: localize('tarotInlineReview.rejectHunkTitle', "Reject and revert this change"),
				},
					$('span.tarot-review-pill-icon', { 'aria-hidden': 'true' }, '✕'),
					$('span', undefined, localize('tarotInlineReview.rejectHunk', "Reject")),
				);

				this.renderDisposables.add(addDisposableListener(acceptBtn, 'mousedown', e => {
					e.preventDefault();
					e.stopPropagation();
				}));
				this.renderDisposables.add(addDisposableListener(rejectBtn, 'mousedown', e => {
					e.preventDefault();
					e.stopPropagation();
				}));
				this.renderDisposables.add(addDisposableListener(acceptBtn, 'click', e => {
					e.preventDefault();
					e.stopPropagation();
					void this.commandService.executeCommand('tarot.review.acceptHunk', review.relativePath, hunk.id);
				}));
				this.renderDisposables.add(addDisposableListener(rejectBtn, 'click', e => {
					e.preventDefault();
					e.stopPropagation();
					void this.commandService.executeCommand('tarot.review.rejectHunk', review.relativePath, hunk.id);
				}));

				actionsInner.appendChild(acceptBtn);
				actionsInner.appendChild(rejectBtn);
				pillDom.appendChild(actionsInner);

				const widgetId = `tarot.inlineReview.hunk.${hunk.id}`;
				const overlayWidget: IOverlayWidget = {
					getId: () => widgetId,
					getDomNode: () => pillDom,
					getPosition: (): IOverlayWidgetPosition | null => null,
				};
				this.editor.addOverlayWidget(overlayWidget);
				this.hunkOverlayWidgets.push(overlayWidget);

				const spacerZoneId = accessor.addZone({
					afterLineNumber: anchorAfterLine,
					heightInPx: HUNK_BAR_HEIGHT_PX,
					domNode: $('.tarot-review-hunk-spacer'),
					onDomNodeTop: top => {
						pillDom.style.top = `${top}px`;
					},
					onComputedHeight: height => {
						pillDom.style.height = `${height}px`;
					},
				});
				this.viewZoneIds.push(spacerZoneId);
			}
		});

		this.decorations.set(newDecorations);

		// 2. Floating bottom-right action bar (Cursor-style: ↑ 1 of N ↓ | File X/Y | Reject File | Accept File)
		this.renderBottomBar(review);
		if (!this.bottomBarAttached) {
			this.editor.addOverlayWidget(this.bottomBarWidget);
			this.bottomBarAttached = true;
		} else {
			this.editor.layoutOverlayWidget(this.bottomBarWidget);
		}
	}

	private renderBottomBar(review: ITarotInlineFileReview): void {
		clearNode(this.bottomBarDomNode);

		const hunkCount = review.hunks.length;
		const navGroup = $('.tarot-review-bar-nav');

		const prevBtn = $<HTMLButtonElement>('button.tarot-review-bar-icon-btn', {
			type: 'button',
			title: localize('tarotInlineReview.prevChange', "Previous change"),
			'aria-label': localize('tarotInlineReview.prevChange', "Previous change"),
		}, $('span.codicon.codicon-chevron-up', { 'aria-hidden': 'true' }));

		const counter = $('span.tarot-review-bar-counter', undefined,
			localize('tarotInlineReview.counter', "{0} of {1}", this.currentHunkIndex + 1, hunkCount),
		);

		const nextBtn = $<HTMLButtonElement>('button.tarot-review-bar-icon-btn', {
			type: 'button',
			title: localize('tarotInlineReview.nextChange', "Next change"),
			'aria-label': localize('tarotInlineReview.nextChange', "Next change"),
		}, $('span.codicon.codicon-chevron-down', { 'aria-hidden': 'true' }));

		this.renderDisposables.add(addDisposableListener(prevBtn, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.jumpToHunk(review, (this.currentHunkIndex - 1 + hunkCount) % hunkCount);
		}));
		this.renderDisposables.add(addDisposableListener(nextBtn, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.jumpToHunk(review, (this.currentHunkIndex + 1) % hunkCount);
		}));

		navGroup.appendChild(prevBtn);
		navGroup.appendChild(counter);
		navGroup.appendChild(nextBtn);
		this.bottomBarDomNode.appendChild(navGroup);

		if (review.totalFiles > 1) {
			const fileBtn = $<HTMLButtonElement>('button.tarot-review-bar-file-btn', {
				type: 'button',
				title: localize('tarotInlineReview.nextFileTitle', "Next changed file ({0}/{1})", review.fileIndex + 1, review.totalFiles),
			}, localize('tarotInlineReview.fileCounter', "File {0}/{1} →", review.fileIndex + 1, review.totalFiles));
			this.renderDisposables.add(addDisposableListener(fileBtn, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				void this.commandService.executeCommand('tarot.review.nextFile');
			}));
			this.bottomBarDomNode.appendChild(fileBtn);
		}

		this.bottomBarDomNode.appendChild($('.tarot-review-bar-sep', { 'aria-hidden': 'true' }));

		const rejectFileBtn = $<HTMLButtonElement>('button.tarot-review-bar-btn.tarot-review-bar-reject', {
			type: 'button',
			title: localize('tarotInlineReview.rejectFileTitle', "Reject and revert all changes in this file (Alt+N)"),
		},
			$('span', undefined, localize('tarotInlineReview.rejectFile', "Reject File")),
			$('span.tarot-review-bar-kbd', undefined, 'Alt+N'),
		);

		const acceptFileBtn = $<HTMLButtonElement>('button.tarot-review-bar-btn.tarot-review-bar-accept', {
			type: 'button',
			title: localize('tarotInlineReview.acceptFileTitle', "Accept all changes in this file (Alt+Y)"),
		},
			$('span', undefined, localize('tarotInlineReview.acceptFile', "Accept File")),
			$('span.tarot-review-bar-kbd', undefined, 'Alt+Y'),
		);

		this.renderDisposables.add(addDisposableListener(rejectFileBtn, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			void this.commandService.executeCommand('tarot.review.rejectFile', review.relativePath);
		}));
		this.renderDisposables.add(addDisposableListener(acceptFileBtn, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			void this.commandService.executeCommand('tarot.review.acceptFile', review.relativePath);
		}));

		this.bottomBarDomNode.appendChild(rejectFileBtn);
		this.bottomBarDomNode.appendChild(acceptFileBtn);
	}

	private jumpToHunk(review: ITarotInlineFileReview, nextIndex: number): void {
		this.currentHunkIndex = nextIndex;
		const hunk = review.hunks[nextIndex];
		if (hunk) {
			const line = Math.max(1, hunk.startLine);
			this.editor.revealLineInCenter(line);
			this.editor.setPosition({ lineNumber: line, column: 1 });
		}
		this.renderBottomBar(review);
	}

	private clearDynamicElements(): void {
		this.renderDisposables.clear();
		this.decorations.clear();
		if (this.viewZoneIds.length > 0) {
			const ids = this.viewZoneIds;
			this.viewZoneIds = [];
			this.editor.changeViewZones(accessor => {
				for (const id of ids) {
					accessor.removeZone(id);
				}
			});
		}
		if (this.hunkOverlayWidgets.length > 0) {
			const widgets = this.hunkOverlayWidgets;
			this.hunkOverlayWidgets = [];
			for (const w of widgets) {
				this.editor.removeOverlayWidget(w);
			}
		}
	}

	private teardown(): void {
		this.clearDynamicElements();
		if (this.bottomBarAttached) {
			this.editor.removeOverlayWidget(this.bottomBarWidget);
			this.bottomBarAttached = false;
		}
	}

	override dispose(): void {
		this.teardown();
		super.dispose();
	}
}

registerEditorContribution(
	TarotInlineReviewContribution.ID,
	TarotInlineReviewContribution,
	EditorContributionInstantiation.AfterFirstRender,
);
