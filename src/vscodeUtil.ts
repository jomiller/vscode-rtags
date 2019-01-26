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

import { commands, languages, window, workspace, DocumentFilter, Location, Position, Range, TextDocument,
         TextDocumentShowOptions, Uri } from 'vscode';

import * as path from 'path';

import { ConfigurationId, VsCodeCommand, ResourceConfiguration } from './constants';

import { removeTrailingSlash } from './nodeUtil';

export interface Locatable
{
    location: Location;
}

export interface ConfigurationMap
{
    [key: string] : any;
}

export function getWorkspaceConfiguration() : Map<string, ConfigurationMap>
{
    let configCache = new Map<string, ConfigurationMap>();

    if (workspace.workspaceFolders)
    {
        for (const folder of workspace.workspaceFolders)
        {
            const folderConfig = workspace.getConfiguration(ConfigurationId, folder.uri);
            let folderCache: ConfigurationMap = {};
            for (const key in ResourceConfiguration)
            {
                const val = ResourceConfiguration[key];
                folderCache[val] = folderConfig.get(val);
            }
            configCache.set(folder.uri.fsPath, folderCache);
        }
    }

    return configCache;
}

export function fromConfigurationPath(dir: string) : string
{
    return removeTrailingSlash(path.normalize(dir.trim()));
}

export const SourceFileSelector: DocumentFilter[] =
[
    { language: "c",   scheme: "file" },
    { language: "cpp", scheme: "file" }
];

export function isSourceFile(file: TextDocument) : boolean
{
    return (languages.match(SourceFileSelector, file) > 0);
}

export function isUnsavedSourceFile(file: TextDocument) : boolean
{
    if (!file.isDirty)
    {
        return false;
    }
    return isSourceFile(file);
}

export function isOpenSourceFile(uri: Uri) : boolean
{
    const file = workspace.textDocuments.find((file) => { return (file.uri.fsPath === uri.fsPath); });
    if (!file)
    {
        return false;
    }
    return isSourceFile(file);
}

export function jumpToLocation(uri: Uri, range: Range) : void
{
    const options: TextDocumentShowOptions = {selection: range};
    window.showTextDocument(uri, options);
}

export function setContext<T>(name: string, value: T) : void
{
    commands.executeCommand(VsCodeCommand.SetContext, name, value);
}

export function showContribution(name: string) : void
{
    setContext(name + ".visible", true);
}

export function hideContribution(name: string) : void
{
    setContext(name + ".visible", false);
}

export function showReferences(uri: Uri, position: Position, locations: Location[]) : void
{
    commands.executeCommand(VsCodeCommand.ShowReferences, uri, position, locations);
}
