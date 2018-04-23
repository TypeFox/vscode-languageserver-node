/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import {
	Workspace, FileSystemWatcher, TextDocumentWillSaveEvent,
	Languages, DiagnosticCollection, Commands, Window, OutputChannel,
	TextDocumentDidChangeEvent
} from './services';

import {
	Message, MessageType as RPCMessageType, ErrorCodes, ResponseError,
	RequestType, RequestType0, RequestHandler, RequestHandler0, GenericRequestHandler,
	NotificationType, NotificationType0,
	NotificationHandler, NotificationHandler0, GenericNotificationHandler,
	Trace, Tracer, Event, Emitter,
	CancellationToken, Disposable
} from 'vscode-jsonrpc';

import {
	WorkspaceEdit, TextDocument, TextDocumentContentChangeEvent
} from 'vscode-languageserver-types';

import {
	ClientCapabilities,
	RegistrationRequest, RegistrationParams, UnregistrationRequest, UnregistrationParams, TextDocumentRegistrationOptions,
	InitializeParams, InitializeResult, InitializeError, ServerCapabilities, TextDocumentSyncKind, TextDocumentSyncOptions,
	InitializedNotification,
	MessageType,
	ShowMessageRequest,
	DocumentSelector,
	DidOpenTextDocumentNotification, DidOpenTextDocumentParams,
	DidChangeTextDocumentNotification, TextDocumentChangeRegistrationOptions,
	DidCloseTextDocumentNotification, DidCloseTextDocumentParams,
	DidSaveTextDocumentNotification, DidSaveTextDocumentParams, TextDocumentSaveRegistrationOptions,
	WillSaveTextDocumentNotification, WillSaveTextDocumentWaitUntilRequest, WillSaveTextDocumentParams,
	FileEvent,
	PublishDiagnosticsParams,
	CompletionRequest, CompletionResolveRequest, CompletionRegistrationOptions,
	HoverRequest,
	SignatureHelpRequest, SignatureHelpRegistrationOptions, DefinitionRequest, ReferencesRequest, DocumentHighlightRequest,
	DocumentSymbolRequest, WorkspaceSymbolRequest,
	CodeActionRequest,
	CodeLensRequest, CodeLensResolveRequest, CodeLensRegistrationOptions,
	DocumentFormattingRequest, DocumentRangeFormattingRequest,
	DocumentOnTypeFormattingRequest, DocumentOnTypeFormattingRegistrationOptions,
	RenameRequest,
	DocumentLinkRequest, DocumentLinkResolveRequest, DocumentLinkRegistrationOptions,
	ExecuteCommandRequest, ExecuteCommandParams, ExecuteCommandRegistrationOptions,
	ApplyWorkspaceEditRequest, ApplyWorkspaceEditParams, ApplyWorkspaceEditResponse
} from './protocol';

import { IConnection, IConnectionProvider } from './connection';

import * as is from './utils/is';
import { Delayer } from './utils/async'
import * as UUID from './utils/uuid';

export {
	ResponseError, InitializeError, ErrorCodes,
	RequestType, RequestType0, RequestHandler, RequestHandler0, GenericRequestHandler,
	NotificationType, NotificationType0, NotificationHandler, NotificationHandler0, GenericNotificationHandler,
	IConnection
}

export * from 'vscode-languageserver-types';
export * from './protocol';
/**
 * An action to be performed when the connection is producing errors.
 */
export enum ErrorAction {
	/**
	 * Continue running the server.
	 */
	Continue = 1,
	/**
	 * Shutdown the server.
	 */
	Shutdown = 2
}

/**
 * An action to be performed when the connection to a server got closed.
 */
export enum CloseAction {
	/**
	 * Don't restart the server. The connection stays closed.
	 */
	DoNotRestart = 1,
	/**
	 * Restart the server.
	 */
	Restart = 2,
}


/**
 * A pluggable error handler that is invoked when the connection is either
 * producing errors or got closed.
 */
export interface ErrorHandler {
	/**
	 * An error has occurred while writing or reading from the connection.
	 *
	 * @param error - the error received
	 * @param message - the message to be delivered to the server if know.
	 * @param count - a count indicating how often an error is received. Will
	 *  be reset if a message got successfully send or received.
	 */
	error(error: Error, message: Message, count: number): ErrorAction;

	/**
	 * The connection to the server got closed.
	 */
	closed(): CloseAction
}

class DefaultErrorHandler implements ErrorHandler {

	private restarts: number[];

	constructor(private name: string, private client: BaseLanguageClient) {
		this.restarts = [];
	}

	public error(_error: Error, _message: Message, count: number): ErrorAction {
		if (count && count <= 3) {
			return ErrorAction.Continue;
		}
		return ErrorAction.Shutdown;
	}
	public closed(): CloseAction {
		this.restarts.push(Date.now());
		if (this.restarts.length < 5) {
			return CloseAction.Restart;
		} else {
			let diff = this.restarts[this.restarts.length - 1] - this.restarts[0];
			if (diff <= 3 * 60 * 1000) {
				if (this.client.window) {
					this.client.window.showMessage(MessageType.Error, `The ${this.name} server crashed 5 times in the last 3 minutes. The server will not be restarted.`);
				}
				return CloseAction.DoNotRestart;
			} else {
				this.restarts.shift();
				return CloseAction.Restart;
			}
		}
	}
}

export interface InitializationFailedHandler {
	(error: ResponseError<InitializeError> | Error | any): boolean;
}

export interface SynchronizeOptions {
	configurationSection?: string | string[];
	fileEvents?: FileSystemWatcher | FileSystemWatcher[];
}

export enum RevealOutputChannelOn {
	Info = 1,
	Warn = 2,
	Error = 3,
	Never = 4
}

export interface BaseLanguageClientOptions {
	documentSelector?: DocumentSelector | string[];
	synchronize?: SynchronizeOptions;
	diagnosticCollectionName?: string;
	outputChannelName?: string;
	revealOutputChannelOn?: RevealOutputChannelOn;
	initializationOptions?: any | (() => any);
	initializationFailedHandler?: InitializationFailedHandler;
	errorHandler?: ErrorHandler;
}

export interface ResolvedClientOptions {
	documentSelector?: DocumentSelector;
	synchronize: SynchronizeOptions;
	diagnosticCollectionName?: string;
	outputChannelName: string;
	revealOutputChannelOn: RevealOutputChannelOn;
	initializationOptions?: any | (() => any);
	initializationFailedHandler?: InitializationFailedHandler;
	errorHandler: ErrorHandler;
}

export enum State {
	Stopped = 1,
	Running = 2
}

export interface StateChangeEvent {
	oldState: State;
	newState: State;
}

enum ClientState {
	Initial,
	Starting,
	StartFailed,
	Running,
	Stopping,
	Stopped
}

interface RegistrationData<T> {
	id: string;
	registerOptions: T;
}

interface FeatureHandler<T> {
	register(data: RegistrationData<T>): void;
	unregister(id: string): void;
	dispose(): void;
}

interface CreateParamsSignature<E, P> {
	(data: E): P;
}

class DocumentNotifiactions<P, E> implements FeatureHandler<TextDocumentRegistrationOptions> {

	private _listener: Disposable | undefined;
	protected _selectors: Map<string, DocumentSelector> = new Map<string, DocumentSelector>();

	public static textDocumentFilter(languages: Languages, selectors: IterableIterator<DocumentSelector>, textDocument: TextDocument): boolean {
		for (const selector of selectors) {
			if (languages.match(selector, textDocument)) {
				return true;
			}
		}
		return false;
	}

	constructor(
		protected _client: BaseLanguageClient, private _event: Event<E>,
		protected _type: NotificationType<P, DocumentSelector>, protected _createParams: CreateParamsSignature<E, P>,
		protected _selectorFilter?: (selectors: IterableIterator<DocumentSelector>, data: E) => boolean) {
	}

