'use strict';

import { CompletionItemKind, CancellationToken, DiagnosticSeverity, Disposable, Diagnostic, ExtensionContext, languages, TextDocument, Position, CompletionItemProvider, WorkspaceSymbolProvider, SymbolInformation,  Uri, Location, ImplementationProvider, DefinitionProvider, ReferenceProvider, ReferenceContext, RenameProvider, ProviderResult, WorkspaceEdit, window, Range, workspace, CodeActionProvider, CodeActionContext, Command, commands, SignatureHelpProvider, SignatureHelp, Definition, CompletionList, HoverProvider, Hover, SignatureInformation, TypeDefinitionProvider, DocumentSymbolProvider } from 'vscode';
import { execFile } from 'child_process'
import { setTimeout } from 'timers';


let dc = languages.createDiagnosticCollection("RTAGS");

const RTAGS_MODE = [
	{ language: "cpp", scheme: "file" },
	{ language: "c", scheme: "file" }
];

var ReferenceType =
{
	DEFINITION : 0,
	VIRTUALS : 1,
	REFERENCES : 2,
	RENAME : 3,
	SYMBOL_INFO: 4
};

function convertKind(kind: string) : CompletionItemKind
{
	switch(kind)
	{
		case "FieldDecl" :
			return CompletionItemKind.Field;
		case "ParmDecl" :
			return CompletionItemKind.Variable;
		case "Namespace" :
			return CompletionItemKind.Module;
		case "FunctionDecl" :
			return CompletionItemKind.Function;
		case "VarDecl" :
			return CompletionItemKind.Variable;
		case "CXXMethod" :
			return CompletionItemKind.Method;
		case "CXXDestructor" :
			return CompletionItemKind.Constructor;
		case "CXXConstructor" :
			return CompletionItemKind.Constructor;
		case "EnumDecl" :
			return CompletionItemKind.Enum;
		case "ClassDecl" :
		case "StructDecl" :
			return CompletionItemKind.Class;
	}
	return CompletionItemKind.Keyword;
}

function parsePath(path: string) : Location
{
	let [file, l, c] = path.split(':');
	let p : Position = new Position(parseInt(l) - 1, parseInt(c) - 1)
	let uri = Uri.file(file);
	return new Location(uri,p);
}

function runRC(args: string[],  process: (stdout:string) => any, doc? : TextDocument )
: Thenable<any>
{
   return new Promise((resolve, _reject) =>
   {	
		if (doc && doc.isDirty)
		{			
			const content = doc.getText()
			const path = doc.uri.fsPath

			const unsaved = path + ":" + content.length		
			args.push('--unsaved-file='+unsaved)
		}

	   let child = execFile('rc', args,
		   {
			   maxBuffer: 4 * 1024*1024
		   },
		   (error, output, stderr) => {
			   if (error)
			   {
				   window.showErrorMessage(stderr);				   
				   resolve([]);
				   return;
			   }
			   resolve(process(output));
		   }
	   )

	   if (doc && doc.isDirty)
		   child.stdin.write(doc.getText())
   });
}

