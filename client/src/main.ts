/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as cp from 'child_process';
import ChildProcess = cp.ChildProcess;

import {
	BaseLanguageClient, IConnection, 
	LanguageClientOptions as BaseLanguageClientOptions,
	InitializeError
} from './base';

import {
	Languages, Workspace, Commands, Window
} from './services';

import {
	createLanguages, createWorkspace, createCommands, createWindow
} from './codeServices';

import {
	Logger, createMessageConnection, ErrorCodes, ResponseError,
	RequestType, RequestType0, RequestHandler, RequestHandler0, GenericRequestHandler,
	NotificationType, NotificationType0,
	NotificationHandler, NotificationHandler0, GenericNotificationHandler,
	MessageReader, IPCMessageReader, MessageWriter, IPCMessageWriter,
	createClientPipeTransport, generateRandomPipeName, MessageConnection
} from 'vscode-jsonrpc';

import * as c2p from './codeConverter';
import * as p2c from './protocolConverter';

import * as is from './utils/is';
import * as electron from './utils/electron';
import { terminate } from './utils/processes';

export {
	ResponseError, InitializeError, ErrorCodes,
	RequestType, RequestType0, RequestHandler, RequestHandler0, GenericRequestHandler,
	NotificationType, NotificationType0, NotificationHandler, NotificationHandler0, GenericNotificationHandler
}
export { Converter as Code2ProtocolConverter } from './codeConverter';
export { Converter as Protocol2CodeConverter } from './protocolConverter';

export * from 'vscode-languageserver-types';
export * from './protocol';

declare var v8debug: any;

class ConsoleLogger implements Logger {
	public error(message: string): void {
		console.error(message);
	}
	public warn(message: string): void {
		console.warn(message);
	}
	public info(message: string): void {
		console.info(message);
	}
	public log(message: string): void {
		console.log(message);
	}
}

function createConnection(inputStream: NodeJS.ReadableStream, outputStream: NodeJS.WritableStream): MessageConnection;
function createConnection(reader: MessageReader, writer: MessageWriter): MessageConnection;
function createConnection(input: any, output: any): MessageConnection {
	let logger = new ConsoleLogger();
	return createMessageConnection(input, output, logger);
}

export interface StreamInfo {
	writer: NodeJS.WritableStream;
	reader: NodeJS.ReadableStream;
}

export interface ExecutableOptions {
	cwd?: string;
	stdio?: string | string[];
	env?: any;
	detached?: boolean;
}

export interface Executable {
	command: string;
	args?: string[];
	options?: ExecutableOptions;
}

export interface ForkOptions {
	cwd?: string;
	env?: any;
	encoding?: string;
	execArgv?: string[];
}

export enum TransportKind {
	stdio,
	ipc,
	pipe
}

export interface NodeModule {
	module: string;
	transport?: TransportKind;
	args?: string[];
	runtime?: string;
	options?: ForkOptions;
}

export type ServerOptions = Executable | { run: Executable; debug: Executable; } | { run: NodeModule; debug: NodeModule } | NodeModule | (() => Thenable<ChildProcess | StreamInfo>);

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
function getClientOptions(arg2: ServerOptions | string, arg3: LanguageClientOptions | ServerOptions, arg4?: boolean | LanguageClientOptions) {
	return (is.string(arg2) ? arg4 : arg3) as LanguageClientOptions;
}

export class LanguageClient extends BaseLanguageClient {

	private _serverOptions: ServerOptions;
	private _forceDebug: boolean;
	private _encoding: string;

	private _childProcess: ChildProcess | undefined;
	private _c2p: c2p.Converter;
	private _p2c: p2c.Converter;

	readonly languages: Languages;
	readonly workspace: Workspace;
	readonly commands: Commands;
	readonly window: Window;

