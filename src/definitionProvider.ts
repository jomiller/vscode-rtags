'use strict';

import { commands, languages, window, CancellationToken, Definition, DefinitionProvider, Disposable, Hover,
         HoverProvider, Location, Position, ProviderResult, ReferenceContext, TextDocument, TypeDefinitionProvider,
         ImplementationProvider, Range, ReferenceProvider, RenameProvider, TextEditor, TextEditorEdit, Uri,
         WorkspaceEdit } from 'vscode';

import { RtagsManager, runRc } from './rtagsManager';

import { Nullable, RtagsDocSelector, isUnsavedSourceFile, showReferences, fromRtagsLocation, toRtagsLocation }
         from './rtagsUtil';

enum ReferenceType
{
    Definition,
    References,
    Rename,
    Variables,
    Virtuals
}

function getLocations(args: string[]) : Thenable<Location[]>
{
    const processCallback =
        (output: string) : Location[] =>
        {
            let locations: Location[] = [];
            for (const loc of output.split('\n'))
            {
                if (loc.trim().length !== 0)
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

        case ReferenceType.Virtuals:
            args.push("--find-virtuals", "--references", location);
            break;
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
    constructor(rtagsMgr: RtagsManager)
    {
        this.rtagsMgr = rtagsMgr;

        const makeReferencesCallback =
            (type: ReferenceType) : (textEditor: TextEditor, edit: TextEditorEdit) => void =>
            {
                const callback =
                    (textEditor: TextEditor, _edit: TextEditorEdit) : void =>
                    {
                        const document = textEditor.document;
                        const position = textEditor.selection.active;

                        if (!this.rtagsMgr.isInProject(document.uri))
                        {
                            return;
                        }

                        const resolveCallback =
                            (locations: Location[]) : void =>
                            {
                                showReferences(document.uri, position, locations);
                            };

                        getDefinitions(document.uri, position, type).then(resolveCallback);
                    };

                return callback;
            };

        this.disposables.push(
            languages.registerDefinitionProvider(RtagsDocSelector, this),
            languages.registerTypeDefinitionProvider(RtagsDocSelector, this),
            languages.registerImplementationProvider(RtagsDocSelector, this),
            languages.registerReferenceProvider(RtagsDocSelector, this),
            languages.registerRenameProvider(RtagsDocSelector, this),
            languages.registerHoverProvider(RtagsDocSelector, this),
            commands.registerTextEditorCommand("rtags.showVariables",
                                               makeReferencesCallback(ReferenceType.Variables)),
            commands.registerTextEditorCommand("rtags.showVirtuals",
                                               makeReferencesCallback(ReferenceType.Virtuals)));
    }

    public dispose() : void
    {
        for (let d of this.disposables)
        {
            d.dispose();
        }
    }

    public provideDefinition(document: TextDocument, position: Position, _token: CancellationToken) :
        ProviderResult<Definition>
    {
        if (!this.rtagsMgr.isInProject(document.uri))
        {
            return null;
        }

        return getDefinitions(document.uri, position);
    }

    public provideTypeDefinition(document: TextDocument, position: Position, _token: CancellationToken) :
        ProviderResult<Definition>
    {
        if (!this.rtagsMgr.isInProject(document.uri))
        {
            return null;
        }

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
                    "MemberRef",
                    "VariableRef",
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
                    "--definition-only",
                    "--find-symbols",
                    symbolType
                ];

                return getLocations(localArgs);
            };

        return runRc(args, processCallback).then(resolveCallback);
    }

    public provideImplementation(document: TextDocument, position: Position, _token: CancellationToken) :
        ProviderResult<Definition>
    {
        if (!this.rtagsMgr.isInProject(document.uri))
        {
            return null;
        }

        return getDefinitions(document.uri, position);
    }

    public provideReferences(document: TextDocument,
                             position: Position,
                             _context: ReferenceContext,
                             _token: CancellationToken) :
        ProviderResult<Location[]>
    {
        if (!this.rtagsMgr.isInProject(document.uri))
        {
            return [];
        }

        return getDefinitions(document.uri, position, ReferenceType.References);
    }

    public provideRenameEdits(document: TextDocument,
                              position: Position,
                              newName: string,
                              _token: CancellationToken) :
        ProviderResult<WorkspaceEdit>
    {
        if (!this.rtagsMgr.isInProject(document.uri))
        {
            return null;
        }

        const unsavedDocFound: boolean =
            this.rtagsMgr.getTextDocuments().some((doc) => { return isUnsavedSourceFile(doc); });

        if (unsavedDocFound)
        {
            window.showInformationMessage("[RTags] Save all source files before renaming a symbol");
            return null;
        }

        const wr = document.getWordRangeAtPosition(position);
        const diff = wr ? (wr.end.character - wr.start.character) : undefined;

        let edit = new WorkspaceEdit();

        const resolveCallback =
            (locations: Location[]) : WorkspaceEdit =>
            {
                for (const l of locations)
                {
                    const end = l.range.end.translate(0, diff);
                    edit.replace(l.uri, new Range(l.range.start, end), newName);
                }
                return edit;
            };

        return getDefinitions(document.uri, position, ReferenceType.Rename).then(resolveCallback);
    }

    public provideHover(document: TextDocument, position: Position, _token: CancellationToken) : ProviderResult<Hover>
    {
        if (!this.rtagsMgr.isInProject(document.uri))
        {
            return null;
        }

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
                [_unused, definition] = output.split('\t', 2).map((tok) => { return tok.trim(); });
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

    private rtagsMgr: RtagsManager;
    private disposables: Disposable[] = [];
}
