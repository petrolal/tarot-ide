/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import './tarotSpecStepper.css';
import { $, addDisposableListener, clearNode } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename, dirname, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ICodeEditor, IOverlayWidget, IOverlayWidgetPosition } from '../../../../editor/browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../../editor/browser/editorExtensions.js';
import { IEditorContribution } from '../../../../editor/common/editorCommon.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';

const SPEC_FILES = new Set(['requirements.md', 'bugfix.md', 'design.md', 'tasks.md']);
const STEPPER_HEIGHT_PX = 44;

interface ISpecStepDef {
	readonly index: number;
	readonly fileName: string;
	readonly label: string;
	readonly active: boolean;
}

class TarotSpecStepperContribution extends Disposable implements IEditorContribution {
	static readonly ID = 'tarot.contrib.specStepper';

	private readonly overlayDomNode: HTMLElement;
	private readonly overlayWidget: IOverlayWidget;
	private readonly renderDisposables = this._register(new DisposableStore());
	private viewZoneId: string | undefined;
	private overlayAttached = false;
	private renderToken = 0;

	constructor(
		private readonly editor: ICodeEditor,
		@ICommandService private readonly commandService: ICommandService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustManagementService: IWorkspaceTrustManagementService,
	) {
		super();

		this.overlayDomNode = $('.tarot-spec-stepper', {
			role: 'navigation',
			'aria-label': localize('tarotSpecStepper.ariaLabel', "Spec workflow phases"),
		});
		this.overlayWidget = {
			getId: () => 'tarot.specStepper.overlay',
			getDomNode: () => this.overlayDomNode,
			getPosition: (): IOverlayWidgetPosition | null => null,
		};

		this._register(this.editor.onDidChangeModel(() => { void this.update(); }));
		this._register(this.workspaceTrustManagementService.onDidChangeTrust(() => { void this.update(); }));
		void this.update();
	}

	private async update(): Promise<void> {
		const token = ++this.renderToken;
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

		const normalizedPath = uri.path.replace(/\\/g, '/');
		const fileName = basename(uri);
		if (!normalizedPath.includes('/.tarot/specs/') || !SPEC_FILES.has(fileName)) {
			this.teardown();
			return;
		}

		const specDirUri = dirname(uri);
		const slug = basename(specDirUri);
		let isBugfix = fileName === 'bugfix.md';
		if (!isBugfix) {
			try {
				isBugfix = await this.fileService.exists(joinPath(specDirUri, 'bugfix.md'));
			} catch {
				isBugfix = false;
			}
		}

		if (token !== this.renderToken || this._store.isDisposed) {
			return;
		}

		const steps: ISpecStepDef[] = isBugfix
			? [
				{ index: 1, fileName: 'bugfix.md', label: localize('tarotSpecStepper.bugfix', "Bugfix"), active: fileName === 'bugfix.md' },
				{ index: 2, fileName: 'design.md', label: localize('tarotSpecStepper.design', "Design"), active: fileName === 'design.md' },
				{ index: 3, fileName: 'tasks.md', label: localize('tarotSpecStepper.tasks', "Task list"), active: fileName === 'tasks.md' },
			]
			: [
				{ index: 1, fileName: 'requirements.md', label: localize('tarotSpecStepper.requirements', "Requirements"), active: fileName === 'requirements.md' },
				{ index: 2, fileName: 'design.md', label: localize('tarotSpecStepper.design', "Design"), active: fileName === 'design.md' },
				{ index: 3, fileName: 'tasks.md', label: localize('tarotSpecStepper.tasks', "Task list"), active: fileName === 'tasks.md' },
			];

		this.renderWidget(slug, specDirUri, fileName, steps);
		this.attachZoneAndOverlay();
	}

