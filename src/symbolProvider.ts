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

'use strict';

import { languages, workspace, CancellationToken, Disposable, DocumentSymbolProvider, ProviderResult,
         SymbolInformation, SymbolKind, TextDocument, Uri, WorkspaceSymbolProvider } from 'vscode';

import { RtagsManager, runRc } from './rtagsManager';

import { Optional, SourceFileSelector, fromRtagsLocation } from './rtagsUtil';

function toSymbolKind(kind: string) : Optional<SymbolKind>
{
    switch (kind)
    {
        case "Namespace":
            return SymbolKind.Namespace;

        case "ClassDecl":
            return SymbolKind.Class;

        case "StructDecl":
        case "UnionDecl":
            return SymbolKind.Struct;

        case "EnumDecl":
            return SymbolKind.Enum;

        case "EnumConstantDecl":
            return SymbolKind.EnumMember;

        case "TemplateTypeParameter":
            return SymbolKind.TypeParameter;

        case "CXXConstructor":
        case "CXXDestructor":
            return SymbolKind.Constructor;

        case "CXXMethod":
            return SymbolKind.Method;

        case "FunctionDecl":
            return SymbolKind.Function;

        case "FieldDecl":
            return SymbolKind.Field;

        case "ParmDecl":
        case "VarDecl":
            return SymbolKind.Variable;
    }

    return undefined;
}

function findSymbols(query: string, args: string[] = []) : Thenable<Optional<SymbolInformation[]>>
{
    let regexQuery = "";
    if (query.length !== 0)
    {
        // Escape special characters that have meaning within regular expressions
        regexQuery = query.replace(/([(){}\[\].*+?|$\^\\])/g, "\\$1");

        // Filter out results for function local variables
        regexQuery += "(?!.*\\)::)";
    }

    args.push("--filter-system-headers",
              "--absolute-path",
              "--no-context",
              "--display-name",
              "--cursor-kind",
              "--containing-function",
              "--match-regexp",
              "--match-icase",
              "--find-symbols",
              regexQuery);

    const processCallback =
        (output: string) : SymbolInformation[] =>
        {
            let symbols: SymbolInformation[] = [];
            for (const line of output.split('\n'))
            {
                let [location, name, kind, container] = line.split(/\t+/, 4).map((tok) => { return tok.trim(); });
                if (!name)
                {
                    continue;
                }
                const symbolKind = toSymbolKind(kind);
                if (!symbolKind)
                {
                    continue;
                }
                if (container)
                {
                    container = container.replace(/^function: /, "");
                }

                const symbolInfo: SymbolInformation =
                {
                    name: name,
                    containerName: container,
                    location: fromRtagsLocation(location),
                    kind: symbolKind
                };
                symbols.push(symbolInfo);
            }
            return symbols;
        };

    return runRc(args, processCallback);
}

async function findWorkspaceSymbols(query: string, projectPaths: Uri[]) : Promise<SymbolInformation[]>
{
    let workspaceSymbols: SymbolInformation[] = [];

    for (const path of projectPaths)
    {
        const config = workspace.getConfiguration("rtags", path);
        const maxSearchResults = config.get<number>("misc.maxWorkspaceSearchResults", 50);

        const args =
        [
            "--max",
            maxSearchResults.toString(),
            "--project",
            path.fsPath,
            "--path-filter",
            path.fsPath
        ];

        const symbols = await findSymbols(query, args);
        if (symbols)
        {
            workspaceSymbols.push(...symbols);
        }
    }

    return workspaceSymbols;
}

export class RtagsSymbolProvider implements
    DocumentSymbolProvider,
    WorkspaceSymbolProvider,
    Disposable
{
    constructor(rtagsMgr: RtagsManager)
    {
        this.rtagsMgr = rtagsMgr;

        this.disposables.push(
            languages.registerDocumentSymbolProvider(SourceFileSelector, this),
            languages.registerWorkspaceSymbolProvider(this));
    }

    public dispose() : void
    {
        this.disposables.forEach((d) => { d.dispose(); });
    }

    public provideDocumentSymbols(document: TextDocument, _token: CancellationToken) :
        ProviderResult<SymbolInformation[]>
    {
        if (!this.rtagsMgr.isInProject(document.uri))
        {
            return [];
        }

        const args =
        [
            "--current-file",
            document.uri.fsPath,
            "--path-filter",
            document.uri.fsPath
        ];

        return findSymbols("", args);
    }

    public provideWorkspaceSymbols(query: string, _token: CancellationToken) : ProviderResult<SymbolInformation[]>
    {
        return findWorkspaceSymbols(query, this.rtagsMgr.getProjectPaths());
    }

    private rtagsMgr: RtagsManager;
    private disposables: Disposable[] = [];
}
