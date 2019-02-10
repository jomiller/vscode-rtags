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

import { languages, workspace, CancellationToken, Disposable, DocumentSymbolProvider, ProviderResult,
         SymbolInformation, SymbolKind, TextDocument, WorkspaceSymbolProvider } from 'vscode';

import { ConfigurationId, ResourceConfiguration } from './constants';

import { RtagsManager } from './rtagsManager';

import { Optional } from './nodeUtil';

import { SourceFileSelector } from './vscodeUtil';

import { getRtagsRealPathArgument, getRtagsProjectPathArgument, fromRtagsLocation, runRc } from './rtagsUtil';

function toSymbolKind(kind: string) : Optional<SymbolKind>
{
    switch (kind)
    {
        case "Namespace":
        case "NamespaceAlias":
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
        case "CXXConversion":
            return SymbolKind.Method;

        case "FunctionDecl":
        case "FunctionTemplate":
        case "macro definition":
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

function findSymbols(query: string, args: string[] = [], includeFiles: boolean = false) :
    Promise<Optional<SymbolInformation[]>>
{
    const localArgs =
    [
        "--find-symbols",
        query,
        "--wildcard-symbol-names",
        "--match-icase",
        "--strip-paren",
        "--filter-system-headers",
        "--absolute-path",
        "--no-context",
        "--display-name",
        "--cursor-kind",
        "--containing-function"
    ];

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
                    if (!includeFiles)
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
                    if (symbolKind === undefined)
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

    return runRc(args.concat(localArgs), processCallback);
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
            getRtagsRealPathArgument(),
            "--current-file",
            document.uri.fsPath,
            "--path-filter",
            document.uri.fsPath
        ];

        return findSymbols('*', args);
    }

    public provideWorkspaceSymbols(query: string, _token: CancellationToken) : ProviderResult<SymbolInformation[]>
    {
        if (query.length < 3)
        {
            return [];
        }

        if (query.length > 3)
        {
            return this.findWorkspaceSymbols('*' + query + '*');
        }

        const resolveCallback =
            (symbols: SymbolInformation[]) : Promise<SymbolInformation[]> =>
            {
                if (symbols.length !== 0)
                {
                    return Promise.resolve(symbols);
                }

                return this.findWorkspaceSymbols('*' + query + '*');
            };

        return this.findWorkspaceSymbols(query + '*').then(resolveCallback);
    }

    private async findWorkspaceSymbols(query: string) : Promise<SymbolInformation[]>
    {
        let workspaceSymbols: SymbolInformation[] = [];

        for (const path of this.rtagsMgr.getProjectPaths())
        {
            const projectPath = getRtagsProjectPathArgument(path);
            const config = workspace.getConfiguration(ConfigurationId, path);
            const maxSearchResults = config.get<number>(ResourceConfiguration.MiscMaxWorkspaceSearchResults, 50);

            const args =
            [
                getRtagsRealPathArgument(),
                "--project",
                projectPath,
                "--path-filter",
                projectPath,
                "--max",
                maxSearchResults.toString()
            ];

            const symbols = await findSymbols(query, args, true);
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
