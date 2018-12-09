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

import { commands, languages, workspace, CancellationToken, Definition, DefinitionProvider, Disposable,
         DocumentHighlight, DocumentHighlightProvider, Hover, HoverProvider, Location, Position, ProviderResult,
         ReferenceContext, TextDocument, TypeDefinitionProvider, ImplementationProvider, Range, ReferenceProvider,
         RenameProvider, TextEditor, TextEditorEdit, Uri, WorkspaceEdit } from 'vscode';

import * as assert from 'assert';

import { RtagsManager, runRc } from './rtagsManager';

import { SymbolInfo, getSymbolInfo } from './callHierarchy';

import { getDerivedClasses } from './inheritanceHierarchy';

import { Optional, SourceFileSelector, SymbolCategory, getRtagsSymbolKinds, isRtagsSymbolKind, fromRtagsLocation,
         toRtagsLocation, showReferences } from './rtagsUtil';

enum ReferenceType
{
    Definition,
    TypeDefinition,
    References,
    AllReferences,
    AllReferencesInFile,
    Rename,
    Constructors,
    Virtuals
}

function getBaseSymbolType(symbolType: string) : string
{
    const baseSymbolType = symbolType.replace(/const|volatile|&|\*|\[\d*\]|\<.*|\(.*|=>.*/g, "");
    return baseSymbolType.trim();
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

function getReferences(uri: Uri, position: Position, queryType: ReferenceType) : Promise<Optional<Location[]>>
{
    const location = toRtagsLocation(uri, position);

    let args = ["--absolute-path", "--no-context"];

    switch (queryType)
    {
        case ReferenceType.Definition:
            args.push("--follow-location", location);
            break;

        case ReferenceType.TypeDefinition:
            args.push("--references", location, "--all-references", "--rename", "--definition-only");
            getRtagsSymbolKinds(SymbolCategory.TypeDecl).forEach((k) => { args.push("--kind-filter", k); });
            break;

        case ReferenceType.References:
            args.push("--references", location);
            break;

        case ReferenceType.AllReferences:
            args.push("--references", location, "--all-references");
            break;

        case ReferenceType.AllReferencesInFile:
            args.push("--references", location, "--all-references", "--path-filter", uri.fsPath);
            break;

        case ReferenceType.Rename:
            args.push("--references", location, "--all-references", "--rename");
            break;

        case ReferenceType.Constructors:
            args.push("--references", location, "--all-references", "--rename", "--kind-filter", "CXXConstructor");
            break;

        case ReferenceType.Virtuals:
            args.push("--references", location, "--find-virtuals", "--definition-only");
            break;
    }

    return getLocations(args);
}

function getReferencesByName(name: string, projectPath: Uri, queryType: ReferenceType) : Promise<Optional<Location[]>>
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
        case ReferenceType.TypeDefinition:
            args.push("--definition-only");
            getRtagsSymbolKinds(SymbolCategory.TypeDecl).forEach((k) => { args.push("--kind-filter", k); });
            break;

        case ReferenceType.Constructors:
            args.push("--kind-filter", "CXXConstructor");
            break;

        default:
            assert.fail("Invalid reference query type");
            break;
    }

    return getLocations(args);
}

async function getReferencesForSymbolType(symbolInfo: SymbolInfo, projectPath: Uri, queryType: ReferenceType) :
    Promise<Optional<Location[]>>
{
    let symbolType: string;

    if (!symbolInfo.type || (symbolInfo.kind === "CXXConstructor") || (symbolInfo.kind === "CXXDestructor"))
    {
        symbolType = symbolInfo.name;
    }
    else
    {
        symbolType = symbolInfo.type;
    }

    return getReferencesByName(getBaseSymbolType(symbolType), projectPath, queryType);
}

