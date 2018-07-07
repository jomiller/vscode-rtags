'use strict';

import { commands, languages, window, workspace, CancellationToken, CodeActionContext, CodeActionProvider, Command,
         Diagnostic, DiagnosticCollection, DiagnosticSeverity, Disposable, Position, ProviderResult, Range,
         TextDocument, Uri, WorkspaceEdit } from 'vscode';

import { ChildProcess, spawn } from 'child_process';

import { Nullable, RtagsSelector, runRc } from './rtagsUtil';

export class RtagsCodeActionProvider implements
    CodeActionProvider,
    Disposable
{
    constructor()
    {
        this.diagnosticCollection = languages.createDiagnosticCollection("rtags");

        this.disposables.push(
            this.diagnosticCollection,
            languages.registerCodeActionsProvider(RtagsSelector, this),
            commands.registerCommand(RtagsCodeActionProvider.commandId, this.runCodeAction, this));

        this.startDiagnostics();
    }

    public dispose() : void
    {
        this.stopDiagnostics();

        for (let d of this.disposables)
        {
            d.dispose();
        }
    }

    public provideCodeActions(document: TextDocument,
                              _range: Range,
                              _context: CodeActionContext,
                              _token: CancellationToken) :
        ProviderResult<Command[]>
    {
        const processCallback =
            (output: string) : Command[] =>
            {
                let cmds: Command[] = [];
                for (const l of output.split('\n'))
                {
                    if (l.trim().length === 0)
                    {
                        continue;
                    }
                    const [pos, size, replace] = l.split(' ');
                    const [line, col] = pos.split(':');
                    const start = new Position(parseInt(line) - 1, parseInt(col) - 1);
                    const end = start.translate(0, parseInt(size));
                    const range = new Range(start, end);
                    if (_range.start.line !== start.line)
                    {
                        continue;
                    }

                    const command: Command =
                    {
                        command: RtagsCodeActionProvider.commandId,
                        title: "Replace with " + replace,
                        arguments: [document, range, replace]
                    };
                    cmds.push(command);
                }
                return cmds;
            };

        return runRc(["--fixits", document.fileName], processCallback);
    }

    private startDiagnostics() : void
    {
        this.diagnosticProcess = spawn("rc", ["--json", "--diagnostics"]);
        if (!this.diagnosticProcess.pid)
        {
            window.showErrorMessage("[RTags] Could not start diagnostics");
            this.diagnosticProcess = null;
            return;
        }

        const dataCallback =
            (data: string) : void =>
            {
                this.unprocessedDiagnostics = this.processDiagnostics(this.unprocessedDiagnostics + data);
            };

        this.diagnosticProcess.stdout.on("data", dataCallback);

        const exitCallback =
            (_code: number, signal: string) : void =>
            {
                this.diagnosticCollection.clear();
                this.unprocessedDiagnostics = "";
                if (signal !== "SIGTERM")
                {
                    window.showErrorMessage("[RTags] Diagnostics stopped; restarting");
                    setTimeout(() => { this.startDiagnostics(); }, 10000);
                }
            };

        this.diagnosticProcess.on("exit", exitCallback);
    }

    private stopDiagnostics() : void
    {
        if (this.diagnosticProcess)
        {
            this.diagnosticProcess.kill("SIGTERM");
            this.diagnosticProcess = null;
        }
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

        let jsonObj;
        try
        {
            jsonObj = JSON.parse(output);
        }
        catch (_err)
        {
            window.showErrorMessage("[RTags] Diagnostics parse error: " + output);
            return;
        }

        if (!jsonObj.checkStyle)
        {
            return;
        }

        for (const file in jsonObj.checkStyle)
        {
            if (!jsonObj.checkStyle.hasOwnProperty(file))
            {
                continue;
            }

            let diagnostics: Diagnostic[] = [];
            const uri = Uri.file(file);

            for (const d of jsonObj.checkStyle[file])
            {
                const pos = new Position(d.line - 1, d.column - 1);

                const diag: Diagnostic =
                {
                    message: d.message,
                    range: new Range(pos, pos),
                    severity: DiagnosticSeverity.Error,
                    source: "RTags",
                    code: 0
                };
                diagnostics.push(diag);
            }
            this.diagnosticCollection.set(uri, diagnostics);
        }
    }

    private static readonly commandId: string = "rtags.runCodeAction";

    private disposables: Disposable[] = [];
    private diagnosticCollection: DiagnosticCollection;
    private diagnosticProcess: Nullable<ChildProcess> = null;
    private unprocessedDiagnostics: string = "";
}