class RTagsCompletionItemProvider
	implements
	 CompletionItemProvider,
	 WorkspaceSymbolProvider,
	 DocumentSymbolProvider,
	 HoverProvider,
	 DefinitionProvider,
	 TypeDefinitionProvider,
	 ImplementationProvider,
	 ReferenceProvider,
	 RenameProvider	,
	 CodeActionProvider,
	 SignatureHelpProvider,
	 Disposable
	{
	


	dispose(): void {
		for (let d of this.disposables)
			d.dispose();
	}

	disposables : Disposable[] = [];

	constructor()
	{
		this.disposables.push(
			commands.registerCommand(RTagsCompletionItemProvider.commandId, this.runCodeAction, this)
		);

	}

	provideCompletionItems(document : TextDocument, p : Position, _token : CancellationToken)
		: Thenable<CompletionList>
	{		
		const range = document.getWordRangeAtPosition(p);
		const max_completions:Number = 20;
		const at = toRtagsPos(document.uri, p);
		let args = ['--json', 
		'--synchronous-completions', '-M',  max_completions.toString(),
		 '--code-complete-at', at];

		 if (range)		
		 {
			const prefix = document.getText(range);
			args.push('--code-complete-prefix', prefix);
		 }
			 
		return runRC(
			args,
				function(output:string)
				{
					const o = JSON.parse(output.toString());
					let result = [];

					for (let c of  o.completions)
					{
						let sortText : string = ("00" + result.length.toString()).slice(-2)						
						result.push(
							{
								label: c.completion,
								kind: convertKind(c.kind),
								detail:  c.signature,
								sortText : sortText
							}
						);

						if (result.length == max_completions)
							break;
					}
					return new CompletionList(result, result.length >= max_completions);
				},
				document				
		);
	}

	provideDocumentSymbols(doc: TextDocument, _token: CancellationToken): ProviderResult<SymbolInformation[]> {
		return this.findSymbols("", ["--path-filter", doc.uri.fsPath]);
	}

	provideWorkspaceSymbols(query: string, _token: CancellationToken): Thenable<SymbolInformation[]>
	{
		if (query.length < 3)
			return null;
		return this.findSymbols(query);
	}
	findSymbols(query: string, args : string[] = [])
	{
		query += '*'
		return runRC(
			['-a', '-K', '-o', '-I',
			'-F', query,'-M', '30',
			'--cursor-kind', '--display-name'].concat(args),
			function(output:string)
			{
				let result = [];
				for (let line of output.split("\n"))
				{
					const [path, _, name, kind, container] = line.split(/\t+/);
					void(_);
					if (name === undefined || name.length < 3)
						continue;

					const location = parsePath(path);

					//line.split( /:|function:/).map(function(x:string) {return String.prototype.trim.apply(x)});

					result.push(
						{
							name: name,
							containerName: container,
							location: location,
							kind: convertKind(kind)
						}
					);
				}
				return result;
			}
		);
	}

	static commandId: string = 'rtags.runCodeAction';
	static findVirtuals: string = 'rtags.findVirtuals';

	private runCodeAction(document: TextDocument, range: Range, newText:string): any
	{
		let edit = new WorkspaceEdit()
		edit.replace(document.uri, range, newText);
		return workspace.applyEdit(edit);
	}

	provideCodeActions(document: TextDocument, _range: Range, _context: CodeActionContext, _token: CancellationToken): ProviderResult<Command[]>
	{
		return runRC(
			['--fixits', document.fileName],
			function(output:string)
			{
				let result : Command[] = [];
				for (let l of output.split('\n'))
				{
					if (l.trim().length == 0)
						continue;
					let [pos, size, replace] = l.split(" ")				;
					let [line, col] = pos.split(':');
					let start = new Position(parseInt(line) - 1, parseInt(col) - 1)
					let end = start.translate(0, parseInt(size))
					let range : Range = new Range(start, end)
					if (_range.start.line != start.line)
						continue;
					result.push(
						{
							command : RTagsCompletionItemProvider.commandId,
							title : "Replace with " + replace,
							arguments : [document, range, replace]
						}
					)
				}
				return result;
			}
		);
	}
	provideImplementation(document: TextDocument, position: Position, _token: CancellationToken)
	{
		return this.getDefinitions(document, position);
	}

	provideHover(document: TextDocument, p: Position, _token: CancellationToken): ProviderResult<Hover> 
	{
		const at = toRtagsPos(document.uri, p);

		return runRC(['-K',	'-U', at], 
			(output) => 
			{				
				let m = /^Type:(.*)?(=>|$)/gm.exec(output)
				if (m)								
					return new Hover(m[1].toString());
				else 
					return null;
			},
			document
		);	
	}
	
	provideDefinition(document: TextDocument, position: Position, _token: CancellationToken) :  ProviderResult<Definition>
	{
		return this.getDefinitions(document, position);
	}
	
	provideTypeDefinition(document: TextDocument, position: Position, _token: CancellationToken): ProviderResult<Definition> {
		return this.getDefinitions(document, position, ReferenceType.VIRTUALS);
	}

	provideReferences(document: TextDocument, position: Position, _context: ReferenceContext, _token: CancellationToken): Thenable<Location[]>
	{
		return this.getDefinitions(document, position, ReferenceType.REFERENCES);
	}

	getDefinitions(document: TextDocument, p: Position, type: number = ReferenceType.DEFINITION): Thenable<Location[]>
	{		
		const at = toRtagsPos(document.uri, p);

		let args =  ['-K'];

		switch(type)
		{
			case ReferenceType.VIRTUALS:
				args.push('-k', '-r', at); break;
			case ReferenceType.REFERENCES:
				args.push('-r', at); break;
			case ReferenceType.RENAME:
				args.push('--rename', '-e', '-r', at); break
			case ReferenceType.DEFINITION:
				args.push('-f', at); break;		
		}

		return runRC(args,
			 function(output:string)
			 {
				let result : Location[] =  [];
				try {
					for (let line of output.toString().split("\n"))
					{
						if (line == '')
							continue;
						let [location] = line.split("\t", 1);
						result.push(parsePath(location));
					}
				}
				catch (err)
				{
					return result;
				}

				return result;
			 },
			 document);
	}

	provideRenameEdits(document: TextDocument, position: Position, newName: string, _token: CancellationToken): ProviderResult<WorkspaceEdit>
	{
		for (let doc of workspace.textDocuments)
		{
			if (doc.languageId == 'cpp' && doc.isDirty)
			{
				window.showInformationMessage("Save all cpp files first before renaming");
				return null;
			}
		}

		let wr = document.getWordRangeAtPosition(position);
		let diff = wr.end.character - wr.start.character;

		let edits : WorkspaceEdit = new WorkspaceEdit;
		return this.getDefinitions(document, position, ReferenceType.RENAME).then(
			function(results)
			{
				for (let r of results)
				{
					let end = r.range.end.translate(0, diff);
					edits.replace(r.uri, new Range(r.range.start, end), newName);
				}
				return edits;
			});
	}

	provideSignatureHelp(document: TextDocument, p: Position, _token: CancellationToken): ProviderResult<SignatureHelp> 
	{
		const max_completions:Number = 20;
		const at = toRtagsPos(document.uri, p);
		let args = ['--json', 
		'--synchronous-completions', '-M',  max_completions.toString(),
		'--code-complete-at', at,
	    '--code-complete-param'];

		return runRC(
			args,
				function(output:string)
				{
					const o = JSON.parse(output.toString());
					let result : SignatureInformation[] = [];

					for (let s of  o.signatures)
					{						
						result.push(
							{
								label : "test",
								parameters : s.parameters
							})						
					}
					return {
						signatures: o.signatures,
						activeSignature: 0,
						activeParameter: o.activeParameter};
				},
				document				
		);
	}	
}

