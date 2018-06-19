'use strict';

import { CompletionItemKind, CancellationToken, DiagnosticSeverity, Disposable, Diagnostic, ExtensionContext, languages, TextDocument, Position, CompletionItemProvider, WorkspaceSymbolProvider, SymbolInformation,  Uri, Location, ImplementationProvider, DefinitionProvider, ReferenceProvider, ReferenceContext, RenameProvider, ProviderResult, WorkspaceEdit, window, Range, workspace, CodeActionProvider, CodeActionContext, Command, commands, SignatureHelpProvider, SignatureHelp, Definition, CompletionList, HoverProvider, Hover, SignatureInformation, TypeDefinitionProvider, DocumentSymbolProvider, TreeDataProvider, TreeItem, EventEmitter, Event, TreeItemCollapsibleState, SnippetString } from 'vscode';
import { execFile, spawn } from 'child_process';
import { setTimeout, clearTimeout } from 'timers';


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
    let p : Position = new Position(parseInt(l) - 1, parseInt(c) - 1);
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
            const content = doc.getText();
            const path = doc.uri.fsPath;

            const unsaved = path + ":" + content.length;
            args.push('--unsaved-file='+unsaved);
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
       );

       if (doc && doc.isDirty)
       {
           child.stdin.write(doc.getText());
       }
   });
}

function getCallers(document: TextDocument, uri: Uri, p: Position): Thenable<Caller[]>
{
    const at = toRtagsPos(uri, p);

    let args =  ['-K', '-o', '--containing-function-location', '-r', at, '--json'];

    return runRC(args,
            function(output:string)
            {
                let result: Caller[] = [];

                const o = JSON.parse(output.toString());

                for (let c of o) {
                    try {
                        let containerLocation = parsePath(c.cfl);
                        let doc = workspace.textDocuments.find(
                            (v, _i) => { return (v.uri.fsPath === containerLocation.uri.fsPath); }
                        );
                        result.push(
                            {
                                location: parsePath(c.loc),
                                containerName: c.cf.trim(),
                                containerLocation: containerLocation,
                                document: doc,
                                context: c.ctx.trim()
                            });
                    }
                    catch (err) {
                    }
                }

                return result;
            },
            document);
}

function getDefinitions(document: TextDocument, p: Position, type: number = ReferenceType.DEFINITION): Thenable<Location[]>
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
            args.push('--rename', '-e', '-r', at); break;
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
                    if (line === '')
                    {
                        continue;
                    }
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

class Caller
{
    location : Location;
    containerName : string;
    containerLocation : Location;
    document : TextDocument;
    context: string;
}

