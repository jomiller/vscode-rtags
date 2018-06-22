'use strict';

import { commands, languages, window, workspace, CancellationToken, CodeActionContext, CodeActionProvider, Command,
         Diagnostic, DiagnosticCollection, DiagnosticSeverity, Disposable, ExtensionContext, Position, ProviderResult,
         Range, TextDocument, TextDocumentChangeEvent, Uri, WorkspaceEdit } from 'vscode';

import { spawn } from 'child_process';
import { setTimeout, clearTimeout } from 'timers';

import { Nullable, RtagsSelector, runRc, addProject, reindex } from './rtagsUtil';

import { RtagsCompletionProvider } from './completionProvider';

import { RtagsDefinitionProvider } from './definitionProvider';

import { RtagsSymbolProvider } from './symbolProvider';

import { CallHierarchy } from './callHierarchy';

class RtagsCodeActionProvider implements
    CodeActionProvider,
    Disposable
{
    constructor()
    {
        this.diagnosticCollection = languages.createDiagnosticCollection("rtags");

        this.disposables.push(
            this.diagnosticCollection,
            commands.registerCommand(RtagsCodeActionProvider.commandId, this.runCodeAction, this));
    }

    dispose() : void
    {
        for (let d of this.disposables)
        {
            d.dispose();
        }
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
                        command: RtagsCodeActionProvider.commandId,
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
    let codeActionProvider = new RtagsCodeActionProvider;
    let completionProvider = new RtagsCompletionProvider;
    let definitionProvider = new RtagsDefinitionProvider;
    let symbolProvider = new RtagsSymbolProvider;
    let callHierarchy = new CallHierarchy;

    context.subscriptions.push(
        codeActionProvider,
        completionProvider,
        definitionProvider,
        symbolProvider,
        callHierarchy,
        languages.registerCodeActionsProvider(RtagsSelector, codeActionProvider),
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

    codeActionProvider.startDiagnostics();
}
