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
    query += '*';

    const processCallback =
        (output: string) : SymbolInformation[] =>
        {
            let symbols: SymbolInformation[] = [];
            for (const line of output.split('\n'))
            {
                let [location, name, kind, container] = line.split('\t', 4).map((tok) => { return tok.trim(); });
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

    args.push("--absolute-path",
              "--no-context",
              "--display-name",
              "--cursor-kind",
              "--containing-function",
              "--wildcard-symbol-names",
              "--match-icase",
              "--find-symbols",
              query);

    return runRc(args, processCallback);
}

async function findWorkspaceSymbols(query: string, projectPaths: Uri[]) : Promise<SymbolInformation[]>
{
    let workspaceSymbols: SymbolInformation[] = [];

    const config = workspace.getConfiguration("rtags");
    const maxSearchResults: number = config.get("maxWorkspaceSearchResults", 50);

    for (const path of projectPaths)
    {
        const args =
        [
            "--filter-system-headers",
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
        for (let d of this.disposables)
        {
            d.dispose();
        }
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
            "--filter-system-headers",
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

        return findWorkspaceSymbols(query, this.rtagsMgr.getProjectPaths());
    }

    private rtagsMgr: RtagsManager;
    private disposables: Disposable[] = [];
}
