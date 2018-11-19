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
         SymbolInformation, SymbolKind, TextDocument, WorkspaceSymbolProvider } from 'vscode';

import { RtagsManager, runRc } from './rtagsManager';

import { Optional, SourceFileSelector, fromRtagsLocation } from './rtagsUtil';

function toSymbolKind(kind: string) : Optional<SymbolKind>
{
    switch (kind)
    {
        case "Namespace":
            return SymbolKind.Namespace;

        case "ClassDecl":
        case "ClassTemplate":
        case "ClassTemplatePartialSpecialization":
        case "TypedefDecl":
        case "TypeAliasDecl":
        case "TypeAliasTemplateDecl":
            return SymbolKind.Class;

        case "StructDecl":
        case "UnionDecl":
            return SymbolKind.Struct;

        case "EnumDecl":
            return SymbolKind.Enum;

        case "EnumConstantDecl":
            return SymbolKind.EnumMember;

        case "TemplateTypeParameter":
        case "TemplateTemplateParameter":
            return SymbolKind.TypeParameter;

        case "CXXConstructor":
        case "CXXDestructor":
            return SymbolKind.Constructor;

        case "CXXMethod":
            return SymbolKind.Method;

        case "FunctionDecl":
        case "FunctionTemplate":
            return SymbolKind.Function;

        case "FieldDecl":
            return SymbolKind.Field;

        case "ParmDecl":
        case "VarDecl":
        case "NonTypeTemplateParameter":
            return SymbolKind.Variable;
    }

    return undefined;
}

function findSymbols(query: string, args: string[] = []) : Promise<Optional<SymbolInformation[]>>
{
    args.push("--filter-system-headers",
              "--absolute-path",
              "--no-context",
              "--display-name",
              "--cursor-kind",
              "--containing-function",
              "--strip-paren",
              "--wildcard-symbol-names",
              "--match-icase",
              "--find-symbols",
              query + '*');

    const processCallback =
        (output: string) : SymbolInformation[] =>
        {
            let symbols: SymbolInformation[] = [];

            for (const line of output.split('\n'))
            {
                if (line.trim().length === 0)
                {
                    continue;
                }
                let [loc, name, kind, container] = line.split(/\t+/, 4).map((tok) => { return tok.trim(); });
                const location = fromRtagsLocation(loc);
                let symbolKind: Optional<SymbolKind> = undefined;
                if (!name)
                {
                    if (query.length === 0)
                    {
                        continue;
                    }
                    name = location.uri.fsPath;
                    symbolKind = SymbolKind.File;
                    container = name;
                }
                else
                {
                    symbolKind = toSymbolKind(kind);
                    if (!symbolKind)
                    {
                        continue;
                    }
                    if (container)
                    {
                        container = container.replace(/^function: /, "");
                    }
                }

                const symbolInfo: SymbolInformation =
                {
                    name: name,
                    containerName: container,
                    location: location,
                    kind: symbolKind
                };
                symbols.push(symbolInfo);
            }

            return symbols;
        };

    return runRc(args, processCallback);
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
        if (query.length < 3)
        {
            return [];
        }

        if (query.length > 3)
        {
            return this.findWorkspaceSymbols('*' + query);
        }

        const resolveCallback =
            (symbols: SymbolInformation[]) : Promise<SymbolInformation[]> =>
            {
                if (symbols.length !== 0)
                {
                    return Promise.resolve(symbols);
                }

                return this.findWorkspaceSymbols('*' + query);
            };

        return this.findWorkspaceSymbols(query).then(resolveCallback);
    }

    private async findWorkspaceSymbols(query: string) : Promise<SymbolInformation[]>
    {
        let workspaceSymbols: SymbolInformation[] = [];

        for (const path of this.rtagsMgr.getProjectPaths())
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

    private rtagsMgr: RtagsManager;
    private disposables: Disposable[] = [];
}
