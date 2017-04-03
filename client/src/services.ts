/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import {
	DocumentSelector, FileEvent, MessageActionItem, MessageType,
	TextDocumentPositionParams, ReferenceParams, CodeActionParams, CodeLensParams, DocumentFormattingParams,
	DocumentRangeFormattingParams, DocumentOnTypeFormattingParams, RenameParams, DocumentLinkParams,
	WorkspaceClientCapabilites, SynchronizationClientCapabilities, CompletionClientCapabilities
} from './protocol';

import {
	Disposable, CancellationToken, Event
} from 'vscode-jsonrpc';

import {
	Diagnostic, TextDocument, CompletionItem, CompletionList,
	Hover, SignatureHelp, Definition, Location, DocumentHighlight,
	SymbolInformation, Command, CodeLens, TextEdit, WorkspaceEdit,
	DocumentLink, TextDocumentSaveReason, DocumentSymbolParams,
	WorkspaceSymbolParams, TextDocumentContentChangeEvent
} from 'vscode-languageserver-types';

import Uri from 'vscode-uri';

export interface DiagnosticCollection extends Disposable {
	set(uri: string, diagnostics: Diagnostic[]): void;
}

export interface CompletionItemProvider {
	provideCompletionItems(params: TextDocumentPositionParams, token: CancellationToken): Thenable<CompletionItem[] | CompletionList>;
	resolveCompletionItem?(item: CompletionItem, token: CancellationToken): Thenable<CompletionItem>;
}

export interface HoverProvider {
	provideHover(params: TextDocumentPositionParams, token: CancellationToken): Thenable<Hover>;
}

export interface SignatureHelpProvider {
	provideSignatureHelp(params: TextDocumentPositionParams, token: CancellationToken): Thenable<SignatureHelp>;
}

export interface DefinitionProvider {
	provideDefinition(params: TextDocumentPositionParams, token: CancellationToken): Thenable<Definition>;
}

export interface ReferenceProvider {
	provideReferences(params: ReferenceParams, token: CancellationToken): Thenable<Location[]>;
}

export interface DocumentHighlightProvider {
	provideDocumentHighlights(params: TextDocumentPositionParams, token: CancellationToken): Thenable<DocumentHighlight[]>;
}

export interface DocumentSymbolProvider {
	provideDocumentSymbols(params: DocumentSymbolParams, token: CancellationToken): Thenable<SymbolInformation[]>;
}

export interface WorkspaceSymbolProvider {
	provideWorkspaceSymbols(params: WorkspaceSymbolParams, token: CancellationToken): Thenable<SymbolInformation[]>;
}

export interface CodeActionProvider {
	provideCodeActions(params: CodeActionParams, token: CancellationToken): Thenable<Command[]>;
}

export interface CodeLensProvider {
	provideCodeLenses(params: CodeLensParams, token: CancellationToken): Thenable<CodeLens[]>;
	resolveCodeLens?(codeLens: CodeLens, token: CancellationToken): Thenable<CodeLens>;
}

export interface DocumentFormattingEditProvider {
	provideDocumentFormattingEdits(params: DocumentFormattingParams, token: CancellationToken): Thenable<TextEdit[]>;
}

export interface DocumentRangeFormattingEditProvider {
	provideDocumentRangeFormattingEdits(params: DocumentRangeFormattingParams, token: CancellationToken): Thenable<TextEdit[]>;
}

export interface OnTypeFormattingEditProvider {
	provideOnTypeFormattingEdits(params: DocumentOnTypeFormattingParams, token: CancellationToken): Thenable<TextEdit[]>;
}

export interface RenameProvider {
	provideRenameEdits(params: RenameParams, token: CancellationToken): Thenable<WorkspaceEdit>;
}

export interface DocumentLinkProvider {
	provideDocumentLinks(params: DocumentLinkParams, token: CancellationToken): Thenable<DocumentLink[]>;
	resolveDocumentLink?(link: DocumentLink, token: CancellationToken): Thenable<DocumentLink>;
}