	private renderWidget(slug: string, specDirUri: URI, fileName: string, steps: readonly ISpecStepDef[]): void {
		this.renderDisposables.clear();
		clearNode(this.overlayDomNode);

		const slugEl = $('.tarot-spec-stepper-slug', undefined,
			$('span.codicon.codicon-checklist', { 'aria-hidden': 'true' }),
			$('span', undefined, slug),
		);
		this.overlayDomNode.appendChild(slugEl);

		const stepsWrap = $('.tarot-spec-stepper-steps');
		steps.forEach((step, idx) => {
			if (idx > 0) {
				stepsWrap.appendChild($('span.tarot-spec-step-sep', { 'aria-hidden': 'true' }, '›'));
			}
			const btn = $<HTMLButtonElement>('button.tarot-spec-step-pill', {
				type: 'button',
				...(step.active ? { 'aria-current': 'step' } : {}),
			});
			if (step.active) {
				btn.classList.add('active');
			}
			btn.appendChild($('span.tarot-spec-step-num', undefined, String(step.index)));
			btn.appendChild($('span.tarot-spec-step-label', undefined, step.label));

			const targetUri = joinPath(specDirUri, step.fileName);
			this.renderDisposables.add(addDisposableListener(btn, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				void this.commandService.executeCommand('tarot.specs.openPhase', targetUri.fsPath);
			}));
			stepsWrap.appendChild(btn);
		});
		this.overlayDomNode.appendChild(stepsWrap);

		const actionsWrap = $('.tarot-spec-stepper-actions');
		if (fileName === 'requirements.md' || fileName === 'bugfix.md') {
			const analyzeBtn = $<HTMLButtonElement>('button.tarot-spec-action-btn', { type: 'button' },
				$('span.codicon.codicon-search', { 'aria-hidden': 'true' }),
				$('span', undefined, localize('tarotSpecStepper.analyze', "Analyze")),
			);
			this.renderDisposables.add(addDisposableListener(analyzeBtn, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				void this.commandService.executeCommand('tarot.specs.analyzeRequirements', specDirUri.fsPath);
			}));
			actionsWrap.appendChild(analyzeBtn);
		}
		if (fileName === 'requirements.md' || fileName === 'bugfix.md' || fileName === 'design.md') {
			const reviewBtn = $<HTMLButtonElement>('button.tarot-spec-action-btn', { type: 'button' },
				$('span.codicon.codicon-comment-discussion', { 'aria-hidden': 'true' }),
				$('span', undefined, localize('tarotSpecStepper.review', "Review")),
			);
			this.renderDisposables.add(addDisposableListener(reviewBtn, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				void this.commandService.executeCommand('tarot.specs.markdownReview.add');
			}));
			actionsWrap.appendChild(reviewBtn);
		}
		if (actionsWrap.childElementCount > 0) {
			this.overlayDomNode.appendChild(actionsWrap);
		}
	}

	private attachZoneAndOverlay(): void {
		if (!this.overlayAttached) {
			this.editor.addOverlayWidget(this.overlayWidget);
			this.overlayAttached = true;
		}
		if (!this.viewZoneId) {
			this.editor.changeViewZones(accessor => {
				this.viewZoneId = accessor.addZone({
					afterLineNumber: 0,
					heightInPx: STEPPER_HEIGHT_PX,
					domNode: $('div'),
					onDomNodeTop: top => {
						this.overlayDomNode.style.top = `${top}px`;
					},
				});
			});
		}
	}

	private teardown(): void {
		++this.renderToken;
		this.renderDisposables.clear();
		if (this.viewZoneId) {
			const id = this.viewZoneId;
			this.viewZoneId = undefined;
			this.editor.changeViewZones(accessor => accessor.removeZone(id));
		}
		if (this.overlayAttached) {
			this.editor.removeOverlayWidget(this.overlayWidget);
			this.overlayAttached = false;
		}
	}

	override dispose(): void {
		this.teardown();
		super.dispose();
	}
}

registerEditorContribution(
	TarotSpecStepperContribution.ID,
	TarotSpecStepperContribution,
	EditorContributionInstantiation.AfterFirstRender,
);
