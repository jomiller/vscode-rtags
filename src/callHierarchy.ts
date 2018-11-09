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

import { commands, window, Disposable, Event, EventEmitter, Location, Position, ProviderResult, TextEditor,
         TextEditorEdit, TreeDataProvider, TreeItem, TreeItemCollapsibleState, Uri } from 'vscode';

import * as path from 'path';

import { RtagsManager, runRc } from './rtagsManager';

import { Nullable, Optional, Locatable, setContext, showReferences, fromRtagsLocation, toRtagsLocation, parseJson }
         from './rtagsUtil';

interface Caller extends Locatable
{
    containerName: string;
    containerLocation: Location;
}

function isFunctionKind(symbolKind?: string) : boolean
{
    if (!symbolKind)
    {
        return false;
    }

    const functionKinds =
    [
        "CXXConstructor",
        "CXXDestructor",
        "CXXMethod",
        "FunctionDecl",
        "CallExpr",
        "MemberRefExpr",
        "DeclRefExpr"
    ];

    return functionKinds.includes(symbolKind);
}

function getCallers(uri: Uri, position: Position) : Thenable<Optional<Caller[]>>
{
    const location = toRtagsLocation(uri, position);

    const args =
    [
        "--json",
        "--absolute-path",
        "--no-context",
        "--containing-function",
        "--containing-function-location",
        "--references",
        location
    ];

    const processCallback =
        (output: string) : Caller[] =>
        {
            const jsonObj = parseJson(output);
            if (!jsonObj)
            {
                return [];
            }

            let callers: Caller[] = [];

            for (const c of jsonObj)
            {
                try
                {
                    const caller: Caller =
                    {
                        location: fromRtagsLocation(c.loc),
                        containerName: c.cf.trim(),
                        containerLocation: fromRtagsLocation(c.cfl)
                    };
                    callers.push(caller);
                }
                catch (_err)
                {
                }
            }

            return callers;
        };

    return runRc(args, processCallback);
}

export class CallHierarchyProvider implements TreeDataProvider<Caller>, Disposable
{
    constructor(rtagsMgr: RtagsManager)
    {
        this.rtagsMgr = rtagsMgr;

        const callHierarchyCallback =
            () : void =>
            {
                setContext("extension.rtags.callHierarchyVisible", true);
                this.refresh();
            };

        const closeCallHierarchyCallback =
            () : void =>
            {
                setContext("extension.rtags.callHierarchyVisible", false);
                this.refresh();
            };

        const showCallersCallback =
            (textEditor: TextEditor, _edit: TextEditorEdit) : void =>
            {
                const document = textEditor.document;
                const position = textEditor.selection.active;

                if (!this.rtagsMgr.isInProject(document.uri))
                {
                    return;
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
                    (output: string) : void =>
                    {
                        const jsonObj = parseJson(output);

                        let promise = (jsonObj && isFunctionKind(jsonObj.kind)) ?
                                      getCallers(document.uri, position) :
                                      Promise.resolve([] as Caller[]);

                        const resolveCallback =
                            (callers?: Caller[]) : void =>
                            {
                                let locations: Location[] = [];
                                if (callers)
                                {
                                    callers.forEach((c) => { locations.push(c.location); });
                                }
                                showReferences(document.uri, position, locations);
                            };

                        promise.then(resolveCallback);
                    };

                runRc(args, processCallback);
            };

        this.disposables.push(
            window.registerTreeDataProvider("rtags.callHierarchy", this),
            commands.registerCommand("rtags.callHierarchy", callHierarchyCallback),
            commands.registerCommand("rtags.closeCallHierarchy", closeCallHierarchyCallback),
            commands.registerTextEditorCommand("rtags.showCallers", showCallersCallback));
    }

    public dispose() : void
    {
        this.disposables.forEach((d) => { d.dispose(); });
    }

    public getTreeItem(element: Caller) : TreeItem | Thenable<TreeItem>
    {
        const lineNumber = element.location.range.start.line + 1;
        const location: string = path.basename(element.location.uri.fsPath) + ':' + lineNumber.toString();
        let treeItem = new TreeItem(element.containerName + " (" + location + ')', TreeItemCollapsibleState.Collapsed);
        treeItem.contextValue = "rtagsLocation";
        return treeItem;
    }

    public getChildren(element?: Caller) : ProviderResult<Caller[]>
    {
        if (!element)
        {
            const editor = window.activeTextEditor;
            if (!editor)
            {
                return [];
            }

            const document = editor.document;
            const position = editor.selection.active;

            if (!this.rtagsMgr.isInProject(document.uri))
            {
                return [];
            }

            const location = toRtagsLocation(document.uri, position);

            const args =
            [
                "--json",
                "--absolute-path",
                "--no-context",
                "--symbol-info-include-targets",
                "--symbol-info",
                location
            ];

            const processCallback =
                (output: string) : Caller[] =>
                {
                    const jsonObj = parseJson(output);
                    if (!jsonObj)
                    {
                        return [];
                    }

                    if (!isFunctionKind(jsonObj.kind))
                    {
                        return [];
                    }

                    const symbolName = jsonObj.symbolName;
                    if (!symbolName)
                    {
                        return [];
                    }

                    let containerLocation = new Location(document.uri, position);
                    const targets = jsonObj.targets;
                    if (targets && (targets.length !== 0))
                    {
                        containerLocation = fromRtagsLocation(targets[0].location);
                    }

                    const root: Caller =
                    {
                        location: containerLocation,
                        containerLocation: containerLocation,
                        containerName: symbolName
                    };

                    return [root];
                };

            return runRc(args, processCallback);
        }

        return getCallers(element.containerLocation.uri, element.containerLocation.range.start);
    }

    private refresh() : void
    {
        this.onDidChangeEmitter.fire();
    }

    private rtagsMgr: RtagsManager;
    private onDidChangeEmitter: EventEmitter<Nullable<Caller>> = new EventEmitter<Nullable<Caller>>();
    readonly onDidChangeTreeData: Event<Nullable<Caller>> = this.onDidChangeEmitter.event;
    private disposables: Disposable[] = [];
}
