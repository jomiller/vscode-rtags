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
    Virtuals
}

function getBaseSymbolType(symbolType: string, scoped: boolean, isConstructor: boolean) : string
{
    let pattern = "";
    if (isConstructor)
    {
        if (scoped)
        {
            pattern += "::~?\\w+";
        }
        pattern += "\\(.*";
    }
    else
    {
        pattern += "const|volatile|&|\\*|(=>.*)$";
    }
    if (!scoped)
    {
        pattern += "|((\\w+::~?)+)";
    }
    const baseSymbolRegex = new RegExp(pattern, "g");
    const baseSymbolType = symbolType.replace(baseSymbolRegex, "");
    return baseSymbolType.trim();
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

        case ReferenceType.Virtuals:
            args.push("--find-virtuals", "--references", location);
            break;
    }

    return getLocations(args);
}

function getTypeDefinitions(document: TextDocument,
                            position: Position,
                            typeSymbolKinds: string[],
                            scoped: boolean) :
    Thenable<Optional<Location[]>>
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

            if ((symbolKind === "CXXConstructor") || (symbolKind === "CXXDestructor"))
            {
                const symbolName = jsonObj.symbolName;
                if (!symbolName)
                {
                    return undefined;
                }
                return getBaseSymbolType(symbolName, scoped, true);
            }

            const symbolKinds =
            [
                "ClassDecl",
                "StructDecl",
                "UnionDecl",
                "EnumDecl",
                "TypedefDecl",
                "TypeAliasDecl",
                "TypeAliasTemplateDecl",
                "FieldDecl",
                "ParmDecl",
                "VarDecl",
                "TypeRef",
                "MemberRef",
                "VariableRef",
                "CallExpr",
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

            return getBaseSymbolType(symbolType, scoped, false);
        };

    const resolveCallback =
        (symbolType?: string) : Thenable<Optional<Location[]>> =>
        {
            if (!symbolType)
            {
                return Promise.resolve([] as Location[]);
            }

            let localArgs =
            [
                "--absolute-path",
                "--no-context",
                "--find-symbols",
                symbolType
            ];

            if (scoped)
            {
                localArgs.push("--definition-only");
            }

            typeSymbolKinds.forEach((k) => { localArgs.push("--kind-filter", k); });

            return getLocations(localArgs);
        };

    return runRc(args, processCallback).then(resolveCallback);
}

async function getVariables(document: TextDocument, position: Position) : Promise<Location[]>
{
    const symbolKinds = ["CXXConstructor"];

    const constructorLocations = await getTypeDefinitions(document, position, symbolKinds, false);
    if (!constructorLocations)
    {
        return [];
    }

    let variableLocations: Location[] = [];

    for (const loc of constructorLocations)
    {
        const locations = await getDefinitions(loc.uri, loc.range.start, ReferenceType.References);
        if (locations)
        {
            variableLocations.push(...locations);
        }
    }

    return variableLocations;
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

        const showVariablesCallback =
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

                getVariables(document, position).then(resolveCallback);
            };

        const showVirtualsCallback =
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
                        if (!locations)
                        {
                            locations = [];
                        }
                        showReferences(document.uri, position, locations);
                    };

                getDefinitions(document.uri, position, ReferenceType.Virtuals).then(resolveCallback);
            };

        this.disposables.push(
            languages.registerDefinitionProvider(SourceFileSelector, this),
            languages.registerTypeDefinitionProvider(SourceFileSelector, this),
            languages.registerImplementationProvider(SourceFileSelector, this),
            languages.registerReferenceProvider(SourceFileSelector, this),
            languages.registerRenameProvider(SourceFileSelector, this),
            languages.registerHoverProvider(SourceFileSelector, this),
            commands.registerTextEditorCommand("rtags.showVariables", showVariablesCallback),
            commands.registerTextEditorCommand("rtags.showVirtuals", showVirtualsCallback));
    }

    public dispose() : void
    {
        this.disposables.forEach((d) => { d.dispose(); });
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

        const symbolKinds =
        [
            "ClassDecl",
            "StructDecl",
            "UnionDecl",
            "EnumDecl",
            "TypedefDecl",
            "TypeAliasDecl",
            "TypeAliasTemplateDecl"
        ];

        return getTypeDefinitions(document, position, symbolKinds, true);
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

        const wordRange = document.getWordRangeAtPosition(position);
        const charDelta = wordRange ? (wordRange.end.character - wordRange.start.character) : undefined;

        const resolveCallback =
            (locations?: Location[]) : WorkspaceEdit =>
            {
                let edit = new WorkspaceEdit();
                if (locations)
                {
                    for (const loc of locations)
                    {
                        const end = loc.range.end.translate(0, charDelta);
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

                const contextIndex = output.indexOf('\t');
                if (contextIndex === -1)
                {
                    return undefined;
                }

                const context = output.slice(contextIndex).trim();
                if (!context)
                {
                    return undefined;
                }

                // FIXME: Hover text is not formatted properly unless a tab or 4 spaces are prepended
                return new Hover('\t' + context);
            };

        return runRc(args, processCallback);
    }

    private rtagsMgr: RtagsManager;
    private disposables: Disposable[] = [];
}