	public register(data: RegistrationData<TextDocumentRegistrationOptions>): void {
		if (!data.registerOptions.documentSelector) {
			return;
		}
		if (!this._listener) {
			this._listener = this._event(this.callback, this);
		}
		this._selectors.set(data.id, data.registerOptions.documentSelector);
	}

	private callback(data: E): void {
		if (!this._selectorFilter || this._selectorFilter(this._selectors.values(), data)) {
			this._client.sendNotification(this._type, this._createParams(data));
			this.notificationSent(data);
		}
	}

	protected notificationSent(_data: E): void {
	}

	public unregister(id: string): void {
		this._selectors.delete(id);
		if (this._selectors.size === 0 && this._listener) {
			this._listener.dispose();
			this._listener = undefined;
		}
	}

	public dispose(): void {
		if (this._listener) {
			this._listener.dispose();
		}
	}
}

class DidOpenTextDocumentFeature extends DocumentNotifiactions<DidOpenTextDocumentParams, TextDocument> {
	constructor(client: BaseLanguageClient, private _syncedDocuments: Map<string, TextDocument>) {
		super(
			client, client.workspace.onDidOpenTextDocument, DidOpenTextDocumentNotification.type,
			(textDocument) => {
				const { uri, languageId, version } = textDocument;
				const text = textDocument.getText();
				return {
					textDocument: {
						uri, languageId, version, text
					}
				}
			},
			(selectors, data) => DocumentNotifiactions.textDocumentFilter(client.languages, selectors, data)
		);
	}

	public register(data: RegistrationData<TextDocumentRegistrationOptions>): void {
		super.register(data);
		if (!data.registerOptions.documentSelector) {
			return;
		}
		let documentSelector = data.registerOptions.documentSelector;
		this._client.workspace.textDocuments.forEach((textDocument) => {
			let uri: string = textDocument.uri;
			if (!textDocument || this._syncedDocuments.has(uri)) {
				return;
			}
			if (this._client.languages.match(documentSelector, textDocument)) {
				this._client.sendNotification(this._type, this._createParams(textDocument));
				this._syncedDocuments.set(uri, textDocument);
			}
		});
	}

	protected notificationSent(textDocument: TextDocument): void {
		super.notificationSent(textDocument);
		this._syncedDocuments.set(textDocument.uri, textDocument);
	}
}

class DidCloseTextDocumentFeature extends DocumentNotifiactions<DidCloseTextDocumentParams, TextDocument> {

	constructor(client: BaseLanguageClient, private _syncedDocuments: Map<string, TextDocument>) {
		super(
			client, client.workspace.onDidCloseTextDocument, DidCloseTextDocumentNotification.type,
			(textDocument) => {
				return {
					textDocument: {
						uri: textDocument.uri
					}
				}
			},
			(selectors, data) => DocumentNotifiactions.textDocumentFilter(client.languages, selectors, data)
		);
	}

	protected notificationSent(textDocument: TextDocument): void {
		super.notificationSent(textDocument);
		this._syncedDocuments.delete(textDocument.uri);
	}

	public unregister(id: string): void {
		let selector = this._selectors.get(id)!;
		super.unregister(id);
		let selectors = this._selectors.values();
		this._syncedDocuments.forEach((textDocument) => {
			if (this._client.languages.match(selector, textDocument) && !this._selectorFilter!(selectors, textDocument)) {
				this._client.sendNotification(this._type, this._createParams(textDocument));
				this._syncedDocuments.delete(textDocument.uri);
			}
		});
	}
}

interface DidChangeTextDocumentData {
	documentSelector: DocumentSelector;
	syncKind: 0 | 1 | 2;
}

class DidChangeTextDocumentFeature implements FeatureHandler<TextDocumentChangeRegistrationOptions> {

	private _listener: Disposable | undefined;
	private _changeData: Map<string, DidChangeTextDocumentData> = new Map<string, DidChangeTextDocumentData>();
	private _forcingDelivery: boolean = false;
	private _changeDelayer: { uri: string; delayer: Delayer<void> } | undefined;
	private _workspace: Workspace;
	private _languages: Languages;

	constructor(private _client: BaseLanguageClient) {
		this._workspace = _client.workspace;
		this._languages = _client.languages;
	}

	public register(data: RegistrationData<TextDocumentChangeRegistrationOptions>): void {
		if (!data.registerOptions.documentSelector) {
			return;
		}
		if (!this._listener) {
			this._listener = this._workspace.onDidChangeTextDocument(this.callback, this);
		}
		this._changeData.set(
			data.id,
			{
				documentSelector: data.registerOptions.documentSelector,
				syncKind: data.registerOptions.syncKind
			}
		);
	}

	private callback(event: TextDocumentDidChangeEvent): void {
		for (const changeData of this._changeData.values()) {
			if (this._languages.match(changeData.documentSelector, event.textDocument)) {
				if (changeData.syncKind === TextDocumentSyncKind.Incremental) {
					this.sendDidChangeTextDocumentNotification(event.textDocument, event.contentChanges);
				} else if (changeData.syncKind === TextDocumentSyncKind.Full) {
					if (this._changeDelayer) {
						if (this._changeDelayer.uri !== event.textDocument.uri) {
							// Use this force delivery to track boolean state. Otherwise we might call two times.
							this.forceDelivery();
							this._changeDelayer.uri = event.textDocument.uri;
						}
						this._changeDelayer.delayer.trigger(() => {
							this.sendDidChangeTextDocumentNotification(event.textDocument)
						});
					} else {
						this._changeDelayer = {
							uri: event.textDocument.uri,
							delayer: new Delayer<void>(200)
						}
						this._changeDelayer.delayer.trigger(() => {
							this.sendDidChangeTextDocumentNotification(event.textDocument)
						}, -1);
					}
				}
			}
		}
	}

	private sendDidChangeTextDocumentNotification(textDocument: TextDocument, contentChanges: TextDocumentContentChangeEvent[] = [{ text: textDocument.getText() }]): void {
		this._client.sendNotification(DidChangeTextDocumentNotification.type, {
			textDocument: {
				uri: textDocument.uri,
				version: textDocument.version
			},
			contentChanges
		});
	}

	public unregister(id: string): void {
		this._changeData.delete(id);
		if (this._changeData.size === 0 && this._listener) {
			this._listener.dispose();
			this._listener = undefined;
		}
	}

	public dispose(): void {
		if (this._listener) {
			this._listener.dispose();
			this._listener = undefined;
		}
	}

	public forceDelivery() {
		if (this._forcingDelivery || !this._changeDelayer) {
			return;
		}
		try {
			this._forcingDelivery = true;
			this._changeDelayer.delayer.forceDelivery();
		} finally {
			this._forcingDelivery = false;
		}
	}
}

class WillSaveWaitUntilFeature implements FeatureHandler<TextDocumentRegistrationOptions> {

	private _listener: Disposable | undefined;
	private _selectors: Map<string, DocumentSelector> = new Map<string, DocumentSelector>();
	private workspace: Workspace;
	private languages: Languages;

	constructor(private _client: BaseLanguageClient) {
		this.workspace = _client.workspace;
		this.languages = _client.languages;
	}

	public register(data: RegistrationData<TextDocumentRegistrationOptions>): void {
		if (!data.registerOptions.documentSelector) {
			return;
		}
		if (!this._listener) {
			this._listener = this.workspace.onWillSaveTextDocument!(this.callback, this);
		}
		this._selectors.set(data.id, data.registerOptions.documentSelector);
	}

	private callback(event: TextDocumentWillSaveEvent): void {
		if (DocumentNotifiactions.textDocumentFilter(this.languages, this._selectors.values(), event.textDocument)) {
			event.waitUntil!(
				this._client.sendRequest(
					WillSaveTextDocumentWaitUntilRequest.type,
					{
						textDocument: { uri: event.textDocument.uri },
						reason: event.reason
					}
				)
			);
		}
	}

