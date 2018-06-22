'use strict';

import { commands, languages, window, workspace, CancellationToken, CodeActionContext, CodeActionProvider, Command,
         CompletionItem, CompletionItemKind, CompletionItemProvider, CompletionList, Diagnostic, DiagnosticCollection,
         DiagnosticSeverity, Disposable, ExtensionContext, Position, ProviderResult, Range, SignatureHelp,
         SignatureHelpProvider, SignatureInformation, SnippetString, TextDocument, TextDocumentChangeEvent, Uri,
         WorkspaceEdit } from 'vscode';

import { spawn } from 'child_process';
import { setTimeout, clearTimeout } from 'timers';

import { Nullable, RtagsSelector, toRtagsPosition, runRc, addProject, reindex } from './rtagsUtil';

import { RtagsDefinitionProvider } from './definitionProvider';

import { RtagsSymbolProvider } from './symbolProvider';

import { CallHierarchy } from './callHierarchy';

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

class RtagsCompletionProvider implements
    CompletionItemProvider,
    SignatureHelpProvider,
    CodeActionProvider,
    Disposable
{
    constructor()
    {
        this.diagnosticCollection = languages.createDiagnosticCollection("rtags");

        this.disposables.push(
            this.diagnosticCollection,
            commands.registerCommand(RtagsCompletionProvider.commandId, this.runCodeAction, this));
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
                        command: RtagsCompletionProvider.commandId,
                        title: "Replace with " + replace,
                        arguments: [document, range, replace]
                    };
                    result.push(command);
                }
                return result;
            };

        return runRc(["--fixits", document.fileName], process);
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
    let completionProvider = new RtagsCompletionProvider;
    let definitionProvider = new RtagsDefinitionProvider;
    let symbolProvider = new RtagsSymbolProvider;
    let callHierarchy = new CallHierarchy;

    context.subscriptions.push(
        completionProvider,
        definitionProvider,
        symbolProvider,
        callHierarchy,
        languages.registerCompletionItemProvider(RtagsSelector, completionProvider, '.', ':', '>'),
        languages.registerSignatureHelpProvider(RtagsSelector, completionProvider, '(', ','),
        languages.registerCodeActionsProvider(RtagsSelector, completionProvider),
        commands.registerCommand("rtags.addProject", (uri) => { addProject(uri); }),
        commands.registerCommand("rtags.reindex", (uri) => { reindex(uri); }));

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

    completionProvider.startDiagnostics();
}
