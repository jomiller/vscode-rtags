'use strict';

import { commands, window, Location, Position, TextDocument, Uri } from 'vscode';

import { execFile, ExecFileOptions } from 'child_process';

export type Nullable<T> = T | null;

export const RtagsSelector =
[
    { language: "cpp", scheme: "file" },
    { language: "c",   scheme: "file" }
];

export function setContext(name: any, value: any) : void
{
    commands.executeCommand("setContext", name, value);
}

export function fromRtagsLocation(path: string) : Location
{
    let [file, line, col] = path.split(':');
    let position = new Position(parseInt(line) - 1, parseInt(col) - 1);
    let uri = Uri.file(file);
    return new Location(uri, position);
}

export function toRtagsLocation(uri: Uri, position: Position) : string
{
    const location = uri.fsPath + ':' + (position.line + 1) + ':' + (position.character + 1);
    return location;
}

export function runRc(args: string[], process: (stdout: string) => any, doc?: TextDocument) : Thenable<any>
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

            args.push("--silent-query");

            let child = execFile("rc", args, options, callback);

            if (doc && doc.isDirty)
            {
                child.stdin.write(doc.getText());
            }
        };

    return new Promise(executor);
}