	public unregister(id: string): void {
		this._selectors.delete(id);
		if (this._selectors.size === 0 && this._listener) {
			this._listener.dispose();
			this._listener = undefined;
		}
	}

	public dispose(): void {
		if (this._listener) {
			this._listener.dispose();
			this._listener = undefined;
		}
	}
}

class DidSaveTextDocumentFeature extends DocumentNotifiactions<DidSaveTextDocumentParams, TextDocument> {

	private _includeText: boolean;

	constructor(client: BaseLanguageClient) {
		super(
			client, client.workspace.onDidSaveTextDocument!, DidSaveTextDocumentNotification.type,
			(textDocument) => {
				let result: DidSaveTextDocumentParams = {
					textDocument: {
						uri: textDocument.uri,
						version: textDocument.version
					}
				}
				if (this._includeText) {
					result.text = textDocument.getText()
				}
				return result;
			},
			(selectors, data) => DocumentNotifiactions.textDocumentFilter(client.languages, selectors, data)
		);
	}

	public register(data: RegistrationData<TextDocumentSaveRegistrationOptions>): void {
		this._includeText = !!data.registerOptions.includeText;
		super.register(data);
	}
}

interface CreateProviderSignature<T extends TextDocumentRegistrationOptions> {
	(options: T): Disposable;
}

class LanguageFeature<T extends TextDocumentRegistrationOptions> implements FeatureHandler<T> {

	protected _providers: Map<string, Disposable> = new Map<string, Disposable>();

	constructor(private _createProvider: CreateProviderSignature<T>) {
	}

	public register(data: RegistrationData<T>): void {
		if (!data.registerOptions.documentSelector) {
			return;
		}
		let provider = this._createProvider(data.registerOptions);
		if (provider) {
			this._providers.set(data.id, provider);
		}
	}

	public unregister(id: string): void {
		let provider = this._providers.get(id);
		if (provider) {
			provider.dispose();
		}
	}

	public dispose(): void {
		this._providers.forEach((value) => {
			value.dispose();
		});
	}
}


class ExecuteCommandFeature implements FeatureHandler<ExecuteCommandRegistrationOptions> {

	private _commands: Map<string, Disposable[]> = new Map<string, Disposable[]>();

	constructor(private _client: BaseLanguageClient, private _logger: (type: RPCMessageType, error?: any) => void) {
	}

	public register(data: RegistrationData<ExecuteCommandRegistrationOptions>): void {
		if (data.registerOptions.commands) {
			let disposeables: Disposable[] = [];
			for (const command of data.registerOptions.commands) {
				disposeables.push(this._client.commands!.registerCommand(command, (...args: any[]) => {
					let params: ExecuteCommandParams = {
						command,
						arguments: args
					};
					this._client.sendRequest(ExecuteCommandRequest.type, params).then(undefined, (error) => { this._logger(ExecuteCommandRequest.type, error); });
				}));
			}
			this._commands.set(data.id, disposeables);
		}
	}

	public unregister(id: string): void {
		let disposeables = this._commands.get(id);
		if (disposeables) {
			disposeables.forEach(disposable => disposable.dispose());
		}
	}

	public dispose(): void {
		this._commands.forEach((value) => {
			value.forEach(disposable => disposable.dispose());
		});
	}
}

export namespace BaseLanguageClient  {
	export interface IServices {
		languages: Languages;
		workspace: Workspace;
		commands?: Commands;
		window?: Window;
	}
	export interface IOptions {
		name: string;
		id?: string;
		clientOptions: BaseLanguageClientOptions;
		services: IServices;
		connectionProvider: IConnectionProvider
	}
}

export class BaseLanguageClient {

	private _id: string;
	private _name: string
	private _clientOptions: ResolvedClientOptions;

	private _state: ClientState;
	private _onReady: Promise<void>;
	private _onReadyCallbacks: { resolve: () => void; reject: (error: any) => void; };
	private _connectionPromise: Thenable<IConnection> | undefined;
	private _resolvedConnection: IConnection | undefined;
	private _outputChannel: OutputChannel | undefined;
	private _capabilites: ServerCapabilities;

	private _listeners: Disposable[] | undefined;
	private _providers: Disposable[] | undefined;
	private _diagnostics: DiagnosticCollection | undefined;

	private _fileEvents: FileEvent[];
	private _fileEventDelayer: Delayer<void>;

	private _telemetryEmitter: Emitter<any>;
	private _stateChangeEmitter: Emitter<StateChangeEvent>;

	private _trace: Trace;
	private _tracer: Tracer;

	readonly languages: Languages;
	readonly workspace: Workspace;
	readonly commands?: Commands;
	readonly window?: Window;
	protected readonly connectionProvider: IConnectionProvider;

	constructor(options: BaseLanguageClient.IOptions) {
		this._name = options.name;
		this._id = options.id ||  options.name.toLowerCase();
		this.languages = options.services.languages;
		this.workspace = options.services.workspace;
		this.commands = options.services.commands;
		this.window = options.services.window;
		this.connectionProvider = options.connectionProvider;
		const clientOptions = options.clientOptions;
		this._clientOptions = {
			...clientOptions,
			documentSelector: clientOptions.documentSelector || [],
			synchronize: clientOptions.synchronize || {},
			outputChannelName: clientOptions.outputChannelName || this._name,
			revealOutputChannelOn: clientOptions.revealOutputChannelOn || RevealOutputChannelOn.Error,
			errorHandler: clientOptions.errorHandler || new DefaultErrorHandler(this._name, this)
		};
		this._clientOptions.synchronize = this._clientOptions.synchronize || {};

		this.state = ClientState.Initial;
		this._connectionPromise = undefined;
		this._resolvedConnection = undefined;
		this._outputChannel = undefined;

		this._listeners = undefined;
		this._providers = undefined;
		this._diagnostics = undefined;

		this._fileEvents = [];
		this._fileEventDelayer = new Delayer<void>(250);
		this._onReady = new Promise<void>((resolve, reject) => {
			this._onReadyCallbacks = { resolve, reject };
		});
		this._telemetryEmitter = new Emitter<any>();
		this._stateChangeEmitter = new Emitter<StateChangeEvent>();
		this._tracer = {
			log: (message: string, data?: string) => {
				this.logTrace(message, data);
			}
		};
	}

	private get state(): ClientState {
		return this._state;
	}

	private set state(value: ClientState) {
		let oldState = this.getPublicState();
		this._state = value;
		let newState = this.getPublicState();
		if (newState !== oldState) {
			this._stateChangeEmitter.fire({ oldState, newState });
		}
	}

	private getPublicState(): State {
		if (this.state === ClientState.Running) {
			return State.Running;
		} else {
			return State.Stopped;
		}
	}

	public sendRequest<R, E, RO>(type: RequestType0<R, E, RO>, token?: CancellationToken): Thenable<R>;
	public sendRequest<P, R, E, RO>(type: RequestType<P, R, E, RO>, params: P, token?: CancellationToken): Thenable<R>;
	public sendRequest<R>(method: string, token?: CancellationToken): Thenable<R>;
	public sendRequest<R>(method: string, param: any, token?: CancellationToken): Thenable<R>;
	public sendRequest<R>(type: string | RPCMessageType, ...params: any[]): Thenable<R> {
		if (!this.isConnectionActive()) {
			throw new Error('Language client is not ready yet');
		}
		this.forceDocumentSync();
		try {
			return this._resolvedConnection!.sendRequest<R>(type, ...params);
		} catch (error) {
			this.error(`Sending request ${is.string(type) ? type : type.method} failed.`, error);
			throw error;
		}
	}

