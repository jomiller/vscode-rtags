'use strict';

import { commands, languages, window, workspace, CancellationToken, CodeActionContext, CodeActionProvider, Command,
         CompletionItem, CompletionItemKind, CompletionItemProvider, CompletionList, Definition, DefinitionProvider,
         Diagnostic, DiagnosticCollection, DiagnosticSeverity, Disposable, DocumentSymbolProvider, Event, EventEmitter,
         ExtensionContext, Hover, HoverProvider, ImplementationProvider, Location, Position, ProviderResult, Range,
         ReferenceContext, ReferenceProvider, RenameProvider, SignatureHelp, SignatureHelpProvider,
         SignatureInformation, SnippetString, SymbolInformation, SymbolKind, TextDocument, TextDocumentChangeEvent,
         TreeDataProvider, TreeItem, TreeItemCollapsibleState, TypeDefinitionProvider, Uri, WorkspaceEdit,
         WorkspaceSymbolProvider } from 'vscode';

import { execFile, ExecFileOptions, spawn } from 'child_process';
import { setTimeout, clearTimeout } from 'timers';

type Nullable<T> = T | null;

const RtagsSelector =
[
    { language: "cpp", scheme: "file" },
    { language: "c",   scheme: "file" }
];

enum ReferenceType
{
    Definition,
    Virtuals,
    References,
    Rename,
    SymbolInfo
}

function toCompletionItemKind(kind: string) : CompletionItemKind
{
    switch (kind)
    {
        case "Namespace":
            return CompletionItemKind.Module;

        case "EnumDecl":
            return CompletionItemKind.Enum;

        case "EnumConstantDecl":
            return CompletionItemKind.EnumMember;

        case "ClassDecl":
        case "StructDecl":
            return CompletionItemKind.Class;

        case "CXXConstructor":
            return CompletionItemKind.Constructor;

        case "CXXDestructor":
            return CompletionItemKind.Constructor;

        case "CXXMethod":
            return CompletionItemKind.Method;

        case "FunctionDecl":
            return CompletionItemKind.Function;

        case "FieldDecl":
            return CompletionItemKind.Field;

        case "ParmDecl":
            return CompletionItemKind.Variable;

        case "VarDecl":
            return CompletionItemKind.Variable;
    }

    return CompletionItemKind.Keyword;
}

function toSymbolKind(kind: string) : SymbolKind | undefined
{
    switch (kind)
    {
        case "Namespace":
            return SymbolKind.Namespace;

        case "EnumDecl":
            return SymbolKind.Enum;

        case "EnumConstantDecl":
            return SymbolKind.EnumMember;

        case "ClassDecl":
        case "StructDecl":
            return SymbolKind.Class;

        case "CXXConstructor":
            return SymbolKind.Constructor;

        case "CXXDestructor":
            return SymbolKind.Constructor;

        case "CXXMethod":
            return SymbolKind.Method;

        case "FunctionDecl":
            return SymbolKind.Function;

        case "FieldDecl":
            return SymbolKind.Field;

        case "ParmDecl":
            return SymbolKind.Variable;

        case "VarDecl":
            return SymbolKind.Variable;
    }

    return undefined;
}

function parsePath(path: string) : Location
{
    let [file, l, c] = path.split(':');
    let p = new Position(parseInt(l) - 1, parseInt(c) - 1);
    let uri = Uri.file(file);
    return new Location(uri, p);
}

function runRc(args: string[], process: (stdout: string) => any, doc?: TextDocument) : Thenable<any>
{
    let executor =
        (resolve: (value?: any) => any, _reject: (reason?: any) => any) : void =>
        {
            if (doc && doc.isDirty)
            {
                const content = doc.getText();
                const path = doc.uri.fsPath;

                const unsaved = path + ':' + content.length;
                args.push("--unsaved-file=" + unsaved);
            }

            let options: ExecFileOptions =
            {
                maxBuffer: 4 * 1024 * 1024
            };

            let callback =
                (error: Error, stdout: string, stderr: string) : void =>
                {
                    if (error)
                    {
                        window.showErrorMessage(stderr);
                        resolve([]);
                        return;
                    }
                    resolve(process(stdout));
                };

            let child = execFile("rc", args, options, callback);

            if (doc && doc.isDirty)
            {
                child.stdin.write(doc.getText());
            }
        };

    return new Promise(executor);
}

