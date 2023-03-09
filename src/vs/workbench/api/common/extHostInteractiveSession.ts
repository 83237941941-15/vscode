/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as typeConvert from 'vs/workbench/api/common/extHostTypeConverters';
import { CancellationToken } from 'vs/base/common/cancellation';
import { toDisposable } from 'vs/base/common/lifecycle';
import { StopWatch } from 'vs/base/common/stopwatch';
import { withNullAsUndefined } from 'vs/base/common/types';
import { localize } from 'vs/nls';
import { IRelaxedExtensionDescription } from 'vs/platform/extensions/common/extensions';
import { ILogService } from 'vs/platform/log/common/log';
import { ExtHostInteractiveSessionShape, IInteractiveRequestDto, IInteractiveResponseDto, IInteractiveSessionDto, IMainContext, MainContext, MainThreadInteractiveSessionShape } from 'vs/workbench/api/common/extHost.protocol';
import { IInteractiveSlashCommand } from 'vs/workbench/contrib/interactiveSession/common/interactiveSessionService';
import type * as vscode from 'vscode';

class InteractiveSessionProviderWrapper {

	private static _pool = 0;

	readonly handle: number = InteractiveSessionProviderWrapper._pool++;

	constructor(
		readonly extension: Readonly<IRelaxedExtensionDescription>,
		readonly provider: vscode.InteractiveSessionProvider,
	) { }
}

export class ExtHostInteractiveSession implements ExtHostInteractiveSessionShape {
	private static _nextId = 0;

	private readonly _interactiveSessionProvider = new Map<number, InteractiveSessionProviderWrapper>();
	private readonly _interactiveSessions = new Map<number, vscode.InteractiveSession>();

	private readonly _proxy: MainThreadInteractiveSessionShape;

	constructor(
		mainContext: IMainContext,
		private readonly logService: ILogService
	) {
		this._proxy = mainContext.getProxy(MainContext.MainThreadInteractiveSession);
	}

	//#region interactive session

	registerInteractiveSessionProvider(extension: Readonly<IRelaxedExtensionDescription>, id: string, provider: vscode.InteractiveSessionProvider): vscode.Disposable {
		const wrapper = new InteractiveSessionProviderWrapper(extension, provider);
		this._interactiveSessionProvider.set(wrapper.handle, wrapper);
		this._proxy.$registerInteractiveSessionProvider(wrapper.handle, id, !!provider.provideResponseWithProgress);
		return toDisposable(() => {
			this._proxy.$unregisterInteractiveSessionProvider(wrapper.handle);
			this._interactiveSessionProvider.delete(wrapper.handle);
		});
	}

	addInteractiveSessionRequest(context: vscode.InteractiveSessionRequestArgs): void {
		this._proxy.$addInteractiveSessionRequest(context);
	}

	async $prepareInteractiveSession(handle: number, initialState: any, token: CancellationToken): Promise<IInteractiveSessionDto | undefined> {
		const entry = this._interactiveSessionProvider.get(handle);
		if (!entry) {
			return undefined;
		}

		const session = await entry.provider.prepareSession(initialState, token);
		if (!session) {
			return undefined;
		}

		const id = ExtHostInteractiveSession._nextId++;
		this._interactiveSessions.set(id, session);

		return {
			id,
			requesterUsername: session.requester?.name,
			requesterAvatarIconUri: session.requester?.icon,
			responderUsername: session.responder?.name,
			responderAvatarIconUri: session.responder?.icon
		};
	}

	async $resolveInteractiveRequest(handle: number, sessionId: number, context: any, token: CancellationToken): Promise<IInteractiveRequestDto | undefined> {
		const entry = this._interactiveSessionProvider.get(handle);
		if (!entry) {
			return undefined;
		}

		const realSession = this._interactiveSessions.get(sessionId);
		if (!realSession) {
			return undefined;
		}

		if (!entry.provider.resolveRequest) {
			return undefined;
		}
		const request = await entry.provider.resolveRequest(realSession, context, token);
		if (request) {
			return {
				message: request.message,
			};
		}

		return undefined;
	}