function toRtagsPos(uri: Uri, pos: Position) {
	const at = uri.fsPath + ':' + (pos.line+1) + ':' + (pos.character+1);
	return at;
}

function processDiagnostics(output:string)
{	
	if (output.length == 0)
		return;
	let o;
	try 
	{
		o = JSON.parse(output.toString());
	}
	catch (err)
	{
		window.showErrorMessage(output);
		return;
	}

	dc.clear();
	for (var file in o.checkStyle)
	{
		if (!o.checkStyle.hasOwnProperty(file))
			continue;

		let diags : Diagnostic[] = [];
		let uri = Uri.file(file);

		for (let d of o.checkStyle[file])
		{
			let p = new Position(d.line-1, d.column-1);
			diags.push
			(
				{
					message : d.message,
					range : new Range(p,p),
					severity : DiagnosticSeverity.Error,
					source : 'rtags',
					code: 0
				}
			)
		}
		dc.set(uri, diags);
	}
}

function diagnostics(document: TextDocument)
{
	const path = document.uri.fsPath

	runRC(
	[ '--json', '--synchronous-diagnostics', '--diagnose', path],
		(output) => { processDiagnostics(output);}
	);
}

export function activate(context: ExtensionContext)
{
	let r = new RTagsCompletionItemProvider;
	context.subscriptions.push(
		r
		,languages.registerCompletionItemProvider(RTAGS_MODE, r, '.', ':', '>')
		,languages.registerWorkspaceSymbolProvider(r)
		,languages.registerDocumentSymbolProvider(RTAGS_MODE, r)
		,languages.registerHoverProvider(RTAGS_MODE, r)
		,languages.registerDefinitionProvider(RTAGS_MODE, r)
		,languages.registerTypeDefinitionProvider(RTAGS_MODE, r)
		,languages.registerImplementationProvider(RTAGS_MODE, r)
		,languages.registerReferenceProvider(RTAGS_MODE, r)
		,languages.registerRenameProvider(RTAGS_MODE, r)
		,languages.registerCodeActionsProvider(RTAGS_MODE, r)
		,languages.registerSignatureHelpProvider(RTAGS_MODE, r, '(', ',')
	);

	workspace.onDidChangeTextDocument(function(event)
	{
		runRC(['--reindex', event.document.uri.fsPath],
		 	(output : string) : void => { 
				 if (output == 'No matches')
				 	return;
				 setTimeout(diagnostics, 1000, event.document);
				},
			event.document)
	});

	workspace.onDidSaveTextDocument(
		(doc) =>
		{
			setTimeout(diagnostics, 1000, doc);
		}
	);
}