	public onRequest<R, E, RO>(type: RequestType0<R, E, RO>, handler: RequestHandler0<R, E>): void;
	public onRequest<P, R, E, RO>(type: RequestType<P, R, E, RO>, handler: RequestHandler<P, R, E>): void;
	public onRequest<R, E>(method: string, handler: GenericRequestHandler<R, E>): void;
	public onRequest<R, E>(type: string | RPCMessageType, handler: GenericRequestHandler<R, E>): void {
		if (!this.isConnectionActive()) {
			throw new Error('Language client is not ready yet');
		}
		try {
			this._resolvedConnection!.onRequest(type, handler);
		} catch (error) {
			this.error(`Registering request handler ${is.string(type) ? type : type.method} failed.`, error);
			throw error;
		}
	}

	public sendNotification<RO>(type: NotificationType0<RO>): void;
	public sendNotification<P, RO>(type: NotificationType<P, RO>, params?: P): void;
	public sendNotification(method: string): void;
	public sendNotification(method: string, params: any): void;
	public sendNotification<P>(type: string | RPCMessageType, params?: P): void {
		if (!this.isConnectionActive()) {
			throw new Error('Language client is not ready yet');
		}
		this.forceDocumentSync();
		try {
			this._resolvedConnection!.sendNotification(type, params);
		} catch (error) {
			this.error(`Sending notification ${is.string(type) ? type : type.method} failed.`, error);
			throw error;
		}
	}

	public onNotification<RO>(type: NotificationType0<RO>, handler: NotificationHandler0): void;
	public onNotification<P, RO>(type: NotificationType<P, RO>, handler: NotificationHandler<P>): void;
	public onNotification(method: string, handler: GenericNotificationHandler): void;
	public onNotification(type: string | RPCMessageType, handler: GenericNotificationHandler): void {
		if (!this.isConnectionActive()) {
			throw new Error('Language client is not ready yet');
		}
		try {
			this._resolvedConnection!.onNotification(type, handler);
		} catch (error) {
			this.error(`Registering notification handler ${is.string(type) ? type : type.method} failed.`, error);
			throw error;
		}
	}

	public get onTelemetry(): Event<any> {
		return this._telemetryEmitter.event;
	}

	public get onDidChangeState(): Event<StateChangeEvent> {
		return this._stateChangeEmitter.event;
	}

	public get outputChannel(): OutputChannel | undefined {
		if (!this._outputChannel && this.window && this.window.createOutputChannel) {
			this._outputChannel = this.window.createOutputChannel(this._clientOptions.outputChannelName ? this._clientOptions.outputChannelName : this._name);
		}
		return this._outputChannel;
	}

	public get diagnostics(): DiagnosticCollection | undefined {
		return this._diagnostics;
	}

	public createDefaultErrorHandler(): ErrorHandler {
		return new DefaultErrorHandler(this._name, this);
	}

	public set trace(value: Trace) {
		this._trace = value;
		this.onReady().then(() => {
			this.resolveConnection().then((connection) => {
				connection.trace(value, this._tracer);
			})
		}, () => {
		});
	}

	private data2String(data: any): string {
		if (data instanceof ResponseError) {
			const responseError = data as ResponseError<any>;
			return `  Message: ${responseError.message}\n  Code: ${responseError.code} ${responseError.data ? '\n' + responseError.data.toString() : ''}`
		}
		if (data instanceof Error) {
			if (is.string(data.stack)) {
				return data.stack;
			}
			return (data as Error).message;
		}
		if (is.string(data)) {
			return data;
		}
		return data.toString();
	}

	public info(message: string, data?: any): void {
		const outputChannel = this.outputChannel;
		if (outputChannel) {
			outputChannel.appendLine(`[Info  - ${(new Date().toLocaleTimeString())}] ${message}`);
			if (data) {
				outputChannel.appendLine(this.data2String(data));
			}
			if (this._clientOptions.revealOutputChannelOn <= RevealOutputChannelOn.Info) {
				outputChannel.show(true);
			}
		}
	}

	public warn(message: string, data?: any): void {
		const outputChannel = this.outputChannel;
		if (outputChannel) {
			outputChannel.appendLine(`[Warn  - ${(new Date().toLocaleTimeString())}] ${message}`);
			if (data) {
				outputChannel.appendLine(this.data2String(data));
			}
			if (this._clientOptions.revealOutputChannelOn <= RevealOutputChannelOn.Warn) {
				outputChannel.show(true);
			}
		}
	}

	public error(message: string, data?: any): void {
		const outputChannel = this.outputChannel;
		if (outputChannel) {
			outputChannel.appendLine(`[Error - ${(new Date().toLocaleTimeString())}] ${message}`);
			if (data) {
				outputChannel.appendLine(this.data2String(data));
			}
			if (this._clientOptions.revealOutputChannelOn <= RevealOutputChannelOn.Error) {
				outputChannel.show(true);
			}
		}
	}

	private logTrace(message: string, data?: any): void {
		const outputChannel = this.outputChannel;
		if (outputChannel) {
			outputChannel.appendLine(`[Trace - ${(new Date().toLocaleTimeString())}] ${message}`);
			if (data) {
				outputChannel.appendLine(this.data2String(data));
			}
			outputChannel.show(true);
		}
	}

	public needsStart(): boolean {
		return this.state === ClientState.Initial || this.state === ClientState.Stopping || this.state === ClientState.Stopped;
	}

	public needsStop(): boolean {
		return this.state === ClientState.Starting || this.state === ClientState.Running;
	}

	public onReady(): Promise<void> {
		return this._onReady;
	}

	private isConnectionActive(): boolean {
		return this.state === ClientState.Running && !!this._resolvedConnection;
	}

	public start(): Disposable {
		this._listeners = [];
		this._providers = [];
		// If we restart then the diagnostics collection is reused.
		if (!this._diagnostics && this.languages.createDiagnosticCollection) {
			this._diagnostics = this.languages.createDiagnosticCollection(this._clientOptions.diagnosticCollectionName);
		}

		this.state = ClientState.Starting;
		this.resolveConnection().then((connection) => {
			connection.onLogMessage((message) => {
				switch (message.type) {
					case MessageType.Error:
						this.error(message.message);
						break;
					case MessageType.Warning:
						this.warn(message.message);
						break;
					case MessageType.Info:
						this.info(message.message);
						break;
					default: {
						if (this.outputChannel) {
							this.outputChannel.appendLine(message.message);
						}
					}
				}
			});
			const window = this.window;
			if (window) {
				connection.onShowMessage((message) => window.showMessage(message.type, message.message));
				connection.onRequest(ShowMessageRequest.type, (params) => {
					const actions = params.actions || [];
					return window.showMessage(params.type, params.message, ...actions);
				});
			}
			connection.onTelemetry((data) => {
				this._telemetryEmitter.fire(data);
			});
			this.initRegistrationHandlers(connection);
			connection.listen();
			// Error is handled in the intialize call.
			this.initialize(connection).then(undefined, () => { });
		}, (error) => {
			this.state = ClientState.StartFailed;
			this._onReadyCallbacks.reject(error);
			this.error('Starting client failed', error);
			if (this.window) {
				this.window.showMessage(MessageType.Error, `Couldn't start client ${this._name}`);
			}
		});
		return Disposable.create(() => {
			if (this.needsStop()) {
				this.stop();
			}
		});
	}

	private resolveConnection(): Thenable<IConnection> {
		if (!this._connectionPromise) {
			this._connectionPromise = this.createConnection();
		}
		return this._connectionPromise;
	}