class CallHierarchy
    implements TreeDataProvider<Caller>
{

    private _onDidChangeTreeData: EventEmitter<Caller | null> = new EventEmitter<Caller | null>();
    readonly onDidChangeTreeData: Event<Caller | null> = this._onDidChangeTreeData.event;
    //onDidChangeTreeData :

    getTreeItem(caller: Caller): TreeItem | Thenable<TreeItem> {
        let ti = new TreeItem(caller.containerName + " : " + caller.context , TreeItemCollapsibleState.Collapsed);
        ti.contextValue = "rtagsLocation";
        // ti.command = {
        //     command: 'rtags.selectLocation',
        //     title: '',
        //     arguments: [
        //         caller
        //     ]
        // };
        return ti;
    }

    getChildren(node?: Caller): ProviderResult<Caller[]>
    {
        const list : Caller[] = [];
        if (!node)
        {
            let pos = window.activeTextEditor.selection.active;
            let doc = window.activeTextEditor.document;
            let loc = new Location(doc.uri, pos);
            list.push(
            {
                location: loc,
                containerLocation : loc,
                containerName: doc.getText(doc.getWordRangeAtPosition(pos)),
                document: doc,
                context: ""
            });
            return list;
        }

        return getCallers(node.document, node.containerLocation.uri, node.containerLocation.range.start);
    }

    refresh(): void
    {
        this._onDidChangeTreeData.fire();
    }


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
        {
            d.dispose();
        }
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
        const word_range = document.getWordRangeAtPosition(p);
        const range = word_range ? new Range(word_range.start, p) : null;
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
                        let sortText : string = ("00" + c.priority.toString()).slice(-2);
                        let kind = convertKind(c.kind);
                        let insert = new SnippetString();
                        switch(kind)
                        {
                            case CompletionItemKind.Method:
                            case CompletionItemKind.Function:
                                insert = new SnippetString(c.completion + '($1)');
                                break;
                            default:
                                insert = new SnippetString(c.completion);
                        }

                        result.push(
                            {
                                label: c.completion,
                                kind: kind,
                                detail:  c.signature,
                                sortText : sortText,
                                insertText : insert
                            }
                        );

                        if (result.length === max_completions)
                        {
                            break;
                        }
                    }
                    return new CompletionList(result, result.length >= max_completions);
                },
                document
        );
    }

    provideDocumentSymbols(doc: TextDocument, _token: CancellationToken): ProviderResult<SymbolInformation[]> {
        return this.findSymbols("", ["--path-filter", doc.uri.fsPath],
            (kind : CompletionItemKind) =>
                {
                    switch(kind)
                    {
                        case CompletionItemKind.Class:
                        case CompletionItemKind.Function:
                        case CompletionItemKind.Method:
                        case CompletionItemKind.Enum:
                        case CompletionItemKind.Operator:
                        case CompletionItemKind.Interface:
                        case CompletionItemKind.Field:
                        case CompletionItemKind.Constructor:
                            return true;
                    }
                    return false;
                });
    }

    provideWorkspaceSymbols(query: string, _token: CancellationToken): Thenable<SymbolInformation[]>
    {
        if (query.length < 3)
        {
            return null;
        }
        return this.findSymbols(query, ['-M', '30']);
    }
    findSymbols(query: string, args : string[] = [], filter? : (kind: CompletionItemKind) => boolean)
    {
        query += '*';
        return runRC(
            ['-a', '-K', '-o', '-I',
            '-F', query,
            '--cursor-kind', '--display-name'].concat(args),
            function(output:string)
            {
                let result = [];
                for (let line of output.split("\n"))
                {
                    const [path, _, name, kind, container] = line.split(/\t+/);
                    if (name === undefined)
                    {
                        continue;
                    }
                    const localKind = convertKind(kind);
                    if (filter && !filter(localKind))
                    {
                        continue;
                    }
                    const location = parsePath(path);

                    //line.split( /:|function:/).map(function(x:string) {return String.prototype.trim.apply(x)});

                    result.push(
                        {
                            name: name,
                            containerName: container,
                            location: location,
                            kind: localKind
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
        let edit = new WorkspaceEdit();
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
                    if (l.trim().length === 0)
                    {
                        continue;
                    }
                    let [pos, size, replace] = l.split(" ");
                    let [line, col] = pos.split(':');
                    let start = new Position(parseInt(line) - 1, parseInt(col) - 1);
                    let end = start.translate(0, parseInt(size));
                    let range : Range = new Range(start, end);
                    if (_range.start.line !== start.line)
                    {
                        continue;
                    }
                    result.push(
                        {
                            command : RTagsCompletionItemProvider.commandId,
                            title : "Replace with " + replace,
                            arguments : [document, range, replace]
                        }
                    );
                }
                return result;
            }
        );
    }
    provideImplementation(document: TextDocument, position: Position, _token: CancellationToken)
    {
        return getDefinitions(document, position);
    }

    provideHover(document: TextDocument, p: Position, _token: CancellationToken): ProviderResult<Hover>
    {
        const at = toRtagsPos(document.uri, p);

        return runRC(['-K',	'-U', at],
            (output) =>
            {
                let m = /^Type:(.*)?(=>|$)/gm.exec(output);
                if (m)
                {
                    return new Hover(m[1].toString());
                }
                return null;
            },
            document
        );
    }

    provideDefinition(document: TextDocument, position: Position, _token: CancellationToken) :  ProviderResult<Definition>
    {
        return getDefinitions(document, position);
    }

    provideTypeDefinition(document: TextDocument, position: Position, _token: CancellationToken): ProviderResult<Definition> {
        return getDefinitions(document, position, ReferenceType.VIRTUALS);
    }

    provideReferences(document: TextDocument, position: Position, _context: ReferenceContext, _token: CancellationToken): Thenable<Location[]>
    {
        return getDefinitions(document, position, ReferenceType.REFERENCES);
    }

    provideRenameEdits(document: TextDocument, position: Position, newName: string, _token: CancellationToken): ProviderResult<WorkspaceEdit>
    {
        for (let doc of workspace.textDocuments)
        {
            if (doc.languageId === 'cpp' && doc.isDirty)
            {
                window.showInformationMessage("Save all cpp files first before renaming");
                return null;
            }
        }

        let wr = document.getWordRangeAtPosition(position);
        let diff = wr.end.character - wr.start.character;

        let edits : WorkspaceEdit = new WorkspaceEdit;
        return getDefinitions(document, position, ReferenceType.RENAME).then(
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
                            });
                    }
                    return {
                        signatures: o.signatures,
                        activeSignature: 0,
                        activeParameter: o.activeParameter};
                },
                document
        );
    }

    getJsonObject(data: string) : string
    {
        let end : number;
        while ((end = data.indexOf('\n')) !== -1)
        {
            processDiagnostics(data.slice(0, end));
            data = data.substr(end + 1);
        }

        return data.trim();
    }

    unprocessedDiagnostics : string = "";
    listenToDiagnostics()
    {
        const rc = spawn('rc', ['-m', '--json', '-b']);
        rc.stdout.on('data',
            (data) => {
                try
                {
                    this.unprocessedDiagnostics = this.getJsonObject(
                        this.unprocessedDiagnostics + data.toString()
                    );
                }
                catch(_err)
                {
                    this.unprocessedDiagnostics = '';
                }

            });

        rc.on("exit", (_code, _signal) =>
        {
            dc.clear();
            this.unprocessedDiagnostics = "";
            window.showErrorMessage("Diagnostics stopped. restarting");
            setTimeout( () =>	this.listenToDiagnostics(), 10000);
        });
    }
}

