'use strict';

import { commands, languages, window, workspace, CancellationToken, Definition, DefinitionProvider, Disposable, Hover,
         HoverProvider, Location, Position, ProviderResult, ReferenceContext, TextDocument, TypeDefinitionProvider,
         ImplementationProvider, Range, ReferenceProvider, RenameProvider, Uri, WorkspaceEdit } from 'vscode';

import { Nullable, RtagsSelector, isUnsavedSourceFile, fromRtagsLocation, toRtagsLocation, runRc } from './rtagsUtil';

enum ReferenceType
{
    Definition,
    References,
    Rename,
    Variables
}

function getLocations(args: string[]) : Thenable<Location[]>
{
    const processCallback =
        (output: string) : Location[] =>
        {
            let locations: Location[] = [];
            for (const loc of output.split('\n'))
            {
                if (loc)
                {
                    locations.push(fromRtagsLocation(loc));
                }
            }
            return locations;
        };

    return runRc(args, processCallback);
}

function getDefinitions(uri: Uri, position: Position, type: ReferenceType = ReferenceType.Definition) :
    Thenable<Location[]>
{
    const location = toRtagsLocation(uri, position);

    let args = ["--absolute-path", "--no-context"];

    switch (type)
    {
        case ReferenceType.Definition:
            args.push("--follow-location", location);
            break;

        case ReferenceType.References:
            args.push("--references", location);
            break;

        case ReferenceType.Rename:
            args.push("--rename", "--all-references", "--references", location);
            break;

        case ReferenceType.Variables:
        {
            const kinds = ["FieldDecl", "ParmDecl", "VarDecl", "MemberRef"];
            kinds.forEach((k) => { args.push("--kind-filter", k); });
            args.push("--references", location);
            break;
        }
    }

    return getLocations(args);
}

export class RtagsDefinitionProvider implements
    DefinitionProvider,
    TypeDefinitionProvider,
    ImplementationProvider,
    ReferenceProvider,
    RenameProvider,
    HoverProvider,
    Disposable
{
    constructor()
    {
        const showVariablesCallback =
            () : void =>
            {
                const editor = window.activeTextEditor;
                if (!editor)
                {
                    return;
                }

                const document = editor.document;
                const position = editor.selection.active;

                const resolveCallback =
                    (locations: Location[]) : void =>
                    {
                        commands.executeCommand("editor.action.showReferences",
                                                document.uri,
                                                position,
                                                locations);
                    };

                getDefinitions(document.uri, position, ReferenceType.Variables).then(resolveCallback);
            };

        this.disposables.push(
            languages.registerDefinitionProvider(RtagsSelector, this),
            languages.registerTypeDefinitionProvider(RtagsSelector, this),
            languages.registerImplementationProvider(RtagsSelector, this),
            languages.registerReferenceProvider(RtagsSelector, this),
            languages.registerRenameProvider(RtagsSelector, this),
            languages.registerHoverProvider(RtagsSelector, this),
            commands.registerCommand("rtags.showVariables", showVariablesCallback));
    }

    dispose() : void
    {
        for (let d of this.disposables)
        {
            d.dispose();
        }
    }

    provideDefinition(document: TextDocument, position: Position, _token: CancellationToken) :
        ProviderResult<Definition>
    {
        return getDefinitions(document.uri, position);
    }

    provideTypeDefinition(document: TextDocument, position: Position, _token: CancellationToken) :
        ProviderResult<Definition>
    {
        const location = toRtagsLocation(document.uri, position);

        const args =
        [
            "--json",
            "--absolute-path",
            "--no-context",
            "--symbol-info",
            location
        ];

        const processCallback =
            (output: string) : Nullable<string> =>
            {
                let jsonObj;
                try
                {
                    jsonObj = JSON.parse(output);
                }
                catch (_err)
                {
                    return null;
                }

                const symbolKind = jsonObj.kind;
                if (!symbolKind)
                {
                    return null;
                }
                const symbolKinds =
                [
                    "ClassDecl",
                    "StructDecl",
                    "UnionDecl",
                    "EnumDecl",
                    "FieldDecl",
                    "ParmDecl",
                    "VarDecl",
                    "TypeRef",
                    "MemberRefExpr",
                    "DeclRefExpr"
                ];
                if (!symbolKinds.includes(symbolKind))
                {
                    return null;
                }

                const qualSymbolType = jsonObj.type;
                if (!qualSymbolType)
                {
                    return null;
                }
                const unqualSymbolType = qualSymbolType.replace(/const|volatile|&|\*|(=>.*)$/g, "");
                return unqualSymbolType.trim();
            };

        const resolveCallback =
            (symbolType: Nullable<string>) : ProviderResult<Location[]> =>
            {
                if (!symbolType)
                {
                    return [];
                }

                const localArgs =
                [
                    "--absolute-path",
                    "--no-context",
                    "--find-symbols",
                    symbolType
                ];

                return getLocations(localArgs);
            };

        return runRc(args, processCallback).then(resolveCallback);
    }

    provideImplementation(document: TextDocument, position: Position, _token: CancellationToken) :
        ProviderResult<Definition>
    {
        return getDefinitions(document.uri, position);
    }

    provideReferences(document: TextDocument,
                      position: Position,
                      _context: ReferenceContext,
                      _token: CancellationToken) :
        ProviderResult<Location[]>
    {
        return getDefinitions(document.uri, position, ReferenceType.References);
    }

    provideRenameEdits(document: TextDocument, position: Position, newName: string, _token: CancellationToken) :
        ProviderResult<WorkspaceEdit>
    {
        const unsaved: boolean = workspace.textDocuments.some((doc) => { return isUnsavedSourceFile(doc); });
        if (unsaved)
        {
            window.showInformationMessage("[RTags] Save all source files before renaming a symbol");
            return null;
        }

        const wr = document.getWordRangeAtPosition(position);
        const diff = wr ? (wr.end.character - wr.start.character) : undefined;

        let edits: WorkspaceEdit = new WorkspaceEdit;

        const resolveCallback =
            (locations: Location[]) : WorkspaceEdit =>
            {
                for (const l of locations)
                {
                    const end = l.range.end.translate(0, diff);
                    edits.replace(l.uri, new Range(l.range.start, end), newName);
                }
                return edits;
            };

        return getDefinitions(document.uri, position, ReferenceType.Rename).then(resolveCallback);
    }

    provideHover(document: TextDocument, position: Position, _token: CancellationToken) : ProviderResult<Hover>
    {
        const location = toRtagsLocation(document.uri, position);

        const args =
        [
            "--absolute-path",
            "--follow-location",
            location
        ];

        const processCallback =
            (output: string) : string =>
            {
                let _unused: string = "";
                let definition: string = "";
                [_unused, definition] = output.split('\t', 2).map((token) => { return token.trim(); });
                return definition;
            };

        const resolveCallback =
            (definition: string) : Nullable<Hover> =>
            {
                // Hover text is not formatted properly unless a tab or 4 spaces are prepended
                return ((definition.length !== 0) ? new Hover('\t' + definition) : null);
            };

        return runRc(args, processCallback).then(resolveCallback);
    }

    private disposables: Disposable[] = [];
}
