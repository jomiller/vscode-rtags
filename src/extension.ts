'use strict';

import { Diagnostic, ExtensionContext, languages, TextDocument, Position, CompletionItemProvider, CompletionItem, WorkspaceSymbolProvider, SymbolInformation,  Uri, TypeDefinitionProvider, Definition, Location, ImplementationProvider, DefinitionProvider, ReferenceProvider, ReferenceContext, RenameProvider, ProviderResult, WorkspaceEdit, window, Range, workspace, CodeActionProvider, CodeActionContext, Command, commands } from 'vscode';
import { CompletionItemKind, CancellationToken, DiagnosticSeverity, Disposable } from 'vscode-languageclient';
import { execFile, execFileSync} from 'child_process'

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
	RENAME : 3
};

function convertKind(kind: string) : CompletionItemKind
{
	switch(kind)
	{
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
	return CompletionItemKind.Text;
}

function parsePath(path: string) : Location
{
	let [file, l, c] = path.split(':');
	let p : Position = new Position(parseInt(l) - 1, parseInt(c) - 1)
	let uri = Uri.file(file);
	return new Location(uri,p);
}

class RTagsCompletionItemProvider 
	implements
	 CompletionItemProvider,
	 WorkspaceSymbolProvider,
	 TypeDefinitionProvider,
	 DefinitionProvider,
	 ImplementationProvider,
	 ReferenceProvider,
	 RenameProvider	,
	 CodeActionProvider,
	 Disposable
	{	
	dispose(): void {
		this.command.dispose();		
	}
	
	command : Disposable;
	
	constructor()
	{		
		this.command = commands.registerCommand(RTagsCompletionItemProvider.commandId, this.runCodeAction, this);
	}

	provideCompletionItems(document : TextDocument, p : Position, _token : CancellationToken)
	: CompletionItem[]	
	{		
		const content = document.getText()
		const path = document.uri.fsPath
		const unsaved = path + ":" + content.length							
		const at = toRtagsPos(document.uri, p);	

		const output = execFileSync('rc',
			 ['--unsaved-file='+unsaved, '--json', 
			  '--synchronous-completions', '-M', '10', '--code-complete-at', at],
			{input: content}
		);
		
		const o = JSON.parse(output.toString());			
		let result = [];
		
		for (let c of  o.completions)		
		{
			result.push(
				{
					label: c.completion,
					kind: convertKind(c.kind),
					detail:  c.signature
				}				
			);
		}	
		return result;
	}	
	

	provideWorkspaceSymbols(query: string, _token: CancellationToken): Thenable<SymbolInformation[]>
	{
		if (query.length < 3)
			return null;

		query += '*'
		return new Promise((resolve, reject) =>
		{
			execFile('rc', 
				['-a', '-K', '-o', '-I',
				'-F', query,'-M', '30',
				'--cursor-kind', '--display-name'],		
				(error, output, stderr) => {
					if (error) 
					{
						console.log(stderr);
						reject();						
					}						
							
					let result = [];					
					for (let line of output.split("\n"))		
					{
						const [path, _, name, kind, container] = line.split('\t');
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
					resolve(result);
				});
		});	
	}

	static commandId: string = 'rtags.runCodeAction';
	
	private runCodeAction(document: TextDocument, range: Range, newText:string): any 
	{
		let edit = new WorkspaceEdit()
		edit.replace(document.uri, range, newText);
		return workspace.applyEdit(edit);
	}

	provideCodeActions(document: TextDocument, _range: Range, _context: CodeActionContext, _token: CancellationToken): ProviderResult<Command[]> 
	{
		return new Promise((resolve, reject) =>
		{
			execFile('rc', 
				['--fixits', document.fileName],	
				(error, output, stderr) => {
					if (error) 
					{
						console.log(stderr);
						reject();												
					}	
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
					resolve(result);
				});	
			});
	}
	provideImplementation(document: TextDocument, position: Position, _token: CancellationToken)
	{
		return this.getDefinitions(document, position);
	}

	provideTypeDefinition(document: TextDocument, position: Position, _token: CancellationToken): Definition
	{
		return this.getDefinitions(document, position);
	}

	provideDefinition(document: TextDocument, position: Position, _token: CancellationToken): Definition
	{
		const r = this.getDefinitions(document, position);
		return r.concat(this.getDefinitions(document, position, ReferenceType.VIRTUALS));		
	}

	provideReferences(document: TextDocument, position: Position, _context: ReferenceContext, _token: CancellationToken): Location[]
	{
		return this.getDefinitions(document, position, ReferenceType.REFERENCES);
	}
		
	getDefinitions(document: TextDocument, p: Position, type: number = ReferenceType.DEFINITION): Location[]
	{
		const content = document.getText()
		const path = document.uri.fsPath
		const unsaved = path + ":" + content.length							
		const at = toRtagsPos(document.uri, p);	

		let args =  ['-K', '--unsaved-file='+unsaved];
		
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

		let result : Location[] =  [];
		try {
			const output = execFileSync('rc', args, {input: content});
						
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
		const results = this.getDefinitions(document, position, ReferenceType.RENAME);
		
		for (let r of results)
		{			
			let end = r.range.end.translate(0, diff);
			edits.replace(r.uri, new Range(r.range.start, end), newName);
		}
		return edits;
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
	const o = JSON.parse(output.toString());			
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
export function activate(context: ExtensionContext) 
{	
	let r = new RTagsCompletionItemProvider;	
	context.subscriptions.push(r);
	context.subscriptions.push(languages.registerCompletionItemProvider(RTAGS_MODE, r));
	context.subscriptions.push(languages.registerWorkspaceSymbolProvider(r));
	context.subscriptions.push(languages.registerTypeDefinitionProvider(RTAGS_MODE, r));
	context.subscriptions.push(languages.registerDefinitionProvider(RTAGS_MODE, r));
	context.subscriptions.push(languages.registerImplementationProvider(RTAGS_MODE, r));	
	context.subscriptions.push(languages.registerReferenceProvider(RTAGS_MODE, r));	
	context.subscriptions.push(languages.registerRenameProvider(RTAGS_MODE, r));		
	context.subscriptions.push(languages.registerCodeActionsProvider(RTAGS_MODE, r));		
		
	workspace.onDidChangeTextDocument(function(event)
	{
		const path = event.document.uri.fsPath		
		const content = event.document.getText()		
		const unsaved = path + ":" + content.length							
		
		execFileSync('rc',
			 ['--unsaved-file='+unsaved, '--reindex', path],
			{input: content})
	});

	workspace.onDidSaveTextDocument(function(document)
	{		
		const path = document.uri.fsPath		
				
		execFile('rc', 
		[ '--json', '--synchronous-diagnostics', '--diagnose', path],		
			(error, output, stderr) => {
			if (error) 
			{
				console.log(stderr);						
				return;
			}					
			processDiagnostics(output);								
		});
		
	});
}