function toRtagsPosition(uri: Uri, pos: Position) : string
{
    const at = uri.fsPath + ':' + (pos.line + 1) + ':' + (pos.character + 1);
    return at;
}

function diagnose(uri: Uri) : void
{
    const path = uri.fsPath;

    runRc(["--json", "--diagnose", path], (_) => {});
}

function addProjectUri(uri: Uri) : void
{
    runRc(["--load-compile-commands", uri.fsPath],
          (output: string) : void =>
          {
              window.showInformationMessage(output);
          });
}

function reindexUri(uri: Uri) : void
{
    runRc(["--reindex", uri.fsPath],
          (output: string) : void =>
          {
              if (output === "No matches")
              {
                  return;
              }
              setTimeout(diagnose, 1000, uri);
          });
}

function reindex(doc: TextDocument) : void
{
    if (languages.match(RtagsSelector, doc) === 0)
    {
        return;
    }

    runRc(["--reindex", doc.uri.fsPath],
          (output: string) : void =>
          {
              if (output === "No matches")
              {
                  return;
              }
              setTimeout(diagnose, 1000, doc.uri);
          },
          doc);
}

function getCallers(document: TextDocument | undefined, uri: Uri, p: Position) : Thenable<Caller[]>
{
    const at = toRtagsPosition(uri, p);

    let args =
    [
        "--json",
        "--absolute-path",
        "--containing-function",
        "--containing-function-location",
        "--references",
        at
    ];

    let process =
        (output: string) : Caller[] =>
        {
            let result: Caller[] = [];

            const o = JSON.parse(output.toString());

            for (let c of o)
            {
                try
                {
                    let containerLocation = parsePath(c.cfl);
                    let doc = workspace.textDocuments.find(
                        (v, _i) => { return (v.uri.fsPath === containerLocation.uri.fsPath); });

                    let caller: Caller =
                    {
                        location: parsePath(c.loc),
                        containerName: c.cf.trim(),
                        containerLocation: containerLocation,
                        document: doc,
                        context: c.ctx.trim()
                    };
                    result.push(caller);
                }
                catch (_err)
                {
                }
            }

            return result;
        };

    return runRc(args, process, document);
}

function getDefinitions(document: TextDocument, p: Position, type: number = ReferenceType.Definition) :
    Thenable<Location[]>
{
    const at = toRtagsPosition(document.uri, p);

    let args = ["--absolute-path"];

    switch (type)
    {
        case ReferenceType.Virtuals:
            args.push("--find-virtuals", "--references", at);
            break;

        case ReferenceType.References:
            args.push("--references", at);
            break;

        case ReferenceType.Rename:
            args.push("--rename", "--all-references", "--references", at);
            break;

        case ReferenceType.Definition:
            args.push("--follow-location", at);
            break;
    }

    let process =
        (output: string) : Location[] =>
        {
            let result: Location[] = [];
            try
            {
                for (let line of output.toString().split("\n"))
                {
                    if (!line)
                    {
                        continue;
                    }
                    let [location] = line.split("\t", 1);
                    result.push(parsePath(location));
                }
            }
            catch (_err)
            {
                return result;
            }

            return result;
        };

    return runRc(args, process, document);
}

interface Caller
{
    location: Location;
    containerName: string;
    containerLocation: Location;
    document?: TextDocument;
    context: string;
}

class CallHierarchy implements TreeDataProvider<Caller>
{
    getTreeItem(caller: Caller) : TreeItem | Thenable<TreeItem>
    {
        let ti = new TreeItem(caller.containerName + " : " + caller.context, TreeItemCollapsibleState.Collapsed);
        ti.contextValue = "rtagsLocation";
        return ti;
    }

    getChildren(node?: Caller) : ProviderResult<Caller[]>
    {
        const list: Caller[] = [];
        if (!node)
        {
            let editor = window.activeTextEditor;
            if (editor)
            {
                let pos = editor.selection.active;
                let doc = editor.document;
                let loc = new Location(doc.uri, pos);

                let caller: Caller =
                {
                    location: loc,
                    containerLocation: loc,
                    containerName: doc.getText(doc.getWordRangeAtPosition(pos)),
                    document: doc,
                    context: ""
                };
                list.push(caller);
            }
            return list;
        }

        return getCallers(node.document, node.containerLocation.uri, node.containerLocation.range.start);
    }