function toRtagsPos(uri: Uri, pos: Position) {
    const at = uri.fsPath + ':' + (pos.line+1) + ':' + (pos.character+1);
    return at;
}

function processDiagnostics(output: string)
{
    if (output.trim().length === 0)
    {
        return;
    }
    let o;
    try
    {
        o = JSON.parse(output.toString());
    }
    catch (err)
    {
        window.showErrorMessage("Diagnostics parse error: " + output.toString());
        return;
    }

    //dc.clear();
    for (var file in o.checkStyle)
    {
        if (!o.checkStyle.hasOwnProperty(file))
        {
            continue;
        }

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
            );
        }
        dc.set(uri, diags);
    }
}

function diagnostics(uri: Uri)
{
    const path = uri.fsPath;

    runRC( [ '--json', '--diagnose', path], (_) => {}	);
}


function reindexUri(uri : Uri)
{
    runRC(['--reindex', uri.fsPath],
        (output : string) : void => {
                if (output === 'No matches')
                {
                    return;
                }
                setTimeout(diagnostics, 1000, uri);
            },
        );
}


function addProjectUri(uri : Uri)
{
    runRC(['-J', uri.fsPath],
        (output : string) : void => {
                window.showInformationMessage(output);
            },
        );
}

function reindex(doc : TextDocument)
{
    if (languages.match(RTAGS_MODE, doc) === 0)
    {
        return;
    }

    runRC(['--reindex', doc.uri.fsPath],
        (output : string) : void => {
                if (output === 'No matches')
                {
                    return;
                }
                setTimeout(diagnostics, 1000, doc.uri);
            },
        doc);
}

export function activate(context: ExtensionContext)
{
    let r = new RTagsCompletionItemProvider;
    let ch = new CallHierarchy;

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
        ,window.registerTreeDataProvider('rtagsCallHierarchy', ch)
        ,commands.registerCommand('rtags.addproject', (uri) => { addProjectUri(uri); })
        ,commands.registerCommand('rtags.reindex', (uri) => { reindexUri(uri); })
        ,commands.registerCommand('rtags.callhierarcy', () => ch.refresh())
        ,commands.registerCommand('rtags.selectLocation', (caller) => {
            window.showTextDocument(caller.containerLocation.uri, {
                selection: caller.location.range
            });
            })
    );

    var timerId : NodeJS.Timer = null;
    workspace.onDidChangeTextDocument((event) =>
    {
        if (timerId)
        {
            clearTimeout(timerId);
        }

        timerId = setTimeout(() => {
            reindex(event.document);
            timerId = null;
        }, 1000);
    });

    workspace.onDidSaveTextDocument( (doc) => {	reindex(doc); } );

    r.listenToDiagnostics();



    //commands.registerCommand('rtags.callhierarcy', )
}

