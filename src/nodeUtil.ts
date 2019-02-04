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

import * as path from 'path';

export type Nullable<T> = T | null;
export type Optional<T> = T | undefined;

export function addTrailingSlash(dir: string) : string
{
    if ((dir.length !== 0) && !dir.endsWith(path.sep))
    {
        return (dir + path.sep);
    }
    return dir;
}

export function removeTrailingSlash(dir: string) : string
{
    if ((dir.length > 1) && dir.endsWith(path.sep))
    {
        return dir.slice(0, -1);
    }
    return dir;
}

export function isAbsolutePathOrFilename(filePath: string) : boolean
{
    if (path.isAbsolute(filePath))
    {
        return true;
    }
    const parsedPath = path.parse(filePath);
    return ((parsedPath.dir.length === 0) && (parsedPath.base !== '.') && (parsedPath.base !== ".."));
}

export function isParentDirectory(parent: string, sub: string) : boolean
{
    return sub.startsWith(addTrailingSlash(parent));
}

export function fileExists(file: string) : Promise<boolean>
{
    return new Promise<boolean>(
        (resolve, _reject) =>
        {
            fs.access(file, fs.constants.F_OK, (err) => { resolve(!err); });
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