    refresh() : void
    {
        this.onDidChangeEmitter.fire();
    }

    private onDidChangeEmitter: EventEmitter<Nullable<Caller>> = new EventEmitter<Nullable<Caller>>();
    readonly onDidChangeTreeData: Event<Nullable<Caller>> = this.onDidChangeEmitter.event;
}

class RTagsCompletionItemProvider implements
    CompletionItemProvider,
    SignatureHelpProvider,
    DocumentSymbolProvider,
    WorkspaceSymbolProvider,
    DefinitionProvider,
    TypeDefinitionProvider,
    ImplementationProvider,
    ReferenceProvider,
    HoverProvider,
    CodeActionProvider,
    RenameProvider,
    Disposable
{
    constructor()
    {
        this.diagnosticCollection = languages.createDiagnosticCollection("RTAGS");

        this.disposables.push(
            this.diagnosticCollection,
            commands.registerCommand(RTagsCompletionItemProvider.commandId, this.runCodeAction, this));
    }

    dispose() : void
    {
        for (let d of this.disposables)
        {
            d.dispose();
        }
    }

    provideCompletionItems(document: TextDocument, p: Position, _token: CancellationToken) :
        ProviderResult<CompletionItem[] | CompletionList>
    {
        const wordRange = document.getWordRangeAtPosition(p);
        const range = wordRange ? new Range(wordRange.start, p) : null;
        const maxCompletions = 20;
        const at = toRtagsPosition(document.uri, p);

        let args =
        [
            "--json",
            "--synchronous-completions",
            "--max",
            maxCompletions.toString(),
            "--code-complete-at",
            at
        ];

        if (range)
        {
           const prefix = document.getText(range);
           args.push("--code-complete-prefix", prefix);
        }

        let process =
            (output: string) : CompletionList =>
            {
                const o = JSON.parse(output.toString());
                let result: CompletionItem[] = [];
                for (let c of o.completions)
                {
                    let sortText: string = ("00" + c.priority.toString()).slice(-2);
                    let kind = toCompletionItemKind(c.kind);
                    let insert = new SnippetString();
                    switch (kind)
                    {
                        case CompletionItemKind.Method:
                        case CompletionItemKind.Function:
                            insert = new SnippetString(c.completion + "($1)");
                            break;

                        default:
                            insert = new SnippetString(c.completion);
                            break;
                    }

                    let item: CompletionItem =
                    {
                        label: c.completion,
                        kind: kind,
                        detail:  c.signature,
                        sortText: sortText,
                        insertText: insert
                    };
                    result.push(item);

                    if (result.length === maxCompletions)
                    {
                        break;
                    }
                }
                return new CompletionList(result, result.length >= maxCompletions);
            };

        return runRc(args, process, document);
    }

    provideSignatureHelp(document: TextDocument, p: Position, _token: CancellationToken) :
        ProviderResult<SignatureHelp>
    {
        const maxCompletions = 20;
        const at = toRtagsPosition(document.uri, p);

        let args =
        [
            "--json",
            "--synchronous-completions",
            "--max",
            maxCompletions.toString(),
            "--code-complete-at",
            at
        ];

        let process =
            (output: string) : SignatureHelp =>
            {
                const o = JSON.parse(output.toString());
                let result: SignatureInformation[] = [];

                for (let s of o.signatures)
                {
                    let signatureInfo: SignatureInformation =
                    {
                        label: "test",
                        parameters: s.parameters
                    };
                    result.push(signatureInfo);
                }

                // FIXME: result not used
                let signatureHelp: SignatureHelp =
                {
                    signatures: o.signatures,
                    activeSignature: 0,
                    activeParameter: o.activeParameter
                };
                return signatureHelp;
            };

        return runRc(args, process, document);
    }

    provideDocumentSymbols(doc: TextDocument, _token: CancellationToken) : ProviderResult<SymbolInformation[]>
    {
        return this.findSymbols("", ["--path-filter", doc.uri.fsPath]);
    }

    provideWorkspaceSymbols(query: string, _token: CancellationToken) : ProviderResult<SymbolInformation[]>
    {
        if (query.length < 3)
        {
            return [];
        }
        return this.findSymbols(query, ["--max", "30"]);
    }

    provideDefinition(document: TextDocument, position: Position, _token: CancellationToken) :
        ProviderResult<Definition>
    {
        return getDefinitions(document, position);
    }

    provideTypeDefinition(document: TextDocument, position: Position, _token: CancellationToken) :
        ProviderResult<Definition>
    {
        return getDefinitions(document, position, ReferenceType.Virtuals);
    }

    provideImplementation(document: TextDocument, position: Position, _token: CancellationToken) :
        ProviderResult<Definition>
    {
        return getDefinitions(document, position);
    }

    provideReferences(document: TextDocument,
                      position: Position,
                      _context: ReferenceContext,
                      _token: CancellationToken) :
        ProviderResult<Location[]>
    {
        return getDefinitions(document, position, ReferenceType.References);
    }

    provideHover(document: TextDocument, p: Position, _token: CancellationToken) : ProviderResult<Hover>
    {
        const at = toRtagsPosition(document.uri, p);

        let process =
            (output: string) : Nullable<Hover> =>
            {
                let m = /^Type:(.*)?(=>|$)/gm.exec(output);
                if (m)
                {
                    return new Hover(m[1].toString());
                }
                return null;
            };

        return runRc(["--absolute-path", "--symbol-info", at], process, document);
    }

    provideCodeActions(document: TextDocument, _range: Range, _context: CodeActionContext, _token: CancellationToken) :
        ProviderResult<Command[]>
    {
        let process =
            (output: string) : Command[] =>
            {
                let result: Command[] = [];
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
                    let range: Range = new Range(start, end);
                    if (_range.start.line !== start.line)
                    {
                        continue;
                    }

                    let command: Command =
                    {
                        command: RTagsCompletionItemProvider.commandId,
                        title: "Replace with " + replace,
                        arguments: [document, range, replace]
                    };
                    result.push(command);
                }
                return result;
            };

        return runRc(["--fixits", document.fileName], process);
    }

    provideRenameEdits(document: TextDocument, position: Position, newName: string, _token: CancellationToken) :
        ProviderResult<WorkspaceEdit>
    {
        for (let doc of workspace.textDocuments)
        {
            if (((doc.languageId === "cpp") || (doc.languageId === "c")) && doc.isDirty)
            {
                window.showInformationMessage("Save all source files first before renaming");
                return null;
            }
        }

        let wr = document.getWordRangeAtPosition(position);
        let diff = wr ? (wr.end.character - wr.start.character) : undefined;

        let edits: WorkspaceEdit = new WorkspaceEdit;

        let resolve =
            (results: Location[]) : WorkspaceEdit =>
            {
                for (let r of results)
                {
                    let end = r.range.end.translate(0, diff);
                    edits.replace(r.uri, new Range(r.range.start, end), newName);
                }
                return edits;
            };

        return getDefinitions(document, position, ReferenceType.Rename).then(resolve);
    }

    startDiagnostics() : void
    {
        const rc = spawn("rc", ["--json", "--diagnostics", "--code-completion-enabled"]);
        rc.stdout.on("data",
                     (data: string) : void =>
                     {
                         try
                         {
                             this.unprocessedDiagnostics = this.processDiagnostics(
                                 this.unprocessedDiagnostics + data.toString());
                         }
                         catch (_err)
                         {
                             this.unprocessedDiagnostics = "";
                         }
                     });

        rc.on("exit",
              (_code: number, _signal: string) : void =>
              {
                  this.diagnosticCollection.clear();
                  this.unprocessedDiagnostics = "";
                  window.showErrorMessage("Diagnostics stopped; restarting");
                  setTimeout(() => { this.startDiagnostics(); }, 10000);
              });
    }

    private findSymbols(query: string, args: string[] = []) : Thenable<SymbolInformation[]>
    {
        query += '*';

        let process =
            (output: string) : SymbolInformation[] =>
            {
                let result: SymbolInformation[] = [];
                for (let line of output.split("\n"))
                {
                    let [path, _unused, name, kind, container] = line.split(/\t+/);
                    _unused = _unused;
                    if (!name)
                    {
                        continue;
                    }
                    const localKind = toSymbolKind(kind);
                    if (!localKind)
                    {
                        continue;
                    }
                    const location = parsePath(path);

                    //line.split(/:|function:/).map((x: string) => { return String.prototype.trim.apply(x); });

                    let symbolInfo: SymbolInformation =
                    {
                        name: name,
                        containerName: container,
                        location: location,
                        kind: <SymbolKind>localKind
                    };
                    result.push(symbolInfo);
                }
                return result;
            };

        args.push("--wildcard-symbol-names",
                  "--absolute-path",
                  "--containing-function",
                  "--match-icase",
                  "--find-symbols",
                  query,
                  "--cursor-kind",
                  "--display-name");

        return runRc(args, process);
    }

    private runCodeAction(document: TextDocument, range: Range, newText: string) : any
    {
        let edit = new WorkspaceEdit();
        edit.replace(document.uri, range, newText);
        return workspace.applyEdit(edit);
    }

    private processDiagnostics(data: string) : string
    {
        let end: number;
        while ((end = data.indexOf('\n')) !== -1)
        {
            this.processDiagnosticsLine(data.slice(0, end));
            data = data.substr(end + 1);
        }

        return data.trim();
    }

    private processDiagnosticsLine(output: string) : void
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
        catch (_err)
        {
            window.showErrorMessage("Diagnostics parse error: " + output.toString());
            return;
        }

        for (let file in o.checkStyle)
        {
            if (!o.checkStyle.hasOwnProperty(file))
            {
                continue;
            }

            let diags: Diagnostic[] = [];
            let uri = Uri.file(file);

            for (let d of o.checkStyle[file])
            {
                let p = new Position(d.line - 1, d.column - 1);

                let diag: Diagnostic =
                {
                    message: d.message,
                    range: new Range(p, p),
                    severity: DiagnosticSeverity.Error,
                    source: "rtags",
                    code: 0
                };
                diags.push(diag);
            }
            this.diagnosticCollection.set(uri, diags);
        }
    }

    private static readonly commandId: string = "rtags.runCodeAction";

    private disposables: Disposable[] = [];
    private diagnosticCollection: DiagnosticCollection;
    private unprocessedDiagnostics: string = "";
}