export interface Languages {
	readonly completion?: CompletionClientCapabilities;
	match(selector: DocumentSelector, document: {uri: string, languageId: string}): number;
    createDiagnosticCollection?(name?: string): DiagnosticCollection;
	registerCompletionItemProvider?(selector: DocumentSelector, provider: CompletionItemProvider, ...triggerCharacters: string[]): Disposable;
	registerHoverProvider?(selector: DocumentSelector, provider: HoverProvider): Disposable;
	registerSignatureHelpProvider?(selector: DocumentSelector, provider: SignatureHelpProvider, ...triggerCharacters: string[]): Disposable;
	registerDefinitionProvider?(selector: DocumentSelector, provider: DefinitionProvider): Disposable;
	registerReferenceProvider?(selector: DocumentSelector, provider: ReferenceProvider): Disposable;
	registerDocumentHighlightProvider?(selector: DocumentSelector, provider: DocumentHighlightProvider): Disposable;
	registerDocumentSymbolProvider?(selector: DocumentSelector, provider: DocumentSymbolProvider): Disposable;
	registerWorkspaceSymbolProvider?(provider: WorkspaceSymbolProvider): Disposable;
	registerCodeActionsProvider?(selector: DocumentSelector, provider: CodeActionProvider): Disposable;
	registerCodeLensProvider?(selector: DocumentSelector, provider: CodeLensProvider): Disposable;
	registerDocumentFormattingEditProvider?(selector: DocumentSelector, provider: DocumentFormattingEditProvider): Disposable;
	registerDocumentRangeFormattingEditProvider?(selector: DocumentSelector, provider: DocumentRangeFormattingEditProvider): Disposable;
	registerOnTypeFormattingEditProvider?(selector: DocumentSelector, provider: OnTypeFormattingEditProvider, firstTriggerCharacter: string, ...moreTriggerCharacter: string[]): Disposable;
	registerRenameProvider?(selector: DocumentSelector, provider: RenameProvider): Disposable;
	registerDocumentLinkProvider?(selector: DocumentSelector, provider: DocumentLinkProvider): Disposable;
}

export interface TextDocumentDidChangeEvent {
	readonly textDocument: TextDocument;
	readonly contentChanges: TextDocumentContentChangeEvent[];
}

export interface TextDocumentWillSaveEvent {
    readonly textDocument: TextDocument;
    readonly reason: TextDocumentSaveReason;
    waitUntil?(thenable: Thenable<TextEdit[]>): void;
}

export interface WorkspaceConfiguration {
    get<T>(section: string, defaultValue?: T): T;
}

export interface FileSystemWatcher {
    readonly onFileEvent: Event<FileEvent>;
}

export interface Configurations {
	getConfiguration(section?: string): WorkspaceConfiguration;
    readonly onDidChangeConfiguration: Event<void>;
}

export interface Workspace {
	readonly capabilities?: WorkspaceClientCapabilites;
	readonly synchronization?: SynchronizationClientCapabilities;
    readonly rootPath?: string | null;
    readonly rootUri: string | null;
    readonly textDocuments: TextDocument[];
	readonly onDidOpenTextDocument: Event<TextDocument>;
    readonly onDidCloseTextDocument: Event<TextDocument>;
    readonly onDidChangeTextDocument: Event<TextDocumentDidChangeEvent>;
    readonly configurations?: Configurations;
    readonly onWillSaveTextDocument?: Event<TextDocumentWillSaveEvent>;
    readonly onDidSaveTextDocument?: Event<TextDocument>;
	applyEdit?(changes: WorkspaceEdit): Thenable<boolean>;
}

export namespace Workspace {
	export function getRootPath(workspace: Workspace): string | undefined {
		if (workspace.rootPath) {
			return workspace.rootPath;
		}
		 if (workspace.rootUri) {
			return Uri.parse(workspace.rootUri).fsPath;
		}
		return undefined;
	}
}

export interface Commands {
    registerCommand(command: string, callback: (...args: any[]) => any, thisArg?: any): Disposable;
}

export interface OutputChannel {
	append(value: string): void;
	appendLine(line: string): void;
	show(preserveFocus?: boolean): void;
}

export interface Window {
    showMessage<T extends MessageActionItem>(type: MessageType, message: string, ...actions: T[]): Thenable<T | undefined>;
	createOutputChannel?(name: string): OutputChannel;
}