	protected createClientCapabilities(): ClientCapabilities {
		return {
			workspace: {
				...this.workspace.capabilities,
				didChangeConfiguration: {
					dynamicRegistration: false
				},
				didChangeWatchedFiles: {
					dynamicRegistration: false
				},
				symbol: {
					dynamicRegistration: true
				},
				executeCommand: {
					dynamicRegistration: true
				}
			},
			textDocument: {
				synchronization: {
					...this.workspace.synchronization,
					dynamicRegistration: true
				},
				completion: {
					...this.languages.completion,
					dynamicRegistration: true
				},
				hover: {
					dynamicRegistration: true
				},
				signatureHelp: {
					dynamicRegistration: true
				},
				references: {
					dynamicRegistration: true
				},
				documentHighlight: {
					dynamicRegistration: true
				},
				documentSymbol: {
					dynamicRegistration: true
				},
				formatting: {
					dynamicRegistration: true
				},
				rangeFormatting: {
					dynamicRegistration: true
				},
				onTypeFormatting: {
					dynamicRegistration: true
				},
				definition: {
					dynamicRegistration: true
				},
				codeAction: {
					dynamicRegistration: true
				},
				codeLens: {
					dynamicRegistration: true
				},
				documentLink: {
					dynamicRegistration: true
				},
				rename: {
					dynamicRegistration: true
				}
			}
		}
	}

	private initialize(connection: IConnection): Thenable<InitializeResult> {
		this.refreshTrace(connection, false);
		let initOption = this._clientOptions.initializationOptions;
		const rootPath = this.workspace && this.workspace.rootPath || null;
		const rootUri = this.workspace && this.workspace.rootUri || null;
		const clientCapabilities = this.createClientCapabilities();
		let initParams: InitializeParams = {
			processId: process.pid,
			rootPath, rootUri,
			capabilities: clientCapabilities,
			initializationOptions: is.func(initOption) ? initOption() : initOption,
			trace: Trace.toString(this._trace)
		};
		return connection.initialize(initParams).then((result) => {
			this._resolvedConnection = connection;
			this.state = ClientState.Running;

			this._capabilites = result.capabilities;

			connection.onDiagnostics(params => this.handleDiagnostics(params));
			// backward compatibility
			connection.onRequest('client/registerFeature', params => this.handleRegistrationRequest(params));
			connection.onRequest(RegistrationRequest.type, params => this.handleRegistrationRequest(params));
			// backward compatibility
			connection.onRequest('client/unregisterFeature', params => this.handleUnregistrationRequest(params));
			connection.onRequest(UnregistrationRequest.type, params => this.handleUnregistrationRequest(params));
			connection.onRequest(ApplyWorkspaceEditRequest.type, params => this.handleApplyWorkspaceEdit(params));
			connection.sendNotification(InitializedNotification.type, {});

			this.hookFileEvents(connection);
			this.hookConfigurationChanged(connection);
			if (this._clientOptions.documentSelector) {
				let selectorOptions: TextDocumentRegistrationOptions = { documentSelector: this._clientOptions.documentSelector };
				let textDocumentSyncOptions: TextDocumentSyncOptions | undefined = undefined;
				if (is.number(this._capabilites.textDocumentSync) && this._capabilites.textDocumentSync !== TextDocumentSyncKind.None) {
					textDocumentSyncOptions = {
						openClose: true,
						change: this._capabilites.textDocumentSync,
						save: {
							includeText: false
						}
					};
				} else if (this._capabilites.textDocumentSync !== void 0 && this._capabilites.textDocumentSync !== null) {
					textDocumentSyncOptions = this._capabilites.textDocumentSync as TextDocumentSyncOptions;
				}
				if (textDocumentSyncOptions) {
					if (textDocumentSyncOptions.openClose) {
						this.registerHandler(DidOpenTextDocumentNotification.type.method,
							{ id: UUID.generateUuid(), registerOptions: selectorOptions }
						);
						this.registerHandler(DidCloseTextDocumentNotification.type.method,
							{ id: UUID.generateUuid(), registerOptions: selectorOptions }
						);
					}
					if (textDocumentSyncOptions.change !== TextDocumentSyncKind.None) {
						this.registerHandler(DidChangeTextDocumentNotification.type.method,
							{
								id: UUID.generateUuid(),
								registerOptions: Object.assign({}, selectorOptions, { syncKind: textDocumentSyncOptions.change }) as TextDocumentChangeRegistrationOptions
							}
						);
					}
					if (textDocumentSyncOptions.willSave) {
						this.registerHandler(WillSaveTextDocumentNotification.type.method,
							{ id: UUID.generateUuid(), registerOptions: selectorOptions }
						);
					}
					if (textDocumentSyncOptions.willSaveWaitUntil) {
						this.registerHandler(WillSaveTextDocumentWaitUntilRequest.type.method,
							{ id: UUID.generateUuid(), registerOptions: selectorOptions }
						);
					}
					if (textDocumentSyncOptions.save) {
						this.registerHandler(DidSaveTextDocumentNotification.type.method,
							{
								id: UUID.generateUuid(),
								registerOptions: Object.assign({}, selectorOptions, { includeText: !!textDocumentSyncOptions.save.includeText }) as TextDocumentSaveRegistrationOptions
							}
						);
					}
				}
			}
			this.hookCapabilities(connection);
			this._onReadyCallbacks.resolve();
			return result;
		}, (error: any) => {
			if (this._clientOptions.initializationFailedHandler) {
				if (this._clientOptions.initializationFailedHandler(error)) {
					this.initialize(connection);
				} else {
					this.stop();
					this._onReadyCallbacks.reject(error);
				}
			} else if (error instanceof ResponseError && error.data && error.data.retry && this.window) {
				this.window.showMessage(MessageType.Error, error.message, { title: 'Retry', id: "retry" }).then(item => {
					if (item && item.id === 'retry') {
						this.initialize(connection);
					} else {
						this.stop();
						this._onReadyCallbacks.reject(error);
					}
				});
			} else {
				if (error && error.message && this.window) {
					this.window.showMessage(MessageType.Error, error.message);
				}
				this.error('Server initialization failed.', error);
				this.stop();
				this._onReadyCallbacks.reject(error);
			}
		});
	}

	public stop(): Thenable<void> {
		if (!this._connectionPromise) {
			this.state = ClientState.Stopped;
			return Promise.resolve();
		}
		this.state = ClientState.Stopping;
		this.cleanUp();
		// unkook listeners
		return this.resolveConnection().then(connection => {
			return connection.shutdown().then(() => {
				connection.exit();
				connection.dispose();
				this.state = ClientState.Stopped;
				this._connectionPromise = undefined;
				this._resolvedConnection = undefined;
				// Remove all markers
			})
		});
	}

	private cleanUp(diagnostics: boolean = true): void {
		if (this._listeners) {
			this._listeners.forEach(listener => listener.dispose());
			this._listeners = undefined;
		}
		if (this._providers) {
			this._providers.forEach(provider => provider.dispose());
			this._providers = undefined;
		}
		if (diagnostics && this._diagnostics) {
			this._diagnostics.dispose();
			this._diagnostics = undefined;
		}
		for (const handler of Array.from(this._registeredHandlers.values())) {
			handler.dispose();
		}
		this._registeredHandlers.clear();
	}

	private notifyFileEvent(event: FileEvent): void {
		this._fileEvents.push(event);
		this._fileEventDelayer.trigger(() => {
			this.onReady().then(() => {
				this.resolveConnection().then(connection => {
					if (this.isConnectionActive()) {
						connection.didChangeWatchedFiles({ changes: this._fileEvents });
					}
					this._fileEvents = [];
				})
			}, (error) => {
				this.error(`Notify file events failed.`, error);
			});
		});
	}

	private forceDocumentSync(): void {
		(this._registeredHandlers.get(DidChangeTextDocumentNotification.type.method) as DidChangeTextDocumentFeature).forceDelivery();
	}

	private handleDiagnostics(params: PublishDiagnosticsParams) {
		if (!this._diagnostics) {
			return;
		}
		this._diagnostics.set(params.uri, params.diagnostics);
	}

