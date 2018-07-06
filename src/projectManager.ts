'use strict';

import { Uri } from 'vscode';

import { runRc } from './rtagsUtil';

export function getCurrentProjectPath() : Thenable<Uri>
{
    const processCallback =
        (output: string) : Uri =>
        {
            return Uri.file(output.trim());
        };

    return runRc(["--current-project"], processCallback);
}

export function getProjectPaths() : Thenable<Uri[]>
{
    const processCallback =
        (output: string) : Uri[] =>
        {
            return output.split('\n').map((proj) => { return Uri.file(proj.replace(" <=", "").trim()); });
        };

    return runRc(["--project"], processCallback);
}
