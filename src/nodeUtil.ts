/*
 * This file is part of RTags Client for Visual Studio Code.
 *
 * Copyright (c) yorver
 * Copyright (c) 2018 Jonathan Miller
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

import { ChildProcess, ExecFileOptionsWithStringEncoding, SpawnOptions, execFile, spawn } from 'child_process';

import * as fs from 'fs';

import * as glob from 'glob';

import * as path from 'path';

export type Nullable<T> = T | null;
export type Optional<T> = T | undefined;

export function addTrailingSeparator(fsPath: string) : string
{
    if ((fsPath.length !== 0) && !fsPath.endsWith(path.sep))
    {
        return (fsPath + path.sep);
    }
    return fsPath;
}

export function removeTrailingSeparator(fsPath: string) : string
{
    if ((fsPath.length > 1) && fsPath.endsWith(path.sep))
    {
        return fsPath.slice(0, -1);
    }
    return fsPath;
}

export function isAbsolutePathOrFilename(fsPath: string) : boolean
{
    if (path.isAbsolute(fsPath))
    {
        return true;
    }
    const parsedPath = path.parse(fsPath);
    return ((parsedPath.dir.length === 0) && (parsedPath.base !== '.') && (parsedPath.base !== ".."));
}

export function makeAbsolutePath(base: string, fsPath: string) : string
{
    if (path.isAbsolute(fsPath))
    {
        return fsPath;
    }
    return path.resolve(base, fsPath);
}

export function isContainingDirectory(parent: string, sub: string) : boolean
{
    return sub.startsWith(addTrailingSeparator(parent));
}

export function findFiles(path: string, includePattern: string, excludePattern?: string | ReadonlyArray<string>) :
    Promise<string[]>
{
    return new Promise<string[]>(
        (resolve, _reject) =>
        {
            const options: glob.IOptions =
            {
                cwd: path,
                ignore: excludePattern,
                absolute: true,
                nodir: true,
                nonull: false,
                silent: true
            };

            glob(includePattern, options, (err, matches) => { resolve(err ? [] : matches); });
        });
}

export function isSymbolicLink(path: string) : Promise<boolean>
{
    return new Promise<boolean>(
        (resolve, _reject) =>
        {
            fs.lstat(path, (err, stats) => { resolve(!err && stats.isSymbolicLink()); });
        });
}

export function getRealPath(path: string) : Promise<Optional<string>>
{
    const executorCallback =
        (resolve: (value?: string) => void, _reject: (reason?: any) => void) : void =>
        {
            const callback =
                (error: Nullable<Error>, resolvedPath: string) =>
                {
                    if (error)
                    {
                        resolve();
                    }
                    else
                    {
                        resolve(resolvedPath);
                    }
                };

            fs.realpath(path, {encoding: "utf8"}, callback);
        };

    return new Promise<string>(executorCallback);
}

export function parseJson(input: string) : any
{
    let jsonObj: any = undefined;
    try
    {
        jsonObj = JSON.parse(input);
    }
    catch (_err)
    {
    }
    return jsonObj;
}

export function safeSpawn(command: string, args: ReadonlyArray<string>, options: SpawnOptions) :
    Nullable<ChildProcess>
{
    let process: Nullable<ChildProcess> = null;
    try
    {
        process = spawn(command, args, options);
    }
    catch (_err)
    {
    }
    return process;
}

export function safeExecFile(file: string,
                             args: ReadonlyArray<string>,
                             options: ExecFileOptionsWithStringEncoding,
                             callback: (error: Nullable<Error>, stdout: string, stderr: string) => void) :
    Nullable<ChildProcess>
{
    let process: Nullable<ChildProcess> = null;
    try
    {
        process = execFile(file, args, options, callback);
    }
    catch (_err)
    {
    }
    return process;
}
