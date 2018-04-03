/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import {
	BaseLanguageClient, BaseLanguageClientOptions
} from './base';
import { NodeConnectionProvider, ServerOptions } from './nodeConnection';

import {
	createLanguages, createWorkspace, createCommands, createWindow
} from './codeServices';

import * as is from './utils/is';

import * as c2p from './codeConverter';
import * as p2c from './protocolConverter';

export { Converter as Code2ProtocolConverter } from './codeConverter';
export { Converter as Protocol2CodeConverter } from './protocolConverter';

export * from 'vscode-languageserver-types';

export { ServerOptions } from './nodeConnection';

export interface LanguageClientOptions extends BaseLanguageClientOptions {
	/**
	 * The encoding use to read stdout and stderr. Defaults
	 * to 'utf8' if ommitted.
	 */
	stdioEncoding?: string;
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
function getServices(clientOptions: LanguageClientOptions): BaseLanguageClient.IServices {
	const _c2p = c2p.createConverter(clientOptions.uriConverters ? clientOptions.uriConverters.code2Protocol : undefined);
	const _p2c = p2c.createConverter(clientOptions.uriConverters ? clientOptions.uriConverters.protocol2Code : undefined);
	return {
		languages: createLanguages(_p2c, _c2p),
		workspace: createWorkspace(_c2p),
		commands: createCommands(),
		window: createWindow()
	}
} 
function createOptions(arg1: string, arg2: ServerOptions | string, arg3: LanguageClientOptions | ServerOptions, arg4?: boolean | LanguageClientOptions, arg5?: boolean): BaseLanguageClient.IOptions {
	const id = getId(arg1, arg2);
	const name = getName(arg1, arg2);
	const serverOptions = getServerOptions(arg2, arg3);
	const clientOptions = getClientOptions(arg2, arg3, arg4);
	const services = getServices(clientOptions);
	const forceDebug = getForceDebug(arg2, arg4, arg5);
	const stdioEncoding = clientOptions.stdioEncoding;
	const workspace = services.workspace;
	const connectionProvider = new NodeConnectionProvider({serverOptions, forceDebug, stdioEncoding, workspace});
	return { id, name, clientOptions, services, connectionProvider };
}

export class LanguageClient extends BaseLanguageClient {

	private _c2p: c2p.Converter;
	private _p2c: p2c.Converter;

	public constructor(name: string, serverOptions: ServerOptions, clientOptions: LanguageClientOptions, forceDebug?: boolean);
	public constructor(id: string, name: string, serverOptions: ServerOptions, clientOptions: LanguageClientOptions, forceDebug?: boolean);
	public constructor(arg1: string, arg2: ServerOptions | string, arg3: LanguageClientOptions | ServerOptions, arg4?: boolean | LanguageClientOptions, arg5?: boolean) {
		super(createOptions(arg1, arg2, arg3, arg4, arg5));
		const clientOptions = getClientOptions(arg2, arg3, arg4) || {};
		this._c2p = c2p.createConverter(clientOptions.uriConverters ? clientOptions.uriConverters.code2Protocol : undefined);
		this._p2c = p2c.createConverter(clientOptions.uriConverters ? clientOptions.uriConverters.protocol2Code : undefined);
	}

	public get protocol2CodeConverter(): p2c.Converter {
		return this._p2c;
	}

	public get code2ProtocolConverter(): c2p.Converter {
		return this._c2p;
	}

}