	async $provideInitialSuggestions(handle: number, token: CancellationToken): Promise<string[] | undefined> {
		const entry = this._interactiveSessionProvider.get(handle);
		if (!entry) {
			return undefined;
		}

		if (!entry.provider.provideInitialSuggestions) {
			return undefined;
		}

		return withNullAsUndefined(await entry.provider.provideInitialSuggestions(token));
	}

	async $provideInteractiveReply(handle: number, sessionId: number, request: IInteractiveRequestDto, token: CancellationToken): Promise<IInteractiveResponseDto | undefined> {
		const entry = this._interactiveSessionProvider.get(handle);
		if (!entry) {
			return undefined;
		}

		const realSession = this._interactiveSessions.get(sessionId);
		if (!realSession) {
			return;
		}

		const requestObj: vscode.InteractiveRequest = {
			session: realSession,
			message: request.message,
		};

		if (entry.provider.provideResponse) {
			const res = await entry.provider.provideResponse(requestObj, token);
			if (realSession.saveState) {
				const newState = realSession.saveState();
				this._proxy.$acceptInteractiveSessionState(sessionId, newState);
			}

			if (!res) {
				return;
			}

			// TODO clean up this API
			this._proxy.$acceptInteractiveResponseProgress(handle, sessionId, { responsePart: res.content });
			return { followups: res.followups, timings: { firstProgress: 0, totalElapsed: 0 } };
		} else if (entry.provider.provideResponseWithProgress) {
			const stopWatch = StopWatch.create(false);
			let firstProgress: number | undefined;
			const progressObj: vscode.Progress<vscode.InteractiveProgress> = {
				report: (progress: vscode.InteractiveProgress) => {
					if (typeof firstProgress === 'undefined') {
						firstProgress = stopWatch.elapsed();
					}

					this._proxy.$acceptInteractiveResponseProgress(handle, sessionId, { responsePart: progress.content });
				}
			};
			let result: vscode.InteractiveResponseForProgress | undefined | null;
			try {
				result = await entry.provider.provideResponseWithProgress(requestObj, progressObj, token);
				if (!result) {
					result = { errorDetails: { message: localize('emptyResponse', "Provider returned null response") } };
				}
			} catch (err) {
				result = { errorDetails: { message: localize('errorResponse', "Error from provider: {0}", err.message), responseIsIncomplete: true } };
				this.logService.error(err);
			}

			try {
				if (realSession.saveState) {
					const newState = realSession.saveState();
					this._proxy.$acceptInteractiveSessionState(sessionId, newState);
				}
			} catch (err) {
				this.logService.warn(err);
			}

			const timings = { firstProgress: firstProgress ?? 0, totalElapsed: stopWatch.elapsed() };
			return { followups: result.followups, commandFollowups: result.commands, errorDetails: result.errorDetails, timings };
		}

		throw new Error('Provider must implement either provideResponse or provideResponseWithProgress');
	}

	async $provideSlashCommands(handle: number, sessionId: number, token: CancellationToken): Promise<IInteractiveSlashCommand[] | undefined> {
		const entry = this._interactiveSessionProvider.get(handle);
		if (!entry) {
			return undefined;
		}

		const realSession = this._interactiveSessions.get(sessionId);
		if (!realSession) {
			return undefined;
		}

		if (!entry.provider.provideSlashCommands) {
			return undefined;
		}

		const slashCommands = await entry.provider.provideSlashCommands(realSession, token);
		return slashCommands?.map(c => (<IInteractiveSlashCommand>{
			...c,
			kind: typeConvert.CompletionItemKind.from(c.kind)
		}));
	}

	$releaseSession(sessionId: number) {
		this._interactiveSessions.delete(sessionId);
	}

	//#endregion
}