	private createConnection(): Thenable<IConnection> {
		const errorHandler = this.handleConnectionError.bind(this);
		const closeHandler = this.handleConnectionClosed.bind(this);
		return this.connectionProvider.get(errorHandler, closeHandler, this.outputChannel);
	}

	private handleConnectionClosed() {
		// Check whether this is a normal shutdown in progress or the client stopped normally.
		if (this.state === ClientState.Stopping || this.state === ClientState.Stopped) {
			return;
		}
		this._connectionPromise = undefined;
		this._resolvedConnection = undefined;
		let action = this._clientOptions.errorHandler!.closed();
		if (action === CloseAction.DoNotRestart) {
			this.error('Connection to server got closed. Server will not be restarted.');
			this.state = ClientState.Stopped;
			this.cleanUp();
		} else if (action === CloseAction.Restart) {
			this.info('Connection to server got closed. Server will restart.');
			this.cleanUp(false);
			this.state = ClientState.Initial;
			this.start();
		}
	}

	private handleConnectionError(error: Error, message: Message, count: number) {
		let action = this._clientOptions.errorHandler!.error(error, message, count);
		if (action === ErrorAction.Shutdown) {
			this.error('Connection to server is erroring. Shutting down server.')
			this.stop();
		}
	}

	private hookConfigurationChanged(connection: IConnection): void {
		if (!this._clientOptions.synchronize!.configurationSection || !this.workspace.configurations) {
			return;
		}
		this.workspace.configurations.onDidChangeConfiguration(() => this.onDidChangeConfiguration(connection), this, this._listeners);
		this.onDidChangeConfiguration(connection);
	}

	private refreshTrace(connection: IConnection, sendNotification: boolean = false): void {
		const configurations = this.workspace.configurations;
		if (configurations) {
			const config = configurations.getConfiguration(this._id);
			this._trace = !!config ? Trace.fromString(config.get('trace.server', 'off')) : Trace.Off;
			connection.trace(this._trace, this._tracer, sendNotification);
		}
	}

	private onDidChangeConfiguration(connection: IConnection): void {
		this.refreshTrace(connection, true);
		let keys: string[] | undefined;
		let configurationSection = this._clientOptions.synchronize!.configurationSection;
		if (is.string(configurationSection)) {
			keys = [configurationSection];
		} else if (is.stringArray(configurationSection)) {
			keys = configurationSection;
		}
		if (keys) {
			if (this.isConnectionActive()) {
				connection.didChangeConfiguration({ settings: this.extractSettingsInformation(keys) });
			}
		}
	}

	private extractSettingsInformation(keys: string[]): any {
		function ensurePath(config: any, path: string[]): any {
			let current = config;
			for (let i = 0; i < path.length - 1; i++) {
				let obj = current[path[i]];
				if (!obj) {
					obj = Object.create(null);
					current[path[i]] = obj;
				}
				current = obj;
			}
			return current;
		}
		let result = Object.create(null);
		for (let i = 0; i < keys.length; i++) {
			let key = keys[i];
			let index: number = key.indexOf('.');
			let config: any = null;
			if (index >= 0) {
				config = this.workspace.configurations!.getConfiguration(key.substr(0, index)).get(key.substr(index + 1));
			} else {
				config = this.workspace.configurations!.getConfiguration(key);
			}
			if (config) {
				let path = keys[i].split('.');
				ensurePath(result, path)[path[path.length - 1]] = config;
			}
		}
		return result;
	}

	private hookFileEvents(_connection: IConnection): void {
		let fileEvents = this._clientOptions.synchronize!.fileEvents;
		if (!fileEvents) {
			return;
		}
		let watchers: FileSystemWatcher[];
		if (is.array(fileEvents)) {
			watchers = <FileSystemWatcher[]>fileEvents;
		} else {
			watchers = [<FileSystemWatcher>fileEvents];
		}
		if (!watchers) {
			return;
		}
		watchers.forEach(watcher => {
			watcher.onFileEvent(event => this.notifyFileEvent(event), null, this._listeners);
		})
	}

	private readonly _registeredHandlers = new Map<string, FeatureHandler<any>>();
	private initRegistrationHandlers(_connection: IConnection) {
		const syncedDocuments: Map<string, TextDocument> = new Map<string, TextDocument>();
		const logger = (type: RPCMessageType, error: any): void => { this.logFailedRequest(type, error); };
		this._registeredHandlers.set(
			DidOpenTextDocumentNotification.type.method,
			new DidOpenTextDocumentFeature(this, syncedDocuments)
		);
		this._registeredHandlers.set(
			DidChangeTextDocumentNotification.type.method,
			new DidChangeTextDocumentFeature(this)
		);
		if (this.workspace.onWillSaveTextDocument) {
			this._registeredHandlers.set(
				WillSaveTextDocumentNotification.type.method,
				new DocumentNotifiactions<WillSaveTextDocumentParams, TextDocumentWillSaveEvent>(
					this, this.workspace.onWillSaveTextDocument, WillSaveTextDocumentNotification.type,
					event => <WillSaveTextDocumentParams> {
						textDocument: { uri: event.textDocument.uri },
						reason: event.reason
					},
					(selectors, willSaveEvent) => DocumentNotifiactions.textDocumentFilter(this.languages, selectors, willSaveEvent.textDocument)
				)
			);
			if (!!this.workspace.synchronization && this.workspace.synchronization.willSaveWaitUntil) {
				this._registeredHandlers.set(
					WillSaveTextDocumentWaitUntilRequest.type.method,
					new WillSaveWaitUntilFeature(this)
				);
			}
		}
		if (this.workspace.onDidSaveTextDocument) {
			this._registeredHandlers.set(
				DidSaveTextDocumentNotification.type.method,
				new DidSaveTextDocumentFeature(this)
			);
		}
		this._registeredHandlers.set(
			DidCloseTextDocumentNotification.type.method,
			new DidCloseTextDocumentFeature(this, syncedDocuments)
		);
		if (this.languages.registerCompletionItemProvider) {
			this._registeredHandlers.set(
				CompletionRequest.type.method,
				new LanguageFeature<CompletionRegistrationOptions>((options) => this.createCompletionProvider(options))
			);
		}
		if (this.languages.registerHoverProvider) {
			this._registeredHandlers.set(
				HoverRequest.type.method,
				new LanguageFeature<TextDocumentRegistrationOptions>((options) => this.createHoverProvider(options))
			);
		}
		if (this.languages.registerSignatureHelpProvider) {
			this._registeredHandlers.set(
				SignatureHelpRequest.type.method,
				new LanguageFeature<SignatureHelpRegistrationOptions>((options) => this.createSignatureHelpProvider(options))
			);
		}
		if (this.languages.registerDefinitionProvider) {
			this._registeredHandlers.set(
				DefinitionRequest.type.method,
				new LanguageFeature<TextDocumentRegistrationOptions>((options) => this.createDefinitionProvider(options))
			);
		}
		if (this.languages.registerReferenceProvider) {
			this._registeredHandlers.set(
				ReferencesRequest.type.method,
				new LanguageFeature<TextDocumentRegistrationOptions>((options) => this.createReferencesProvider(options))
			);
		}
		if (this.languages.registerDocumentHighlightProvider) {
			this._registeredHandlers.set(
				DocumentHighlightRequest.type.method,
				new LanguageFeature<TextDocumentRegistrationOptions>((options) => this.createDocumentHighlightProvider(options))
			);
		}
		if (this.languages.registerDocumentSymbolProvider) {
			this._registeredHandlers.set(
				DocumentSymbolRequest.type.method,
				new LanguageFeature<TextDocumentRegistrationOptions>((options) => this.createDocumentSymbolProvider(options))
			);
		}
		if (this.languages.registerWorkspaceSymbolProvider) {
			this._registeredHandlers.set(
				WorkspaceSymbolRequest.type.method,
				new LanguageFeature<TextDocumentRegistrationOptions>((options) => this.createWorkspaceSymbolProvider(options))
			);
		}
		if (this.languages.registerCodeActionsProvider) {
			this._registeredHandlers.set(
				CodeActionRequest.type.method,
				new LanguageFeature<TextDocumentRegistrationOptions>((options) => this.createCodeActionsProvider(options))
			);
		}
		if (this.languages.registerCodeLensProvider) {
			this._registeredHandlers.set(
				CodeLensRequest.type.method,
				new LanguageFeature<CodeLensRegistrationOptions>((options) => this.createCodeLensProvider(options))
			);
		}
		if (this.languages.registerDocumentFormattingEditProvider) {
			this._registeredHandlers.set(
				DocumentFormattingRequest.type.method,
				new LanguageFeature<TextDocumentRegistrationOptions>((options) => this.createDocumentFormattingProvider(options))
			);
		}
		if (this.languages.registerDocumentRangeFormattingEditProvider) {
			this._registeredHandlers.set(
				DocumentRangeFormattingRequest.type.method,
				new LanguageFeature<TextDocumentRegistrationOptions>((options) => this.createDocumentRangeFormattingProvider(options))
			);
		}
		if (this.languages.registerOnTypeFormattingEditProvider) {
			this._registeredHandlers.set(
				DocumentOnTypeFormattingRequest.type.method,
				new LanguageFeature<DocumentOnTypeFormattingRegistrationOptions>((options) => this.createDocumentOnTypeFormattingProvider(options))
			);
		}
		if (this.languages.registerRenameProvider) {
			this._registeredHandlers.set(
				RenameRequest.type.method,
				new LanguageFeature<TextDocumentRegistrationOptions>((options) => this.createRenameProvider(options))
			);
		}
		if (this.languages.registerDocumentLinkProvider) {
			this._registeredHandlers.set(
				DocumentLinkRequest.type.method,
				new LanguageFeature<DocumentLinkRegistrationOptions>((options) => this.createDocumentLinkProvider(options))
			);
		}
		if (this.commands) {
			this._registeredHandlers.set(
				ExecuteCommandRequest.type.method,
				new ExecuteCommandFeature(this, logger)
			);
		}
	}