export function activate(context: ExtensionContext)
{
    let r = new RTagsCompletionItemProvider;
    let ch = new CallHierarchy;

    context.subscriptions.push(
        r,
        languages.registerCompletionItemProvider(RtagsSelector, r, '.', ':', '>'),
        languages.registerSignatureHelpProvider(RtagsSelector, r, '(', ','),
        languages.registerDocumentSymbolProvider(RtagsSelector, r),
        languages.registerWorkspaceSymbolProvider(r),
        languages.registerDefinitionProvider(RtagsSelector, r),
        languages.registerTypeDefinitionProvider(RtagsSelector, r),
        languages.registerImplementationProvider(RtagsSelector, r),
        languages.registerReferenceProvider(RtagsSelector, r),
        languages.registerHoverProvider(RtagsSelector, r),
        languages.registerCodeActionsProvider(RtagsSelector, r),
        languages.registerRenameProvider(RtagsSelector, r),
        window.registerTreeDataProvider("rtagsCallHierarchy", ch),
        commands.registerCommand("rtags.addproject", (uri) => { addProjectUri(uri); }),
        commands.registerCommand("rtags.reindex", (uri) => { reindexUri(uri); }),
        commands.registerCommand("rtags.callhierarchy", () => { ch.refresh(); }),
        commands.registerCommand("rtags.selectLocation",
                                 (caller: Caller) : void =>
                                 {
                                     window.showTextDocument(caller.containerLocation.uri,
                                                             {selection: caller.location.range});
                                 }));

    let timerId: Nullable<NodeJS.Timer> = null;
    workspace.onDidChangeTextDocument(
        (event: TextDocumentChangeEvent) : void =>
        {
            if (timerId)
            {
                clearTimeout(timerId);
            }

            timerId = setTimeout(() : void =>
                                 {
                                     reindex(event.document);
                                     timerId = null;
                                 },
                                 1000);
        });

    workspace.onDidSaveTextDocument((doc) => { reindex(doc); });

    r.startDiagnostics();
}