async function getVariables(uri: Uri, position: Position, projectPath: Uri) : Promise<Location[]>
{
    const symbolInfo = await getSymbolInfo(uri, position);
    if (!symbolInfo)
    {
        return [];
    }

    let constructorLocations: Optional<Location[]> = undefined;

    if (isRtagsSymbolKind(symbolInfo.kind, SymbolCategory.Type))
    {
        constructorLocations = await getReferences(uri, position, ReferenceType.Constructors);
    }
    else if (isRtagsSymbolKind(symbolInfo.kind, SymbolCategory.Variable))
    {
        constructorLocations = await getReferencesForSymbolType(symbolInfo, projectPath, ReferenceType.Constructors);
    }

    if (!constructorLocations)
    {
        return [];
    }

    let variableLocations: Location[] = [];

    for (const loc of constructorLocations)
    {
        const locations = await getReferences(loc.uri, loc.range.start, ReferenceType.References);
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
    DocumentHighlightProvider,
    RenameProvider,
    HoverProvider,
    Disposable
{
    constructor(rtagsMgr: RtagsManager)
    {
        this.rtagsMgr = rtagsMgr;

        const showVariablesCallback =
            async (textEditor: TextEditor, _edit: TextEditorEdit) : Promise<void> =>
            {
                const document = textEditor.document;
                const position = textEditor.selection.active;

                const projectPath = this.rtagsMgr.getProjectPath(document.uri);
                if (!projectPath)
                {
                    return;
                }

                const locations = await getVariables(document.uri, position, projectPath);
                showReferences(document.uri, position, locations);
            };

        const showDerivedVirtualsCallback =
            (textEditor: TextEditor, _edit: TextEditorEdit) : void =>
            {
                const document = textEditor.document;
                const position = textEditor.selection.active;

                commands.executeCommand("editor.action.goToImplementation", document.uri, position);
            };

        const config = workspace.getConfiguration("rtags");
        const highlightingEnabled = config.get<boolean>("highlighting.enabled", false);
        if (highlightingEnabled)
        {
            this.disposables.push(languages.registerDocumentHighlightProvider(SourceFileSelector, this));
        }

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

        return getReferences(document.uri, position, ReferenceType.Definition);
    }

    public provideTypeDefinition(document: TextDocument, position: Position, _token: CancellationToken) :
        ProviderResult<Definition>
    {
        const projectPath = this.rtagsMgr.getProjectPath(document.uri);
        if (!projectPath)
        {
            return undefined;
        }

        const resolveCallback =
            (symbolInfo?: SymbolInfo) : Promise<Optional<Location[]>> =>
            {
                if (!symbolInfo)
                {
                    return Promise.resolve(undefined);
                }

                if (isRtagsSymbolKind(symbolInfo.kind, SymbolCategory.TypeRef))
                {
                    return getReferences(document.uri, position, ReferenceType.Definition);
                }

                if (isRtagsSymbolKind(symbolInfo.kind, SymbolCategory.Type))
                {
                    return getReferences(document.uri, position, ReferenceType.TypeDefinition);
                }

                if (isRtagsSymbolKind(symbolInfo.kind, SymbolCategory.Variable))
                {
                    return getReferencesForSymbolType(symbolInfo, projectPath, ReferenceType.TypeDefinition);
                }

                return Promise.resolve(undefined);
            };

        return getSymbolInfo(document.uri, position).then(resolveCallback);
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
                    return Promise.resolve(undefined);
                }

                if (symbolInfo.virtual || (symbolInfo.target && symbolInfo.target.virtual))
                {
                    return getReferences(document.uri, position, ReferenceType.Virtuals);
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

        const queryType = context.includeDeclaration ? ReferenceType.AllReferences : ReferenceType.References;

        return getReferences(document.uri, position, queryType);
    }

    public provideDocumentHighlights(document: TextDocument, position: Position, _token: CancellationToken) :
        ProviderResult<DocumentHighlight[]>
    {
        if (!this.rtagsMgr.isInProject(document.uri))
        {
            return [];
        }

        const resolveCallback =
            async (symbolInfo?: SymbolInfo) : Promise<Optional<DocumentHighlight[]>> =>
            {
                if (!symbolInfo)
                {
                    return undefined;
                }

                if (!isRtagsSymbolKind(symbolInfo.kind))
                {
                    return undefined;
                }

                const locations = await getReferences(document.uri, position, ReferenceType.AllReferencesInFile);
                if (!locations)
                {
                    return undefined;
                }

                let highlights: DocumentHighlight[] = [];

                for (const loc of locations)
                {
                    const start = loc.range.start;
                    const end = start.translate(0, symbolInfo.length);
                    const range = new Range(start, end);
                    highlights.push(new DocumentHighlight(range));
                }

                return highlights;
            };

        const timeoutMs = 5000;

        return getSymbolInfo(document.uri, position, false, timeoutMs).then(resolveCallback);
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

        return getReferences(document.uri, position, ReferenceType.Rename).then(resolveCallback);
    }

    public provideHover(document: TextDocument, position: Position, _token: CancellationToken) : ProviderResult<Hover>
    {
        if (!this.rtagsMgr.isInProject(document.uri))
        {
            return undefined;
        }

        const location = toRtagsLocation(document.uri, position);

        const timeoutMs = 5000;

        const args =
        [
            "--follow-location",
            location,
            "--absolute-path",
            "--timeout",
            timeoutMs.toString()
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