	public constructor(name: string, serverOptions: ServerOptions, clientOptions: LanguageClientOptions, forceDebug?: boolean);
	public constructor(id: string, name: string, serverOptions: ServerOptions, clientOptions: LanguageClientOptions, forceDebug?: boolean);
	public constructor(arg1: string, arg2: ServerOptions | string, arg3: LanguageClientOptions | ServerOptions, arg4?: boolean | LanguageClientOptions, arg5?: boolean) {
		super(getId(arg1, arg2), getName(arg1, arg2), getClientOptions(arg2, arg3, arg4));
		let clientOptions: LanguageClientOptions;
		let forceDebug: boolean;
		if (is.string(arg2)) {
			this._serverOptions = arg3 as ServerOptions;
			clientOptions = arg4 as LanguageClientOptions;
			forceDebug = !!arg5;
		} else {
			this._serverOptions = arg2 as ServerOptions;
			clientOptions = arg3 as LanguageClientOptions;
			forceDebug = arg4 as boolean;
		}
		if (forceDebug === void 0) { forceDebug = false; }

		clientOptions = clientOptions || {};
		this._encoding = clientOptions.stdioEncoding || 'utf8';
		this._forceDebug = forceDebug;

		this._childProcess = undefined;
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

	protected createRPCConnection(): Thenable<MessageConnection> {
		function getEnvironment(env: any): any {
			if (!env) {
				return process.env;
			}
			let result: any = Object.create(null);
			Object.keys(process.env).forEach(key => result[key] = process.env[key]);
			Object.keys(env).forEach(key => result[key] = env[key]);
		}

		function startedInDebugMode(): boolean {
			let args: string[] = (process as any).execArgv;
			if (args) {
				return args.some((arg) => /^--debug=?/.test(arg) || /^--debug-brk=?/.test(arg));
			};
			return false;
		}

		let encoding = this._encoding;

		let server = this._serverOptions;
		// We got a function.
		if (is.func(server)) {
			return server().then((result) => {
				let info = result as StreamInfo;
				if (info.writer && info.reader) {
					return createConnection(info.reader, info.writer);
				} else {
					let cp = result as ChildProcess;
					return createConnection(cp.stdout, cp.stdin);
				}
			});
		}
		let json: { command?: string; module?: string };
		let runDebug = <{ run: any; debug: any; }>server;
		if (runDebug.run || runDebug.debug) {
			// We are under debugging. So use debug as well.
			if (typeof v8debug === 'object' || this._forceDebug || startedInDebugMode()) {
				json = runDebug.debug;
			} else {
				json = runDebug.run;
			}
		} else {
			json = server;
		}
		if (json.module) {
			let node: NodeModule = <NodeModule>json;
			let transport = node.transport || TransportKind.stdio;
			if (node.runtime) {
				let args: string[] = [];
				let options: ForkOptions = node.options || Object.create(null);
				if (options.execArgv) {
					options.execArgv.forEach(element => args.push(element));
				}
				args.push(node.module);
				if (node.args) {
					node.args.forEach(element => args.push(element));
				}
				let execOptions: ExecutableOptions = Object.create(null);
				execOptions.cwd = options.cwd || Workspace.getRootPath(this.workspace);
				execOptions.env = getEnvironment(options.env);
				let pipeName: string | undefined = undefined;
				if (transport === TransportKind.ipc) {
					// exec options not correctly typed in lib
					execOptions.stdio = <any>[null, null, null, 'ipc'];
					args.push('--node-ipc');
				} else if (transport === TransportKind.stdio) {
					args.push('--stdio');
				} else if (transport === TransportKind.pipe) {
					pipeName = generateRandomPipeName();
					args.push(`--pipe=${pipeName}`);
				}
				if (transport === TransportKind.ipc || transport === TransportKind.stdio) {
					let process = cp.spawn(node.runtime, args, execOptions);
					if (!process || !process.pid) {
						return Promise.reject<MessageConnection>(`Launching server using runtime ${node.runtime} failed.`);
					}
					this._childProcess = process;
					process.stderr.on('data', data => this.outputChannel!.append(is.string(data) ? data : data.toString(encoding)));
					if (transport === TransportKind.ipc) {
						process.stdout.on('data', data => this.outputChannel!.append(is.string(data) ? data : data.toString(encoding)));
						return Promise.resolve(createConnection(new IPCMessageReader(process), new IPCMessageWriter(process)));
					} else {
						return Promise.resolve(createConnection(process.stdout, process.stdin));
					}
				} else if (transport == TransportKind.pipe) {
					return createClientPipeTransport(pipeName!).then((transport) => {
						let process = cp.spawn(node.runtime!, args, execOptions);
						if (!process || !process.pid) {
							return Promise.reject<MessageConnection>(`Launching server using runtime ${node.runtime} failed.`);
						}
						this._childProcess = process;
						process.stderr.on('data', data => this.outputChannel!.append(is.string(data) ? data : data.toString(encoding)));
						process.stdout.on('data', data => this.outputChannel!.append(is.string(data) ? data : data.toString(encoding)));
						return transport.onConnected().then((protocol) => {
							return createConnection(protocol[0], protocol[1]);
						});
					})
				}
			} else {
				let pipeName: string | undefined = undefined;
				return new Promise<MessageConnection>((resolve, reject) => {
					let args = node.args && node.args.slice() || [];
					if (transport === TransportKind.ipc) {
						args.push('--node-ipc');
					} else if (transport === TransportKind.stdio) {
						args.push('--stdio');
					} else if (transport === TransportKind.pipe) {
						pipeName = generateRandomPipeName();
						args.push(`--pipe=${pipeName}`);
					}
					let options: ForkOptions = node.options || Object.create(null);
					options.execArgv = options.execArgv || [];
					options.cwd = options.cwd || Workspace.getRootPath(this.workspace);
					if (transport === TransportKind.ipc || transport === TransportKind.stdio) {
						electron.fork(node.module, args || [], options, (error, cp) => {
							if (error || !cp) {
								reject(error);
							} else {
								this._childProcess = cp;
								cp.stderr.on('data', data => this.outputChannel!.append(is.string(data) ? data : data.toString(encoding)));
								if (transport === TransportKind.ipc) {
									cp.stdout.on('data', data => this.outputChannel!.append(is.string(data) ? data : data.toString(encoding)));
									resolve(createConnection(new IPCMessageReader(this._childProcess), new IPCMessageWriter(this._childProcess)));
								} else {
									resolve(createConnection(cp.stdout, cp.stdin));
								}
							}
						});
					}  else if (transport === TransportKind.pipe) {
						createClientPipeTransport(pipeName!).then((transport) => {
							electron.fork(node.module, args || [], options, (error, cp) => {
								if (error || !cp) {
									reject(error);
								} else {
									this._childProcess = cp;
									cp.stderr.on('data', data => this.outputChannel!.append(is.string(data) ? data : data.toString(encoding)));
									cp.stdout.on('data', data => this.outputChannel!.append(is.string(data) ? data : data.toString(encoding)));
									transport.onConnected().then((protocol) => {
										resolve(createConnection(protocol[0], protocol[1]));
									});
								}
							});
						});
					}
				});
			}
		} else if (json.command) {
			let command: Executable = <Executable>json;
			let options = command.options || {};
			options.cwd = options.cwd || Workspace.getRootPath(this.workspace);
			let process = cp.spawn(command.command, command.args, command.options);
			if (!process || !process.pid) {
				return Promise.reject<MessageConnection>(`Launching server using command ${command.command} failed.`);
			}
			process.stderr.on('data', data => this.outputChannel!.append(is.string(data) ? data : data.toString(encoding)));
			this._childProcess = process;
			return Promise.resolve(createConnection(process.stdout, process.stdin));
		}
		return Promise.reject<MessageConnection>(new Error(`Unsupported server configuartion ` + JSON.stringify(server, null, 4)));
	}

	protected doHandleConnectionClosed(): void {
		this._childProcess = undefined;
		super.doHandleConnectionClosed();
	}

	protected handleConnectionShutdown(connection: IConnection): void {
		super.handleConnectionShutdown(connection);
		let toCheck = this._childProcess;
		this._childProcess = undefined;
		// Remove all markers
		this.checkProcessDied(toCheck);
	}

	private checkProcessDied(childProcess: ChildProcess | undefined): void {
		if (!childProcess) {
			return;
		}
		setTimeout(() => {
			// Test if the process is still alive. Throws an exception if not
			try {
				process.kill(childProcess.pid, <any>0);
				terminate(childProcess);
			} catch (error) {
				// All is fine.
			}
		}, 2000);
	}
}
