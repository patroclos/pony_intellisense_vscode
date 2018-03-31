/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import {
	IPCMessageReader, IPCMessageWriter, createConnection, IConnection, TextDocuments, /*TextDocument,
	Diagnostic, DiagnosticSeverity,*/ InitializeResult, TextDocumentPositionParams, CompletionItem,
	CompletionItemKind
} from 'vscode-languageserver'


import { dirname, resolve } from 'path';
import { spawnSync } from 'child_process';
import * as ScopeProto from './scope.pb';

// Create a connection for the server. The connection uses Node's IPC as a transport
let connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));

// Create a simple text document manager. The text document manager
// supports full document sync only
let documents: TextDocuments = new TextDocuments();
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// After the server has started the client sends an initialize request. The server receives
// in the passed params the rootPath of the workspace plus the client capabilities.
connection.onInitialize((_params): InitializeResult => {
	var rv = {
		capabilities: {
			// Tell the client that the server works in FULL text document sync mode
			textDocumentSync: documents.syncKind,
			// Tell the client that the server support code complete
			completionProvider: {
				resolveProvider: true,
				triggerCharacters: ['.', '.>', '~']
			},
			definitionProvider: true
		}
	}

	return rv;
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
/*
documents.onDidChangeContent((change) => {
	validateTextDocument(change.document);
});
*/

// The settings interface describe the server relevant settings part
interface Settings {
	ponyLang: PonyLangSettings;
}

interface PonyLangSettings {
	ponyIntellisensePath: string;
	/** @description path to pony packages */
	ponyPath: string;
}


let ponyIntellisensePath: string;
let ponyPath: string;

// The settings have changed. Is send on server activation
// as well.
connection.onDidChangeConfiguration((change) => {
	let settings = <Settings>change.settings;
	ponyIntellisensePath = settings.ponyLang.ponyIntellisensePath || '/usr/local/bin/pony_intellisense_cli';
	ponyPath = settings.ponyLang.ponyPath || process.env['PONYPATH'] || '/usr/share/pony/packages';

	// Revalidate any open text documents
	//documents.all().forEach(validateTextDocument);
});

/*
function validateTextDocument(textDocument: TextDocument): void {
	let diagnostics: Diagnostic[] = [];
	let lines = textDocument.getText().split(/\r?\n/g);
	let problems = 0;
	for (var i = 0; i < lines.length && problems < maxNumberOfProblems; i++) {
		let line = lines[i];
		let index = line.indexOf('typescript');
		if (index >= 0) {
			problems++;
			diagnostics.push({
				severity: DiagnosticSeverity.Warning,
				range: {
					start: { line: i, character: index },
					end: { line: i, character: index + 10 }
				},
				message: `${line.substr(index, 10)} should be spelled TypeScript`,
				source: 'ex'
			});
		}
	}
	// Send the computed diagnostics to VSCode.
	connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}
*/

/*
connection.onDidChangeWatchedFiles((_change) => {
	// Monitored files have change in VSCode
	connection.console.log('We received an file change event');
});
*/


let completionItemKindMap: { [index: string]: CompletionItemKind } = {
	'actor': CompletionItemKind.Class,
	'class': CompletionItemKind.Class,
	'interface': CompletionItemKind.Interface,
	'trait': CompletionItemKind.Interface,
	'struct': CompletionItemKind.Class,
	'type': CompletionItemKind.Interface,
	'primitive': CompletionItemKind.Class,
	'param': CompletionItemKind.Variable,
	'new': CompletionItemKind.Constructor,
	'flet': CompletionItemKind.Field,
	'fvar': CompletionItemKind.Field,
	'let': CompletionItemKind.Variable,
	'var': CompletionItemKind.Variable,
	'fun': CompletionItemKind.Function,
	'be': CompletionItemKind.Method
}

connection.onCompletion((pos: TextDocumentPositionParams): CompletionItem[] => {
	if (!pos.textDocument.uri.startsWith('file://'))
		throw new Error('Unexpected document scheme in uri: ' + pos.textDocument.uri);

	const module_path = dirname(pos.textDocument.uri.slice(7));

	const env_args = {
		PONYPATH: ponyPath
	};

	const args = [
		'--path', module_path,
		'--file', resolve(pos.textDocument.uri.slice(7)),
		'--stdin',
		'dump-scope',
		'--line', (pos.position.line + 1).toString(),
		'--pos', pos.position.character.toString()
	]

	let input = documents.get(pos.textDocument.uri).getText()
	let analyser = spawnSync(ponyIntellisensePath, args, {
		env: env_args,
		input,
		stdio: ['pipe', 'pipe', 'inherit']
	})

	try {
		let decoded = ScopeProto.Scope.decode(analyser.stdout)

		return decoded.symbols.map((symbol): CompletionItem => {
			let detail = `${ScopeProto.SymbolKind[symbol.kind]} ${symbol.name}`

			if (symbol.parameters.length > 0) {
				let params = symbol.parameters.map(p => `${p.name}: ${p.type == null ? "*unknown*" : p.type.name}`);
				detail += `(${params.join(', ')})`;
			}
			if (symbol.type !== null)
				detail += ` => ${symbol.type.name}`

			detail += ' ' + ScopeProto.RefCap[symbol.cap];

			return {
				label: symbol.name,
				kind: completionItemKindMap[ScopeProto.SymbolKind[symbol.kind]],
				documentation: symbol.docstring,

				detail
			}
		});
	} catch (err) {
		console.error(err);
		return [];
	}

});

connection.onDefinition(textdoc_position => {
	const module_path = dirname(textdoc_position.textDocument.uri.slice(7));
	const pos = textdoc_position.position;

	const env_args = {
		PONYPATH: '/home/j.jensch/ponyc/packages'
	};

	const args = [
		'--path', module_path,
		'--file', textdoc_position.textDocument.uri.slice(7),
		'--stdin',
		'get-symbol',
		'--line', (pos.line + 1).toString(),
		'--pos', (pos.character + 1).toString()
	]

	let input = documents.get(textdoc_position.textDocument.uri).getText()
	let proc = spawnSync(ponyIntellisensePath, args, {
		env: env_args,
		input,
		stdio: ['pipe', 'pipe', 'inherit']
	});

	try {
		let resolved = ScopeProto.Symbol.decode(proc.stdout);
		if (resolved.definitionLocation == null)
			return null;
		let loc = resolved.definitionLocation;
		let indexed = { line: loc.line - 1, col: loc.column - 1 }
		let rv = {
			uri: `file://${loc.file}`,
			range: {
				start: {
					line: indexed.line,
					character: indexed.col
				},
				end: {
					line: indexed.line,
					character: indexed.col + resolved.name.length
				}
			}
		};
		return rv;
	} catch (err) {
		console.error(err);
	}

	return null;
});

// This handler resolve additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
	/*
	if (item.data === 1) {
		item.detail = 'TypeScript details',
			item.documentation = 'TypeScript documentation'
	} else if (item.data === 2) {
		item.detail = 'JavaScript details',
			item.documentation = 'JavaScript documentation'
	}
	*/
	return item;
});

/*
connection.onDidOpenTextDocument((params) => {
	// A text document got opened in VSCode.
	// params.uri uniquely identifies the document. For documents store on disk this is a file URI.
	// params.text the initial full content of the document.
	connection.console.log(`${params.textDocument.uri} opened.`);
});
connection.onDidChangeTextDocument((params) => {
	// The content of a text document did change in VSCode.
	// params.uri uniquely identifies the document.
	// params.contentChanges describe the content changes to the document.
	connection.console.log(`${params.textDocument.uri} changed: ${JSON.stringify(params.contentChanges)}`);
});
connection.onDidCloseTextDocument((params) => {
	// A text document got closed in VSCode.
	// params.uri uniquely identifies the document.
	connection.console.log(`${params.textDocument.uri} closed.`);
});
*/

// Listen on the connection
connection.listen();
