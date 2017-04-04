/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import {
	NodeLanguageClient, NodeLanguageClientOptions, ServerOptions
} from './node';

import {
	Languages, Workspace, Commands, Window
} from './services';

import {
	createLanguages, createWorkspace, createCommands, createWindow
} from './codeServices';

import * as is from './utils/is';

import * as c2p from './codeConverter';
import * as p2c from './protocolConverter';
export { Converter as Code2ProtocolConverter } from './codeConverter';
export { Converter as Protocol2CodeConverter } from './protocolConverter';

export * from 'vscode-languageserver-types';
export * from './node';

export interface LanguageClientOptions extends NodeLanguageClientOptions {
	uriConverters?: {
		code2Protocol: c2p.URIConverter,
		protocol2Code: p2c.URIConverter
	};
}

function getId(arg1: string, arg2: ServerOptions | string) {
	return is.string(arg2) ? arg1 : arg1.toLowerCase();
}
function getName(arg1: string, arg2: ServerOptions | string) {
	return is.string(arg2) ? arg2 : arg1;
}
function getServerOptions(arg2: ServerOptions | string, arg3: LanguageClientOptions | ServerOptions) {
	return (is.string(arg2) ? arg3 : arg2) as ServerOptions;
}
function getClientOptions(arg2: ServerOptions | string, arg3: LanguageClientOptions | ServerOptions, arg4?: boolean | LanguageClientOptions) {
	return (is.string(arg2) ? arg4 : arg3) as LanguageClientOptions;
}
function getForceDebug(arg2: ServerOptions | string, arg4?: boolean | LanguageClientOptions, arg5?: boolean) {
	return (is.string(arg2) ? !!arg5 : arg4 as boolean);
}

export class LanguageClient extends NodeLanguageClient {

	private _c2p: c2p.Converter;
	private _p2c: p2c.Converter;

	readonly languages: Languages;
	readonly workspace: Workspace;
	readonly commands: Commands;
	readonly window: Window;

	public constructor(name: string, serverOptions: ServerOptions, clientOptions: LanguageClientOptions, forceDebug?: boolean);
	public constructor(id: string, name: string, serverOptions: ServerOptions, clientOptions: LanguageClientOptions, forceDebug?: boolean);
	public constructor(arg1: string, arg2: ServerOptions | string, arg3: LanguageClientOptions | ServerOptions, arg4?: boolean | LanguageClientOptions, arg5?: boolean) {
		super(getId(arg1, arg2), getName(arg1, arg2), getServerOptions(arg2, arg3), getClientOptions(arg2, arg3, arg4), getForceDebug(arg2, arg4, arg5));
		const clientOptions = getClientOptions(arg2, arg3, arg4) || {};
		this._c2p = c2p.createConverter(clientOptions.uriConverters ? clientOptions.uriConverters.code2Protocol : undefined);
		this._p2c = p2c.createConverter(clientOptions.uriConverters ? clientOptions.uriConverters.protocol2Code : undefined);
		this.languages = createLanguages(this._p2c, this._c2p);
		this.workspace = createWorkspace(this._c2p);
		this.commands = createCommands();
		this.window = createWindow();
	}

	public get protocol2CodeConverter(): p2c.Converter {
		return this._p2c;
	}

	public get code2ProtocolConverter(): c2p.Converter {
		return this._c2p;
	}

}
