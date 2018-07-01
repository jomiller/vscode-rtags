'use strict';

import { commands, languages, window, workspace, CancellationToken, Definition, DefinitionProvider, Disposable, Hover,
         HoverProvider, Location, Position, ProviderResult, ReferenceContext, TextDocument, TypeDefinitionProvider,
         ImplementationProvider, Range, ReferenceProvider, RenameProvider, WorkspaceEdit } from 'vscode';

import { Nullable, RtagsSelector, isUnsavedSourceFile, fromRtagsLocation, toRtagsLocation, jumpToLocation, runRc }
         from './rtagsUtil';

enum ReferenceType
{
    Definition,
    References,
    Rename,
    Variables
}

function getLocations(args: string[], document: TextDocument) : Thenable<Location[]>
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

    return runRc(args, processCallback, document);
}

function getDefinitions(document: TextDocument, position: Position, type: ReferenceType = ReferenceType.Definition) :
    Thenable<Location[]>
{
    const location = toRtagsLocation(document.uri, position);

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

    return getLocations(args, document);
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
                let promise = getDefinitions(document, position, ReferenceType.Variables);

                promise.then(
                    (locations: Location[]) : void =>
                    {
                        commands.executeCommand("editor.action.showReferences",
                                                document.uri,
                                                position,
                                                locations);
                    });
            };

        const showBaseClassesCallback =
            () : void =>
            {
                const editor = window.activeTextEditor;
                if (!editor)
                {
                    return;
                }

                const document = editor.document;
                const position = editor.selection.active;

                const location = toRtagsLocation(document.uri, position);

                const args =
                [
                    "--absolute-path",
                    "--no-context",
                    "--class-hierarchy",
                    location
                ];

                const processCallback =
                    (output: string) : Location[] =>
                    {
                        let locations: Location[] = [];

                        const lines = output.split('\n');
                        const baseIndex = lines.indexOf("Superclasses:");
                        if (baseIndex !== -1)
                        {
                            const startIndex = baseIndex + 2;
                            const derivedIndex = lines.indexOf("Subclasses:");
                            const endIndex = (derivedIndex === -1) ? (lines.length - 1) : (derivedIndex - 1);
                            for (let i = startIndex; i <= endIndex; ++i)
                            {
                                const base = lines[i].match(/^ {4}\w.*/);
                                if (base)
                                {
                                    let [_unused, location] =
                                        base[0].split('\t', 2).map((token) => { return token.trim(); });
                                    _unused = _unused;
                                    locations.push(fromRtagsLocation(location));
                                }
                            }
                        }

                        return locations;
                    };

                const resolveCallback =
                    (locations: Location[]) : void =>
                    {
                        if (locations.length === 1)
                        {
                            jumpToLocation(document.uri, locations[0].range);
                        }
                        else
                        {
                            commands.executeCommand("editor.action.showReferences",
                                                    document.uri,
                                                    position,
                                                    locations);
                        }
                    };

                runRc(args, processCallback, document).then(resolveCallback);
            };

        this.disposables.push(
            languages.registerDefinitionProvider(RtagsSelector, this),
            languages.registerTypeDefinitionProvider(RtagsSelector, this),
            languages.registerImplementationProvider(RtagsSelector, this),
            languages.registerReferenceProvider(RtagsSelector, this),
            languages.registerRenameProvider(RtagsSelector, this),
            languages.registerHoverProvider(RtagsSelector, this),
            commands.registerCommand("rtags.showVariables", showVariablesCallback),
            commands.registerCommand("rtags.showBaseClasses", showBaseClassesCallback));
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
        return getDefinitions(document, position);
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

                return getLocations(localArgs, document);
            };

        return runRc(args, processCallback, document).then(resolveCallback);
    }

    provideImplementation(document: TextDocument, position: Position, _token: CancellationToken) :
        ProviderResult<Definition>
    {
        return getDefinitions(document, position);
    }

    provideReferences(document: TextDocument,
                    position: Position,
                    _context: ReferenceContext,
                    _token: CancellationToken) :
        ProviderResult<Location[]>
    {
        return getDefinitions(document, position, ReferenceType.References);
    }

    provideRenameEdits(document: TextDocument, position: Position, newName: string, _token: CancellationToken) :
        ProviderResult<WorkspaceEdit>
    {
        const unsaved: boolean = workspace.textDocuments.some((doc) => { return isUnsavedSourceFile(doc); });
        if (unsaved)
        {
            window.showInformationMessage("[RTags] Save all source files first before renaming");
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

        return getDefinitions(document, position, ReferenceType.Rename).then(resolveCallback);
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

        return runRc(args, processCallback, document).then(resolveCallback);
    }

    private disposables: Disposable[] = [];
}
