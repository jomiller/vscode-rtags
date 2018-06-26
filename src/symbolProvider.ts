'use strict';

import { languages, CancellationToken, Disposable, DocumentSymbolProvider, ProviderResult, SymbolInformation,
         SymbolKind, TextDocument, WorkspaceSymbolProvider } from 'vscode';

import { RtagsSelector, fromRtagsLocation, runRc } from './rtagsUtil';

function toSymbolKind(kind: string) : SymbolKind | undefined
{
    switch (kind)
    {
        case "Namespace":
            return SymbolKind.Namespace;

        case "EnumDecl":
            return SymbolKind.Enum;

        case "EnumConstantDecl":
            return SymbolKind.EnumMember;

        case "ClassDecl":
        case "StructDecl":
            return SymbolKind.Class;

        case "CXXConstructor":
            return SymbolKind.Constructor;

        case "CXXDestructor":
            return SymbolKind.Constructor;

        case "CXXMethod":
            return SymbolKind.Method;

        case "FunctionDecl":
            return SymbolKind.Function;

        case "FieldDecl":
            return SymbolKind.Field;

        case "ParmDecl":
            return SymbolKind.Variable;

        case "VarDecl":
            return SymbolKind.Variable;
    }

    return undefined;
}

function findSymbols(query: string, args: string[] = []) : Thenable<SymbolInformation[]>
{
    query += '*';

    let process =
        (output: string) : SymbolInformation[] =>
        {
            let result: SymbolInformation[] = [];
            for (let line of output.split("\n"))
            {
                let [path, _unused, name, kind, container] = line.split(/\t+/);
                _unused = _unused;
                if (!name)
                {
                    continue;
                }
                const localKind = toSymbolKind(kind);
                if (!localKind)
                {
                    continue;
                }
                const location = fromRtagsLocation(path);

                let symbolInfo: SymbolInformation =
                {
                    name: name,
                    containerName: container,
                    location: location,
                    kind: <SymbolKind>localKind
                };
                result.push(symbolInfo);
            }
            return result;
        };

    args.push("--wildcard-symbol-names",
              "--absolute-path",
              "--containing-function",
              "--match-icase",
              "--find-symbols",
              query,
              "--cursor-kind",
              "--display-name");

    return runRc(args, process);
}

export class RtagsSymbolProvider implements
    DocumentSymbolProvider,
    WorkspaceSymbolProvider,
    Disposable
{
    constructor()
    {
        this.disposables.push(
            languages.registerDocumentSymbolProvider(RtagsSelector, this),
            languages.registerWorkspaceSymbolProvider(this));
    }

    dispose() : void
    {
        for (let d of this.disposables)
        {
            d.dispose();
        }
    }

    provideDocumentSymbols(doc: TextDocument, _token: CancellationToken) : ProviderResult<SymbolInformation[]>
    {
        return findSymbols("", ["--path-filter", doc.uri.fsPath]);
    }

    provideWorkspaceSymbols(query: string, _token: CancellationToken) : ProviderResult<SymbolInformation[]>
    {
        if (query.length < 3)
        {
            return [];
        }
        return findSymbols(query, ["--max", "30"]);
    }

    private disposables: Disposable[] = [];
}
