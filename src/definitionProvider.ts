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

'use strict';

import { commands, languages, window, CancellationToken, Definition, DefinitionProvider, Disposable, Hover,
         HoverProvider, Location, Position, ProviderResult, ReferenceContext, TextDocument, TypeDefinitionProvider,
         ImplementationProvider, Range, ReferenceProvider, RenameProvider, TextEditor, TextEditorEdit, Uri,
         WorkspaceEdit } from 'vscode';

import { RtagsManager, runRc } from './rtagsManager';

import { Optional, SourceFileSelector, isUnsavedSourceFile, showReferences, fromRtagsLocation, toRtagsLocation,
         parseJson } from './rtagsUtil';

enum ReferenceType
{
    Definition,
    References,
    Rename,
    Variables,
    Virtuals
}

function getLocations(args: string[]) : Thenable<Optional<Location[]>>
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
    Thenable<Optional<Location[]>>
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
                            (locations?: Location[]) : void =>
                            {
                                if (locations)
                                {
                                    showReferences(document.uri, position, locations);
                                }
                            };

                        getDefinitions(document.uri, position, type).then(resolveCallback);
                    };

                return callback;
            };

        this.disposables.push(
            languages.registerDefinitionProvider(SourceFileSelector, this),
            languages.registerTypeDefinitionProvider(SourceFileSelector, this),
            languages.registerImplementationProvider(SourceFileSelector, this),
            languages.registerReferenceProvider(SourceFileSelector, this),
            languages.registerRenameProvider(SourceFileSelector, this),
            languages.registerHoverProvider(SourceFileSelector, this),
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
            return undefined;
        }

        return getDefinitions(document.uri, position);
    }

    public provideTypeDefinition(document: TextDocument, position: Position, _token: CancellationToken) :
        ProviderResult<Definition>
    {
        if (!this.rtagsMgr.isInProject(document.uri))
        {
            return undefined;
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
            (output: string) : Optional<string> =>
            {
                const jsonObj = parseJson(output);
                if (!jsonObj)
                {
                    return undefined;
                }

                const symbolKind = jsonObj.kind;
                if (!symbolKind)
                {
                    return undefined;
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
                    return undefined;
                }

                const symbolType = jsonObj.type;
                if (!symbolType)
                {
                    return undefined;
                }

                const decaySymbolType = symbolType.replace(/const|volatile|&|\*|(=>.*)$/g, "");
                return decaySymbolType.trim();
            };

        const resolveCallback =
            (symbolType?: string) : ProviderResult<Location[]> =>
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
            return undefined;
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
            return undefined;
        }

        const unsavedDocExists: boolean =
            this.rtagsMgr.getTextDocuments().some((doc) => { return isUnsavedSourceFile(doc); });

        if (unsavedDocExists)
        {
            window.showInformationMessage("[RTags] Save all source files before renaming a symbol");
            return undefined;
        }

        const wr = document.getWordRangeAtPosition(position);
        const diff = wr ? (wr.end.character - wr.start.character) : undefined;

        const resolveCallback =
            (locations?: Location[]) : WorkspaceEdit =>
            {
                let edit = new WorkspaceEdit();
                if (locations)
                {
                    for (const loc of locations)
                    {
                        const end = loc.range.end.translate(0, diff);
                        edit.replace(loc.uri, new Range(loc.range.start, end), newName);
                    }
                }
                return edit;
            };

        return getDefinitions(document.uri, position, ReferenceType.Rename).then(resolveCallback);
    }

    public provideHover(document: TextDocument, position: Position, _token: CancellationToken) : ProviderResult<Hover>
    {
        if (!this.rtagsMgr.isInProject(document.uri))
        {
            return undefined;
        }

        const location = toRtagsLocation(document.uri, position);

        const args =
        [
            "--absolute-path",
            "--follow-location",
            location
        ];

        const processCallback =
            (output: string) : Optional<Hover> =>
            {
                if (!output)
                {
                    return undefined;
                }

                let [_unused, context] = output.split('\t', 2).map((tok) => { return tok.trim(); });
                _unused = _unused;

                if (!context)
                {
                    return undefined;
                }

                // Hover text is not formatted properly unless a tab or 4 spaces are prepended
                return new Hover('\t' + context);
            };

        return runRc(args, processCallback);
    }

    private rtagsMgr: RtagsManager;
    private disposables: Disposable[] = [];
}