	private handleRegistrationRequest(params: RegistrationParams): Thenable<void> {
		return new Promise<void>((resolve, _reject) => {
			params.registrations.forEach((element) => {
				const handler = this._registeredHandlers.get(element.method);
				const options = element.registerOptions || {};
				options.documentSelector = options.documentSelector || this._clientOptions.documentSelector;
				const data: RegistrationData<any> = {
					id: element.id,
					registerOptions: options
				}
				if (handler) {
					handler.register(data);
				}
			});
			resolve();
		});
	}

	private handleUnregistrationRequest(params: UnregistrationParams): Thenable<void> {
		return new Promise<void>((resolve, _reject) => {
			params.unregisterations.forEach((element) => {
				const handler = this._registeredHandlers.get(element.method);
				if (handler) {
					handler.unregister(element.id);
				}
			});
			resolve();
		});
	}

	private handleApplyWorkspaceEdit(params: ApplyWorkspaceEditParams): Thenable<ApplyWorkspaceEditResponse> {
		if (!this.workspace.applyEdit) {
			return Promise.resolve({ applied: false });
		}
		// This is some sort of workaround since the version check should be done by VS Code in the Workspace.applyEdit.
		// However doing it here adds some safety since the server can lag more behind then an extension.
		let workspaceEdit: WorkspaceEdit = params.edit;
		let openTextDocuments: Map<string, TextDocument> = new Map<string, TextDocument>();
		this.workspace.textDocuments.forEach((document) => openTextDocuments.set(document.uri, document));
		let versionMismatch = false;
		if (workspaceEdit.documentChanges) {
			for (const change of workspaceEdit.documentChanges) {
				if (change.textDocument.version && change.textDocument.version >= 0) {
					let textDocument = openTextDocuments.get(change.textDocument.uri);
					if (textDocument && textDocument.version !== change.textDocument.version) {
						versionMismatch = true;
						break;
					}
				}
			}
		}
		if (versionMismatch) {
			return Promise.resolve({ applied: false });
		}
		return this.workspace.applyEdit(params.edit).then(applied => { return { applied }; });
	};

	private registerHandler(method: string, data: any): void {
		const handler = this._registeredHandlers.get(method);
		if (handler) {
			handler.register(data);
		}
	}

	private hookCapabilities(_connection: IConnection): void {
		let documentSelector = this._clientOptions.documentSelector;
		if (!documentSelector) {
			return;
		}
		let selectorOptions: TextDocumentRegistrationOptions = { documentSelector: documentSelector };
		if (this._capabilites.completionProvider) {
			let options: CompletionRegistrationOptions = Object.assign({}, selectorOptions, this._capabilites.completionProvider);
			this.registerHandler(CompletionRequest.type.method, { id: UUID.generateUuid(), registerOptions: options });
		}
		if (this._capabilites.hoverProvider) {
			this.registerHandler(HoverRequest.type.method,
				{ id: UUID.generateUuid(), registerOptions: Object.assign({}, selectorOptions) }
			);
		}
		if (this._capabilites.signatureHelpProvider) {
			let options: SignatureHelpRegistrationOptions = Object.assign({}, selectorOptions, this._capabilites.signatureHelpProvider);
			this.registerHandler(SignatureHelpRequest.type.method,
				{ id: UUID.generateUuid(), registerOptions: options }
			);
		}

		if (this._capabilites.definitionProvider) {
			this.registerHandler(DefinitionRequest.type.method,
				{ id: UUID.generateUuid(), registerOptions: Object.assign({}, selectorOptions) }
			);
		}

		if (this._capabilites.referencesProvider) {
			this.registerHandler(ReferencesRequest.type.method,
				{ id: UUID.generateUuid(), registerOptions: Object.assign({}, selectorOptions) }
			);
		}

		if (this._capabilites.documentHighlightProvider) {
			this.registerHandler(DocumentHighlightRequest.type.method,
				{ id: UUID.generateUuid(), registerOptions: Object.assign({}, selectorOptions) }
			);
		}

		if (this._capabilites.documentSymbolProvider) {
			this.registerHandler(DocumentSymbolRequest.type.method,
				{ id: UUID.generateUuid(), registerOptions: Object.assign({}, selectorOptions) }
			);
		}

		if (this._capabilites.workspaceSymbolProvider) {
			this.registerHandler(WorkspaceSymbolRequest.type.method,
				{ id: UUID.generateUuid(), registerOptions: Object.assign({}, selectorOptions) }
			);
		}

		if (this._capabilites.codeActionProvider) {
			this.registerHandler(CodeActionRequest.type.method,
				{ id: UUID.generateUuid(), registerOptions: Object.assign({}, selectorOptions) }
			);
		}

		if (this._capabilites.codeLensProvider) {
			let options: CodeLensRegistrationOptions = Object.assign({}, selectorOptions, this._capabilites.codeLensProvider);
			this.registerHandler(CodeLensRequest.type.method,
				{ id: UUID.generateUuid(), registerOptions: options }
			);
		}

		if (this._capabilites.documentFormattingProvider) {
			this.registerHandler(DocumentFormattingRequest.type.method,
				{ id: UUID.generateUuid(), registerOptions: Object.assign({}, selectorOptions) }
			);
		}

		if (this._capabilites.documentRangeFormattingProvider) {
			this.registerHandler(DocumentRangeFormattingRequest.type.method,
				{ id: UUID.generateUuid(), registerOptions: Object.assign({}, selectorOptions) }
			);
		}

		if (this._capabilites.documentOnTypeFormattingProvider) {
			let options: DocumentOnTypeFormattingRegistrationOptions = Object.assign({}, selectorOptions, this._capabilites.documentOnTypeFormattingProvider);
			this.registerHandler(DocumentOnTypeFormattingRequest.type.method,
				{ id: UUID.generateUuid(), registerOptions: options }
			);
		}

		if (this._capabilites.renameProvider) {
			this.registerHandler(RenameRequest.type.method,
				{ id: UUID.generateUuid(), registerOptions: Object.assign({}, selectorOptions) }
			);
		}

		if (this._capabilites.documentLinkProvider) {
			let options: DocumentLinkRegistrationOptions = Object.assign({}, selectorOptions, this._capabilites.documentLinkProvider);
			this.registerHandler(DocumentLinkRequest.type.method,
				{ id: UUID.generateUuid(), registerOptions: options }
			);
		}
		if (this._capabilites.executeCommandProvider) {
			let options: ExecuteCommandRegistrationOptions = Object.assign({}, this._capabilites.executeCommandProvider);
			this.registerHandler(ExecuteCommandRequest.type.method,
				{ id: UUID.generateUuid(), registerOptions: options }
			);
		}
	}

