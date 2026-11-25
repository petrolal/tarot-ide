/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import { AgentId, AgentMode, AutonomyMode, ContextProviderKind, ReasoningEffort } from '../agents/types';
import { ChangedFileInfo } from '../git/gitReviewService';

export type WebviewIncomingMessage =
	| { readonly type: 'ready' }
	| { readonly type: 'send'; readonly prompt?: string }
	| { readonly type: 'cancel' }
	| { readonly type: 'selectAgent'; readonly agentId?: AgentId }
	| { readonly type: 'setModel'; readonly model?: string }
	| { readonly type: 'setEffort'; readonly effort?: ReasoningEffort }
	| { readonly type: 'setMode'; readonly mode?: AgentMode }
	| { readonly type: 'setAutonomy'; readonly autonomy?: AutonomyMode }
	| { readonly type: 'attachActiveFile' }
	| { readonly type: 'pickContextProvider'; readonly kind?: ContextProviderKind }
	| { readonly type: 'removeAttachment'; readonly index?: number }
	| { readonly type: 'newSession' }
	| { readonly type: 'selectSession'; readonly sessionId?: string }
	| { readonly type: 'closeSession'; readonly sessionId?: string }
	| { readonly type: 'restoreCheckpoint'; readonly checkpointId?: string }
	| { readonly type: 'forkSession'; readonly messageId?: string }
	| { readonly type: 'openHistory' }
	| { readonly type: 'exportSession' }
	| { readonly type: 'compactSession' }
	| { readonly type: 'approveSpecGate'; readonly messageId?: string }
	| { readonly type: 'resolveFileWriteGate'; readonly messageId?: string; readonly keep?: boolean }
	| { readonly type: 'openInEditorTab' }
	| { readonly type: 'toggleFocusMode' }
	| { readonly type: 'openFileDiff'; readonly relativePath?: string; readonly fileStatus?: ChangedFileInfo['status'] }
	| { readonly type: 'revertFile'; readonly relativePath?: string; readonly fileStatus?: ChangedFileInfo['status'] }
	| { readonly type: 'refreshChangedFiles' }
	| { readonly type: 'runSlashCommand'; readonly slashCommand?: string }
	| { readonly type: 'saveSteeringRule'; readonly ruleText?: string }
	| { readonly type: 'openLink'; readonly url?: string }
	| { readonly type: 'selectProfile'; readonly profileId?: string }
	| { readonly type: 'refreshAgents' };

export function isWebviewIncomingMessage(value: unknown): value is WebviewIncomingMessage {
	return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}
