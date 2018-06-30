'use strict';

import { languages, workspace, CancellationToken, Disposable, DocumentSymbolProvider, ProviderResult,
         SymbolInformation, SymbolKind, TextDocument, WorkspaceSymbolProvider } from 'vscode';

import { RtagsSelector, fromRtagsLocation, runRc } from './rtagsUtil';

function toSymbolKind(kind: string) : SymbolKind | undefined
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

function findSymbols(query: string, args: string[] = []) : Thenable<SymbolInformation[]>
{
    query += '*';

    const processCallback =
        (output: string) : SymbolInformation[] =>
        {
            let symbols: SymbolInformation[] = [];
            for (const line of output.split("\n"))
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

                const symbolInfo: SymbolInformation =
                {
                    name: name,
                    containerName: container,
                    location: location,
                    kind: <SymbolKind>localKind
                };
                symbols.push(symbolInfo);
            }
            return symbols;
        };

    args.push("--wildcard-symbol-names",
              "--absolute-path",
              "--containing-function",
              "--match-icase",
              "--find-symbols",
              query,
              "--cursor-kind",
              "--display-name");

    return runRc(args, processCallback);
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

        const args = ["--max", "30"];

        const folders = workspace.workspaceFolders;
        if (folders)
        {
            folders.forEach((f) => { args.push("--path-filter", f.uri.fsPath); });
        }

        return findSymbols(query, args);
    }

    private disposables: Disposable[] = [];
}
