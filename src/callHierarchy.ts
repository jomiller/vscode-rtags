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

import { commands, window, Disposable, Event, EventEmitter, Location, Position, ProviderResult, TextEditor,
         TextEditorEdit, TreeDataProvider, TreeItem, TreeItemCollapsibleState, Uri } from 'vscode';

import * as path from 'path';

import { RtagsManager, runRc } from './rtagsManager';

import { Nullable, Optional, Locatable, SymbolCategory, isRtagsSymbolKind, fromRtagsLocation, toRtagsLocation,
         parseJson, setContext, showReferences } from './rtagsUtil';

interface Caller extends Locatable
{
    containerName: string;
    containerLocation: Location;
}

interface SymbolInfoBase
{
    location: string;
    name: string;
    length: number;
    kind: string;
    type?: string;
    virtual?: boolean;
}

export interface SymbolInfo extends SymbolInfoBase
{
    target?: SymbolInfoBase;
}

function getCallers(uri: Uri, position: Position) : Promise<Optional<Caller[]>>
{
    const location = toRtagsLocation(uri, position);

    const args =
    [
        "--references",
        location,
        "--absolute-path",
        "--no-context",
        "--containing-function",
        "--containing-function-location",
        "--json"
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

export function getSymbolInfo(uri: Uri, position: Position, includeTarget: boolean = false, timeout: number = 0) :
    Promise<Optional<SymbolInfo>>
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

    if (timeout > 0)
    {
        args.push("--timeout", timeout.toString());
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
                location: jsonObj.location,
                name: jsonObj.symbolName,
                length: jsonObj.symbolLength,
                kind: jsonObj.kind,
                type: jsonObj.type,
                virtual: jsonObj.virtual
            };

            const targets = jsonObj.targets;
            if (targets && (targets.length !== 0))
            {
                const targetSymbolInfo: SymbolInfoBase =
                {
                    location: targets[0].location,
                    name: targets[0].symbolName,
                    length: targets[0].symbolLength,
                    kind: targets[0].kind,
                    type: targets[0].type,
                    virtual: targets[0].virtual
                };
                symbolInfo.target = targetSymbolInfo;
            }

            return symbolInfo;
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
            async (textEditor: TextEditor, _edit: TextEditorEdit) : Promise<void> =>
            {
                const document = textEditor.document;
                const position = textEditor.selection.active;

                if (!this.rtagsMgr.isInProject(document.uri))
                {
                    return;
                }

                const symbolInfo = await getSymbolInfo(document.uri, position);

                let callers: Optional<Caller[]> = undefined;
                if (symbolInfo && isRtagsSymbolKind(symbolInfo.kind, SymbolCategory.Function))
                {
                    callers = await getCallers(document.uri, position);
                }

                let locations: Location[] = [];
                if (callers)
                {
                    callers.forEach((c) => { locations.push(c.location); });
                }
                showReferences(document.uri, position, locations);
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

            const resolveCallback =
                (symbolInfo?: SymbolInfo) : Caller[] =>
                {
                    if (!symbolInfo)
                    {
                        return [];
                    }

                    if (!isRtagsSymbolKind(symbolInfo.kind, SymbolCategory.Function))
                    {
                        return [];
                    }

                    let containerLocation = new Location(document.uri, position);
                    if (symbolInfo.target)
                    {
                        containerLocation = fromRtagsLocation(symbolInfo.target.location);
                    }

                    const root: Caller =
                    {
                        location: containerLocation,
                        containerLocation: containerLocation,
                        containerName: symbolInfo.name
                    };

                    return [root];
                };

            return getSymbolInfo(document.uri, position, true).then(resolveCallback);
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
