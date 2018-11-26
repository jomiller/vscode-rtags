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

import { commands, languages, CancellationToken, Definition, DefinitionProvider, Disposable, Hover, HoverProvider,
         Location, Position, ProviderResult, ReferenceContext, TextDocument, TypeDefinitionProvider,
         ImplementationProvider, Range, ReferenceProvider, RenameProvider, TextEditor, TextEditorEdit, Uri,
         WorkspaceEdit } from 'vscode';

import { RtagsManager, runRc } from './rtagsManager';

import { getDerivedClasses } from './inheritanceHierarchy';

import { Optional, SourceFileSelector, showReferences, fromRtagsLocation, toRtagsLocation, parseJson }
         from './rtagsUtil';

enum LocationQueryType
{
    Definition,
    References,
    AllReferences,
    Rename,
    Virtuals
}

enum NameQueryType
{
    TypeDefinition,
    Constructors
}

interface SymbolInfoBase
{
    name: string;
    kind: string;
    type?: string;
    pureVirtual?: boolean;
}

interface SymbolInfo extends SymbolInfoBase
{
    target?: SymbolInfoBase;
}

function getBaseSymbolType(symbolType: string) : string
{
    const baseSymbolType = symbolType.replace(/const|volatile|&|\*|\[\d*\]|\(.*|=>.*/g, "");
    return baseSymbolType.trim();
}

function getSymbolInfo(uri: Uri, position: Position, includeTarget: boolean = false) : Promise<Optional<SymbolInfo>>
{
    const location = toRtagsLocation(uri, position);

    let args =
    [
        "--symbol-info",
        location,
        "--absolute-path",
        "--no-context",
        "--json"
    ];

    if (includeTarget)
    {
        args.push("--symbol-info-include-targets");
    }

    const processCallback =
        (output: string) : Optional<SymbolInfo> =>
        {
            const jsonObj = parseJson(output);
            if (!jsonObj)
            {
                return undefined;
            }

            let symbolInfo: SymbolInfo =
            {
                name: jsonObj.symbolName,
                kind: jsonObj.kind,
                type: jsonObj.type,
                pureVirtual: jsonObj.purevirtual
            };

            const targets = jsonObj.targets;
            if (targets && (targets.length !== 0))
            {
                const targetSymbolInfo: SymbolInfoBase =
                {
                    name: targets[0].symbolName,
                    kind: targets[0].kind,
                    type: targets[0].type,
                    pureVirtual: targets[0].purevirtual
                };
                symbolInfo.target = targetSymbolInfo;
            }

            return symbolInfo;
        };

    return runRc(args, processCallback);
}

async function getSymbolType(uri: Uri, position: Position) : Promise<Optional<string>>
{
    const symbolInfo = await getSymbolInfo(uri, position);
    if (!symbolInfo)
    {
        return undefined;
    }

    if ((symbolInfo.kind === "CXXConstructor") || (symbolInfo.kind === "CXXDestructor"))
    {
        return getBaseSymbolType(symbolInfo.name);
    }

    const symbolKinds =
    [
        "ClassDecl",
        "ClassTemplate",
        "ClassTemplatePartialSpecialization",
        "StructDecl",
        "UnionDecl",
        "EnumDecl",
        "TypedefDecl",
        "TypeAliasDecl",
        "TypeAliasTemplateDecl",
        "FieldDecl",
        "ParmDecl",
        "VarDecl",
        "NonTypeTemplateParameter",
        "TypeRef",
        "TemplateRef",
        "MemberRef",
        "VariableRef",
        "CallExpr",
        "MemberRefExpr",
        "DeclRefExpr"
    ];
    if (!symbolKinds.includes(symbolInfo.kind))
    {
        return undefined;
    }

    return (symbolInfo.type ? getBaseSymbolType(symbolInfo.type) : getBaseSymbolType(symbolInfo.name));
}

function getLocations(args: string[]) : Promise<Optional<Location[]>>
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

function getReferences(uri: Uri, position: Position, queryType: LocationQueryType) : Promise<Optional<Location[]>>
{
    const location = toRtagsLocation(uri, position);

    let args = ["--absolute-path", "--no-context"];

    switch (queryType)
    {
        case LocationQueryType.Definition:
            args.push("--follow-location", location);
            break;

        case LocationQueryType.References:
            args.push("--references", location);
            break;

        case LocationQueryType.AllReferences:
            args.push("--references", location, "--all-references");
            break;

        case LocationQueryType.Rename:
            args.push("--references", location, "--all-references", "--rename");
            break;

        case LocationQueryType.Virtuals:
            args.push("--references", location, "--find-virtuals", "--definition-only");
            break;
    }

    return getLocations(args);
}

function getReferencesByName(name: string, projectPath: Uri, queryType: NameQueryType) : Promise<Optional<Location[]>>
{
    let args =
    [
        "--project",
        projectPath.fsPath,
        "--references-name",
        name,
        "--all-references",
        "--rename",
        "--absolute-path",
        "--no-context"
    ];

    switch (queryType)
    {
        case NameQueryType.TypeDefinition:
        {
            const symbolKinds =
            [
                "ClassDecl",
                "ClassTemplate",
                "ClassTemplatePartialSpecialization",
                "StructDecl",
                "UnionDecl",
                "EnumDecl",
                "TypedefDecl",
                "TypeAliasDecl",
                "TypeAliasTemplateDecl"
            ];
            symbolKinds.forEach((k) => { args.push("--kind-filter", k); });
            args.push("--definition-only");
            break;
        }

        case NameQueryType.Constructors:
            args.push("--kind-filter", "CXXConstructor");
            break;
    }

    return getLocations(args);
}

async function getReferencesForSymbolType(uri: Uri, position: Position, projectPath: Uri, queryType: NameQueryType) :
    Promise<Optional<Location[]>>
{
    const symbolType = await getSymbolType(uri, position);
    if (!symbolType)
    {
        return undefined;
    }

    return getReferencesByName(symbolType, projectPath, queryType);
}

async function getVariables(uri: Uri, position: Position, projectPath: Uri) : Promise<Location[]>
{
    const constructorLocations =
        await getReferencesForSymbolType(uri, position, projectPath, NameQueryType.Constructors);

    if (!constructorLocations)
    {
        return [];
    }

    let variableLocations: Location[] = [];

    for (const loc of constructorLocations)
    {
        const locations = await getReferences(loc.uri, loc.range.start, LocationQueryType.References);
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

                const projectPath = this.rtagsMgr.getProjectPath(document.uri);
                if (!projectPath)
                {
                    return;
                }

                const resolveCallback =
                    (locations: Location[]) : void =>
                    {
                        showReferences(document.uri, position, locations);
                    };

                getVariables(document.uri, position, projectPath).then(resolveCallback);
            };

        const showDerivedVirtualsCallback =
            (textEditor: TextEditor, _edit: TextEditorEdit) : void =>
            {
                const document = textEditor.document;
                const position = textEditor.selection.active;

                commands.executeCommand("editor.action.goToImplementation", document.uri, position);
            };

        this.disposables.push(
            languages.registerDefinitionProvider(SourceFileSelector, this),
            languages.registerTypeDefinitionProvider(SourceFileSelector, this),
            languages.registerImplementationProvider(SourceFileSelector, this),
            languages.registerReferenceProvider(SourceFileSelector, this),
            languages.registerRenameProvider(SourceFileSelector, this),
            languages.registerHoverProvider(SourceFileSelector, this),
            commands.registerTextEditorCommand("rtags.showVariables", showVariablesCallback),
            commands.registerTextEditorCommand("rtags.showDerivedVirtuals", showDerivedVirtualsCallback));
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

        return getReferences(document.uri, position, LocationQueryType.Definition);
    }

    public provideTypeDefinition(document: TextDocument, position: Position, _token: CancellationToken) :
        ProviderResult<Definition>
    {
        const projectPath = this.rtagsMgr.getProjectPath(document.uri);
        if (!projectPath)
        {
            return undefined;
        }

        return getReferencesForSymbolType(document.uri, position, projectPath, NameQueryType.TypeDefinition);
    }

    public provideImplementation(document: TextDocument, position: Position, _token: CancellationToken) :
        ProviderResult<Definition>
    {
        if (!this.rtagsMgr.isInProject(document.uri))
        {
            return undefined;
        }

        const resolveCallback =
            (symbolInfo?: SymbolInfo) : Promise<Optional<Location[]>> =>
            {
                if (!symbolInfo)
                {
                    return Promise.resolve([] as Location[]);
                }

                if (symbolInfo.pureVirtual || (symbolInfo.target && symbolInfo.target.pureVirtual))
                {
                    return getReferences(document.uri, position, LocationQueryType.Virtuals);
                }

                return getDerivedClasses(document.uri, position);
            };

        return getSymbolInfo(document.uri, position, true).then(resolveCallback);
    }

    public provideReferences(document: TextDocument,
                             position: Position,
                             context: ReferenceContext,
                             _token: CancellationToken) :
        ProviderResult<Location[]>
    {
        if (!this.rtagsMgr.isInProject(document.uri))
        {
            return [];
        }

        const queryType = context.includeDeclaration ? LocationQueryType.AllReferences : LocationQueryType.References;

        return getReferences(document.uri, position, queryType);
    }

    public provideRenameEdits(document: TextDocument,
                              position: Position,
                              newName: string,
                              _token: CancellationToken) :
        ProviderResult<WorkspaceEdit>
    {
        const projectPath = this.rtagsMgr.getProjectPath(document.uri);
        if (!projectPath)
        {
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

        return getReferences(document.uri, position, LocationQueryType.Rename).then(resolveCallback);
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
            "--follow-location",
            location,
            "--absolute-path"
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
