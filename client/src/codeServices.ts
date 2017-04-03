/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as services from './services';
import * as code from 'vscode';
import * as types from 'vscode-languageserver-types';
import * as proto from './protocol';
import { Converter as P2CConverter } from './protocolConverter';
import { Converter as C2PConverter } from './codeConverter';
import { Emitter, Disposable } from 'vscode-jsonrpc';

function asDocument(document: code.TextDocument): types.TextDocument {
    const uri = document.uri.toString();
    const { languageId, version } = document;
    const content = document.getText();
    return types.TextDocument.create(uri, languageId, version, content);
}

export function createWorkspace(c2p: C2PConverter): services.Workspace {
    const rootPath = code.workspace.rootPath ||  null;
    const rootUri = rootPath ? code.Uri.file(rootPath).toString() : null;

    const onDidOpenTextDocumentEmitter = new Emitter<types.TextDocument>();
    const onDidOpenTextDocument = onDidOpenTextDocumentEmitter.event;
    code.workspace.onDidOpenTextDocument(document => {
        onDidOpenTextDocumentEmitter.fire(asDocument(document));
    });

    const onDidCloseTextDocumentEmitter = new Emitter<types.TextDocument>();
    const onDidCloseTextDocument = onDidCloseTextDocumentEmitter.event;
    code.workspace.onDidCloseTextDocument(document => {
        onDidCloseTextDocumentEmitter.fire(asDocument(document));
    });

    const onDidChangeTextDocumentEmitter = new Emitter<proto.DidChangeTextDocumentParams>();
    const onDidChangeTextDocument = onDidChangeTextDocumentEmitter.event;
    code.workspace.onDidChangeTextDocument(event => {
        const params = c2p.asChangeTextDocumentParams(event);
        onDidChangeTextDocumentEmitter.fire(params);
    });

    return {
        /*capabilities: {
            applyEdit: true,
            workspaceEdit: {
                documentChanges: true
            }
        },
        synchronization: {
            didSave: true,
            willSave: true,
            willSaveWaitUntil: true
        },*/
        rootPath,
        rootUri,
        get textDocuments() {
            return code.workspace.textDocuments.map(asDocument);
        },
        onDidOpenTextDocument,
        onDidCloseTextDocument,
        onDidChangeTextDocument,
        /*
        configurations,
        onWillSaveTextDocument,
        onWillSaveTextDocumentWaitUntil,
        onDidSaveTextDocument,
        applyEdit
        */
    }
}

export function createLanguages(p2c: P2CConverter, c2p: C2PConverter): services.Languages {

    function match(selector: proto.DocumentSelector, document: { uri: string, languageId: string }): number {
        const uri = p2c.asUri(document.uri);
        const codeDocument = <code.TextDocument>{
            uri,
            fileName: uri.fsPath,
            languageId: document.languageId
        }
        return code.languages.match(selector, codeDocument);
    }

    function createDiagnosticCollection(name?: string): services.DiagnosticCollection {
        const collection = code.languages.createDiagnosticCollection(name);
        return {
            set: (uri, diagnostics) => {
                const codeUri = p2c.asUri(uri);
                const uriDiagnostics = p2c.asDiagnostics(diagnostics);
                collection.set(codeUri, uriDiagnostics);
            },
            dispose: () => collection.dispose()
        }
    }

    function registerCompletionItemProvider(selector: proto.DocumentSelector, provider: services.CompletionItemProvider, ...triggerCharacters: string[]): Disposable {
        return code.languages.registerCompletionItemProvider(selector, {
            provideCompletionItems: (codeDocument, codePosition, token) => {
                const params = c2p.asTextDocumentPositionParams(codeDocument, codePosition);
                return provider.provideCompletionItems(params, token).then(result => p2c.asCompletionResult(result));
            },
            resolveCompletionItem: provider.resolveCompletionItem ? (codeItem, token) => {
                const item = c2p.asCompletionItem(codeItem);
                return provider.resolveCompletionItem!(item, token).then(result => p2c.asCompletionItem(result));
            } : undefined
        }, ...triggerCharacters);
    }

    function registerHoverProvider(selector: proto.DocumentSelector, provider: services.HoverProvider): Disposable {
        return code.languages.registerHoverProvider(selector, {
            provideHover: (codeDocument, codePosition, token) => {
                const params = c2p.asTextDocumentPositionParams(codeDocument, codePosition);
                return provider.provideHover(params, token).then(result => p2c.asHover(result));
            }
        });
    }

    return {
        completion: {
            completionItem: {
                snippetSupport: true
            }
        },
        match,
        createDiagnosticCollection,
        registerCompletionItemProvider,
        registerHoverProvider,
        /*
        registerSignatureHelpProvider,
        registerDefinitionProvider,
        registerReferenceProvider,
        registerDocumentHighlightProvider,
        registerDocumentSymbolProvider,
        registerWorkspaceSymbolProvider,
        registerCodeActionsProvider,
        registerCodeLensProvider,
        registerDocumentFormattingEditProvider,
        registerDocumentRangeFormattingEditProvider,
        registerOnTypeFormattingEditProvider,
        registerRenameProvider,
        registerDocumentLinkProvider
        */
    }
}

// Commands
export function createCommands(): services.Commands {
    function registerCommand(command: string, callback: (...args: any[]) => any, thisArg?: any): Disposable {
        return code.commands.registerCommand(command, callback, thisArg);
    }
    return {
        registerCommand
    }
}

// Window
export function createWindow(): services.Window {
    function showMessage<T extends proto.MessageActionItem>(type: proto.MessageType, message: string, ...actions: T[]): Thenable<T | undefined> {
        let messageFunc: <T>(message: string, ...items: T[]) => Thenable<T>;
        switch (type) {
            case proto.MessageType.Error:
                messageFunc = code.window.showErrorMessage;
                break;
            case proto.MessageType.Warning:
                messageFunc = code.window.showWarningMessage;
                break;
            case proto.MessageType.Info:
                messageFunc = code.window.showInformationMessage;
                break;
            default:
                messageFunc = code.window.showInformationMessage;
        }
        return messageFunc(message, ...actions);
    }

    function createOutputChannel(name: string): services.OutputChannel {
        return code.window.createOutputChannel(name);
    }
    return {
        showMessage,
        createOutputChannel
    }
}