	protected logFailedRequest(type: RPCMessageType, error: any): void {
		// If we get a request cancel don't log anything.
		if (error instanceof ResponseError && error.code === ErrorCodes.RequestCancelled) {
			return;
		}
		this.error(`Request ${type.method} failed.`, error);
	}

	protected createRequestHandler<P, R, E, RO>(type: RequestType<P, R, E, RO>, onError?: (param: P, error: ResponseError<E>) => R | null | Error): (params: P, token: CancellationToken) => Thenable<R> {
		return (params, token) => {
			return this.sendRequest(type, params, token).then(
				(result) => result,
				(error: ResponseError<E>) => {
					this.logFailedRequest(type, error);
					const result = onError ? onError(params, error) : null;
					return Promise.reject(result);
				}
			);
		}
	}

	private createCompletionProvider(options: CompletionRegistrationOptions): Disposable {
		let triggerCharacters = options.triggerCharacters || [];
		return this.languages.registerCompletionItemProvider!(options.documentSelector!, {
			provideCompletionItems: this.createRequestHandler(CompletionRequest.type, () => []),
			resolveCompletionItem: options.resolveProvider ? this.createRequestHandler(CompletionResolveRequest.type, (params) => params) : undefined
		}, ...triggerCharacters);
	}

	private createHoverProvider(options: TextDocumentRegistrationOptions): Disposable {
		return this.languages.registerHoverProvider!(options.documentSelector!, {
			provideHover: this.createRequestHandler(HoverRequest.type)
		});
	}

	private createSignatureHelpProvider(options: SignatureHelpRegistrationOptions): Disposable {
		let triggerCharacters = options.triggerCharacters || [];
		return this.languages.registerSignatureHelpProvider!(options.documentSelector!, {
			provideSignatureHelp: this.createRequestHandler(SignatureHelpRequest.type)
		}, ...triggerCharacters);
	}

	private createDefinitionProvider(options: TextDocumentRegistrationOptions): Disposable {
		return this.languages.registerDefinitionProvider!(options.documentSelector!, {
			provideDefinition: this.createRequestHandler(DefinitionRequest.type)
		});
	}

	private createReferencesProvider(options: TextDocumentRegistrationOptions): Disposable {
		return this.languages.registerReferenceProvider!(options.documentSelector!, {
			provideReferences: this.createRequestHandler(ReferencesRequest.type, () => [])
		});
	}

	private createDocumentHighlightProvider(options: TextDocumentRegistrationOptions): Disposable {
		return this.languages.registerDocumentHighlightProvider!(options.documentSelector!, {
			provideDocumentHighlights: this.createRequestHandler(DocumentHighlightRequest.type, () => [])
		});
	}

	private createDocumentSymbolProvider(options: TextDocumentRegistrationOptions): Disposable {
		return this.languages.registerDocumentSymbolProvider!(options.documentSelector!, {
			provideDocumentSymbols: this.createRequestHandler(DocumentSymbolRequest.type, () => [])
		});
	}

	private createWorkspaceSymbolProvider(_options: TextDocumentRegistrationOptions): Disposable {
		return this.languages.registerWorkspaceSymbolProvider!({
			provideWorkspaceSymbols: this.createRequestHandler(WorkspaceSymbolRequest.type, () => [])
		});
	}

	private createCodeActionsProvider(options: TextDocumentRegistrationOptions): Disposable {
		return this.languages.registerCodeActionsProvider!(options.documentSelector!, {
			provideCodeActions: this.createRequestHandler(CodeActionRequest.type, () => [])
		});
	}

	private createCodeLensProvider(options: CodeLensRegistrationOptions): Disposable {
		return this.languages.registerCodeLensProvider!(options.documentSelector!, {
			provideCodeLenses: this.createRequestHandler(CodeLensRequest.type, () => []),
			resolveCodeLens: options.resolveProvider ? this.createRequestHandler(CodeLensResolveRequest.type, (params) => params) : undefined
		});
	}

	private createDocumentFormattingProvider(options: TextDocumentRegistrationOptions): Disposable {
		return this.languages.registerDocumentFormattingEditProvider!(options.documentSelector!, {
			provideDocumentFormattingEdits: this.createRequestHandler(DocumentFormattingRequest.type, () => [])
		});
	}

	private createDocumentRangeFormattingProvider(options: TextDocumentRegistrationOptions): Disposable {
		return this.languages.registerDocumentRangeFormattingEditProvider!(options.documentSelector!, {
			provideDocumentRangeFormattingEdits: this.createRequestHandler(DocumentRangeFormattingRequest.type, () => [])
		});
	}

	private createDocumentOnTypeFormattingProvider(options: DocumentOnTypeFormattingRegistrationOptions): Disposable {
		let moreTriggerCharacter = options.moreTriggerCharacter || [];
		return this.languages.registerOnTypeFormattingEditProvider!(options.documentSelector!, {
			provideOnTypeFormattingEdits: this.createRequestHandler(DocumentOnTypeFormattingRequest.type, () => [])
		}, options.firstTriggerCharacter, ...moreTriggerCharacter);
	}

	private createRenameProvider(options: TextDocumentRegistrationOptions): Disposable {
		return this.languages.registerRenameProvider!(options.documentSelector!, {
			provideRenameEdits: this.createRequestHandler(RenameRequest.type, (_, error) => new Error(error.message))
		});
	}

	private createDocumentLinkProvider(options: DocumentLinkRegistrationOptions): Disposable {
		return this.languages.registerDocumentLinkProvider!(options.documentSelector!, {
			provideDocumentLinks: this.createRequestHandler(DocumentLinkRequest.type, (_, error) => new Error(error.message)),
			resolveDocumentLink: options.resolveProvider ? this.createRequestHandler(DocumentLinkResolveRequest.type, (_, error) => new Error(error.message)) : undefined
		});
	}
}

export class SettingMonitor {

	private _listeners: Disposable[];

	constructor(private _client: BaseLanguageClient, private _setting: string) {
		this._listeners = [];
	}

	public start(): Disposable {
		if (this._client.workspace.configurations) {
			this._client.workspace.configurations.onDidChangeConfiguration(this.onDidChangeConfiguration, this, this._listeners);
			this.onDidChangeConfiguration();
		}
		return Disposable.create(() => {
			if (this._client.needsStop()) {
				this._client.stop();
			}
		});
	}

	private onDidChangeConfiguration(): void {
		const configurations = this._client.workspace.configurations!;
		let index = this._setting.indexOf('.');
		let primary = index >= 0 ? this._setting.substr(0, index) : this._setting;
		let rest = index >= 0 ? this._setting.substr(index + 1) : undefined;
		let enabled = rest ? configurations.getConfiguration(primary).get(rest, false) : configurations.getConfiguration(primary);
		if (enabled && this._client.needsStart()) {
			this._client.start();
		} else if (!enabled && this._client.needsStop()) {
			this._client.stop();
		}
	}
}
