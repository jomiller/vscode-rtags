'use strict';

import { languages, window, workspace, CancellationToken, Disposable, DocumentSymbolProvider, ProviderResult,
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
            for (const line of output.split('\n'))
            {
                let [location, name, kind, container] = line.split('\t', 4).map((token) => { return token.trim(); });
                if (!name)
                {
                    continue;
                }
                const localKind = toSymbolKind(kind);
                if (!localKind)
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
                    kind: localKind
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

    provideDocumentSymbols(document: TextDocument, _token: CancellationToken) : ProviderResult<SymbolInformation[]>
    {
        const args =
        [
            "--current-file",
            document.uri.fsPath,
            "--path-filter",
            document.uri.fsPath
        ];

        return findSymbols("", args);
    }

    provideWorkspaceSymbols(query: string, _token: CancellationToken) : ProviderResult<SymbolInformation[]>
    {
        if (query.length < 3)
        {
            return [];
        }

        let args = ["--max", "50"];

        const editor = window.activeTextEditor;
        if (editor)
        {
            const uri = editor.document.uri;

            args.push("--current-file", uri.fsPath);

            const folder = workspace.getWorkspaceFolder(uri);
            if (folder)
            {
                args.push("--path-filter", folder.uri.fsPath);
            }

            return findSymbols(query, args);
        }

        const processCallback =
            (output: string) : string =>
            {
                return output.trim();
            };

        const resolveCallback =
            (projectPath: string) : Thenable<SymbolInformation[]> =>
            {
                args.push("--path-filter", projectPath);

                return findSymbols(query, args);
            };

        return runRc(["--current-project"], processCallback).then(resolveCallback);
    }

    private disposables: Disposable[] = [];
}
