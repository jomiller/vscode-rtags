'use strict';

import { languages, window, Location, Position, TextDocument, Uri } from 'vscode';

import { execFile, ExecFileOptions } from 'child_process';

export type Nullable<T> = T | null;

export const RtagsSelector =
[
    { language: "cpp", scheme: "file" },
    { language: "c",   scheme: "file" }
];

export function parsePath(path: string) : Location
{
    let [file, l, c] = path.split(':');
    let p = new Position(parseInt(l) - 1, parseInt(c) - 1);
    let uri = Uri.file(file);
    return new Location(uri, p);
}

export function toRtagsPosition(uri: Uri, pos: Position) : string
{
    const at = uri.fsPath + ':' + (pos.line + 1) + ':' + (pos.character + 1);
    return at;
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

            let child = execFile("rc", args, options, callback);

            if (doc && doc.isDirty)
            {
                child.stdin.write(doc.getText());
            }
        };

    return new Promise(executor);
}

function diagnose(uri: Uri) : void
{
    const path = uri.fsPath;

    runRc(["--json", "--diagnose", path], (_) => {});
}

export function addProject(uri: Uri) : void
{
    runRc(["--load-compile-commands", uri.fsPath],
          (output: string) : void =>
          {
              window.showInformationMessage(output);
          });
}

function isTextDocument(file: TextDocument | Uri) : file is TextDocument
{
    return ((<TextDocument>file).uri !== undefined);
}

export function reindex(file: TextDocument | Uri) : void
{
    let doc: TextDocument | undefined = undefined;
    let uri: Uri;

    if (isTextDocument(file))
    {
        doc = file;
        uri = doc.uri;

        if (languages.match(RtagsSelector, doc) === 0)
        {
            return;
        }
    }
    else
    {
        uri = file;
    }

    runRc(["--reindex", uri.fsPath],
          (output: string) : void =>
          {
              if (output === "No matches")
              {
                  return;
              }
              setTimeout(diagnose, 1000, uri);
          },
          doc);
}
