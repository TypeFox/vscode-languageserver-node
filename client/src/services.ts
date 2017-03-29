/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import {
	DocumentSelector, FileEvent, MessageActionItem, MessageType
} from './protocol';

import {
	Disposable, CancellationToken, Event
} from 'vscode-jsonrpc';

import {
	Diagnostic, TextDocument, Position, CompletionItem, CompletionList,
	Hover, SignatureHelp, Definition, ReferenceContext, Location, DocumentHighlight,
	SymbolInformation, Range, CodeActionContext, Command, CodeLens, FormattingOptions,
    TextEdit, WorkspaceEdit, DocumentLink,  TextDocumentSaveReason, TextDocumentContentChangeEvent
} from 'vscode-languageserver-types';

export type ProviderResult<T> = T | undefined | null | Thenable<T | undefined | null>

export interface DiagnosticCollection extends Disposable {
	set(uri: string, diagnostics: Diagnostic[]): void;
}

export interface CompletionItemProvider {
	provideCompletionItems(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<CompletionItem[] | CompletionList>;
	resolveCompletionItem?(item: CompletionItem, token: CancellationToken): ProviderResult<CompletionItem>;
}

export interface HoverProvider {
	provideHover(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<Hover>;
}

export interface SignatureHelpProvider {
	provideSignatureHelp(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<SignatureHelp>;
}

export interface DefinitionProvider {
	provideDefinition(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<Definition>;
}

export interface ReferenceProvider {
	provideReferences(document: TextDocument, position: Position, context: ReferenceContext, token: CancellationToken): ProviderResult<Location[]>;
}

export interface DocumentHighlightProvider {
	provideDocumentHighlights(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<DocumentHighlight[]>;
}

export interface DocumentSymbolProvider {
	provideDocumentSymbols(document: TextDocument, token: CancellationToken): ProviderResult<SymbolInformation[]>;
}

export interface WorkspaceSymbolProvider {
	provideWorkspaceSymbols(query: string, token: CancellationToken): ProviderResult<SymbolInformation[]>;
}

export interface CodeActionProvider {
	provideCodeActions(document: TextDocument, range: Range, context: CodeActionContext, token: CancellationToken): ProviderResult<Command[]>;
}

export interface CodeLensProvider {
	provideCodeLenses(document: TextDocument, token: CancellationToken): ProviderResult<CodeLens[]>;
	resolveCodeLens?(codeLens: CodeLens, token: CancellationToken): ProviderResult<CodeLens>;
}

export interface DocumentFormattingEditProvider {
	provideDocumentFormattingEdits(document: TextDocument, options: FormattingOptions, token: CancellationToken): ProviderResult<TextEdit[]>;
}

export interface DocumentRangeFormattingEditProvider {
	provideDocumentRangeFormattingEdits(document: TextDocument, range: Range, options: FormattingOptions, token: CancellationToken): ProviderResult<TextEdit[]>;
}

export interface OnTypeFormattingEditProvider {
	provideOnTypeFormattingEdits(document: TextDocument, position: Position, ch: string, options: FormattingOptions, token: CancellationToken): ProviderResult<TextEdit[]>;
}

export interface RenameProvider {
	provideRenameEdits(document: TextDocument, position: Position, newName: string, token: CancellationToken): ProviderResult<WorkspaceEdit>;
}

export interface DocumentLinkProvider {
	provideDocumentLinks(document: TextDocument, token: CancellationToken): ProviderResult<DocumentLink[]>;
	resolveDocumentLink?(link: DocumentLink, token: CancellationToken): ProviderResult<DocumentLink>;
}

export interface Languages {
	match(selector: DocumentSelector, document: TextDocument): number;
    createDiagnosticCollection(name?: string): DiagnosticCollection;
	registerCompletionItemProvider(selector: DocumentSelector, provider: CompletionItemProvider, ...triggerCharacters: string[]): Disposable;
	registerHoverProvider(selector: DocumentSelector, provider: HoverProvider): Disposable;
	registerSignatureHelpProvider(selector: DocumentSelector, provider: SignatureHelpProvider, ...triggerCharacters: string[]): Disposable;
	registerDefinitionProvider(selector: DocumentSelector, provider: DefinitionProvider): Disposable;
	registerReferenceProvider(selector: DocumentSelector, provider: ReferenceProvider): Disposable;
	registerDocumentHighlightProvider(selector: DocumentSelector, provider: DocumentHighlightProvider): Disposable;
	registerDocumentSymbolProvider(selector: DocumentSelector, provider: DocumentSymbolProvider): Disposable;
	registerWorkspaceSymbolProvider(provider: WorkspaceSymbolProvider): Disposable;
	registerCodeActionsProvider(selector: DocumentSelector, provider: CodeActionProvider): Disposable;
	registerCodeLensProvider(selector: DocumentSelector, provider: CodeLensProvider): Disposable;
	registerDocumentFormattingEditProvider(selector: DocumentSelector, provider: DocumentFormattingEditProvider): Disposable;
	registerDocumentRangeFormattingEditProvider(selector: DocumentSelector, provider: DocumentRangeFormattingEditProvider): Disposable;
	registerOnTypeFormattingEditProvider(selector: DocumentSelector, provider: OnTypeFormattingEditProvider, firstTriggerCharacter: string, ...moreTriggerCharacter: string[]): Disposable;
	registerRenameProvider(selector: DocumentSelector, provider: RenameProvider): Disposable;
	registerDocumentLinkProvider(selector: DocumentSelector, provider: DocumentLinkProvider): Disposable;
}

export interface TextDocumentWillSaveEvent {
    readonly textDocument: TextDocument;
    readonly reason: TextDocumentSaveReason;
    waitUntil(thenable: Thenable<TextEdit[]>): void;
}

export interface TextDocumentChangeEvent {
    readonly textDocument: TextDocument;
    readonly contentChanges: TextDocumentContentChangeEvent[];
}

export interface WorkspaceConfiguration {
    get<T>(section: string, defaultValue?: T): T;
}

export interface FileSystemWatcher {
    readonly onFileEvent: Event<FileEvent>;
}

export interface Workspace {
    readonly rootPath?: string | null;
    readonly rootUri: string | null;
    readonly textDocuments: TextDocument[];
    applyEdit(edit: WorkspaceEdit): Thenable<boolean>;
    readonly onDidOpenTextDocument: Event<TextDocument>;
    readonly onDidCloseTextDocument: Event<TextDocument>;
    readonly onDidChangeTextDocument: Event<TextDocumentChangeEvent>;
    readonly onWillSaveTextDocument: Event<TextDocumentWillSaveEvent>;
    readonly onDidSaveTextDocument: Event<TextDocument>;
    getConfiguration(section?: string): WorkspaceConfiguration;
    readonly onDidChangeConfiguration: Event<void>;
}

export interface Commands {
    registerCommand(command: string, callback: (...args: any[]) => any, thisArg?: any): Disposable;
}

export interface OutputChannel {
	appendLine(line: string): void;
	show(preserveFocus?: boolean): void;
}

export interface Window {
    showMessage<T extends MessageActionItem>(type: MessageType, message: string, ...items: T[]): Thenable<T | undefined>;
	createOutputChannel(name: string): OutputChannel;
}