'use strict';

import { commands, window, DocumentFilter, Location, Position, Range, TextDocument, TextDocumentShowOptions, Uri }
         from 'vscode';

import { execFile, ExecFileOptions } from 'child_process';

export type Nullable<T> = T | null;

export interface Locatable
{
    location: Location;
}

export const RtagsSelector: DocumentFilter[] =
[
    { language: "cpp", scheme: "file" },
    { language: "c",   scheme: "file" }
];

export function isUnsavedSourceFile(document: TextDocument) : boolean
{
    if (!document.isDirty)
    {
        return false;
    }
    return RtagsSelector.some((filt) => { return (filt.language === document.languageId); });
}

export function setContext(name: any, value: any) : void
{
    commands.executeCommand("setContext", name, value);
}

export function fromRtagsLocation(path: string) : Location
{
    const [file, line, col] = path.split(':');
    const position = new Position(parseInt(line) - 1, parseInt(col) - 1);
    const uri = Uri.file(file);
    return new Location(uri, position);
}

export function toRtagsLocation(uri: Uri, position: Position) : string
{
    const location = uri.fsPath + ':' + (position.line + 1) + ':' + (position.character + 1);
    return location;
}

export function jumpToLocation(uri: Uri, range: Range) : void
{
    const options: TextDocumentShowOptions = {selection: range};
    window.showTextDocument(uri, options);
}

export function runRc(args: string[], process: (stdout: string) => any, doc?: TextDocument) : Thenable<any>
{
    const executorCallback =
        (resolve: (value?: any) => any, _reject: (reason?: any) => any) : void =>
        {
            if (doc && doc.isDirty)
            {
                const content = doc.getText();
                const path = doc.uri.fsPath;

                const unsaved = path + ':' + content.length;
                args.push("--unsaved-file", unsaved);
            }

            const options: ExecFileOptions =
            {
                maxBuffer: 4 * 1024 * 1024
            };

            const exitCallback =
                (error: Error, stdout: string, stderr: string) : void =>
                {
                    if (error)
                    {
                        if ((stdout && !stdout.startsWith("null")) || stderr)
                        {
                            let message: string = "[RTags] ";
                            if (stderr)
                            {
                                message += "Client error: " + stderr;
                            }
                            else if (error.message)
                            {
                                message += "Client error: " + error.message;
                            }
                            else
                            {
                                message += "Unknown client error";
                            }
                            window.showErrorMessage(message);
                        }
                        resolve([]);
                        return;
                    }
                    resolve(process(stdout));
                };

            args.push("--silent-query");

            let rc = execFile("rc", args, options, exitCallback);

            if (doc && doc.isDirty)
            {
                rc.stdin.write(doc.getText());
                rc.stdin.end();
            }
        };

    return new Promise(executorCallback);
}
