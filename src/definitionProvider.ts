'use strict';

import { commands, languages, window, workspace, CancellationToken, Definition, DefinitionProvider, Disposable, Hover,
         HoverProvider, Location, Position, ProviderResult, ReferenceContext, TextDocument, TypeDefinitionProvider,
         ImplementationProvider, Range, ReferenceProvider, RenameProvider, WorkspaceEdit } from 'vscode';

import { Nullable, RtagsSelector, isUnsavedSourceFile, fromRtagsLocation, toRtagsLocation, runRc } from './rtagsUtil';

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
            try
            {
                for (const loc of output.split('\n'))
                {
                    if (!loc)
                    {
                        continue;
                    }
                    locations.push(fromRtagsLocation(loc));
                }
            }
            catch (_err)
            {
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
            if (editor)
            {
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
            }
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
            "--symbol-info",
            location
        ];

        const processCallback =
            (output: string) : Nullable<string> =>
            {
                const jsonObj = JSON.parse(output);

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
                let definition: string = "";
                try
                {
                    let _unused: string = "";
                    [_unused, definition] = output.split('\t', 2).map((token) => { return token.trim(); });
                }
                catch (_err)
                {
                }
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
