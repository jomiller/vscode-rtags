'use strict';

import { languages, window, workspace, CancellationToken, Disposable, DocumentSymbolProvider, ProviderResult,
         SymbolInformation, SymbolKind, TextDocument, Uri, WorkspaceSymbolProvider } from 'vscode';

import { RtagsManager, runRc } from './rtagsManager';

import { SourceFileSelector, fromRtagsLocation } from './rtagsUtil';

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

        let args = ["--filter-system-headers", "--max"];
        let maxSearchResults = 50;

        const editor = window.activeTextEditor;
        if (editor)
        {
            // Find symbols in the project to which the active document belongs

            const activeDocPath = editor.document.uri;

            const projectPath = this.rtagsMgr.getProjectPath(activeDocPath);
            if (!projectPath)
            {
                return [];
            }

            const config = workspace.getConfiguration("rtags", activeDocPath);
            maxSearchResults = config.get("maxWorkspaceSearchResults", maxSearchResults);

            args.push(maxSearchResults.toString(),
                      "--current-file",
                      activeDocPath.fsPath,
                      "--path-filter",
                      projectPath.fsPath);

            return findSymbols(query, args);
        }

        // Find symbols in the current project

        const resolveCallback =
            (projectPath?: Uri) : Thenable<SymbolInformation[]> =>
            {
                if (!projectPath)
                {
                    return Promise.resolve([]);
                }

                args.push(maxSearchResults.toString(),
                          "--project",
                          projectPath.fsPath,
                          "--path-filter",
                          projectPath.fsPath);

                return findSymbols(query, args);
            };

        return this.rtagsMgr.getCurrentProjectPath().then(resolveCallback);
    }

    private rtagsMgr: RtagsManager;
    private disposables: Disposable[] = [];
}
