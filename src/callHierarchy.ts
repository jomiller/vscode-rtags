'use strict';

import { commands, window, Disposable, Event, EventEmitter, Location, Position, ProviderResult, TextEditor,
         TextEditorEdit, TreeDataProvider, TreeItem, TreeItemCollapsibleState, Uri } from 'vscode';

import { basename } from 'path';

import { RtagsManager, runRc } from './rtagsManager';

import { Nullable, Locatable, setContext, showReferences, fromRtagsLocation, toRtagsLocation } from './rtagsUtil';

interface Caller extends Locatable
{
    containerName: string;
    containerLocation: Location;
}

function isFunctionKind(symbolKind: string) : boolean
{
    const functionKinds =
    [
        "CXXConstructor",
        "CXXDestructor",
        "CXXMethod",
        "FunctionDecl",
        "MemberRefExpr",
        "DeclRefExpr"
    ];

    return functionKinds.includes(symbolKind);
}

function getCallers(uri: Uri, position: Position) : Thenable<Caller[]>
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
            let jsonObj;
            try
            {
                jsonObj = JSON.parse(output);
            }
            catch (_err)
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
                        function isFunction(symbolInfo: string) : boolean
                        {
                            let jsonObj;
                            try
                            {
                                jsonObj = JSON.parse(symbolInfo);
                            }
                            catch (_err)
                            {
                                return false;
                            }

                            const symbolKind = jsonObj.kind;
                            if (!symbolKind)
                            {
                                return false;
                            }

                            return isFunctionKind(symbolKind);
                        }

                        let promise = isFunction(output) ? getCallers(document.uri, position) :
                                                           Promise.resolve([] as Caller[]);

                        const resolveCallback =
                            (callers: Caller[]) : void =>
                            {
                                const locations: Location[] = callers.map((c) => { return c.location; });
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
        for (let d of this.disposables)
        {
            d.dispose();
        }
    }

    public getTreeItem(element: Caller) : TreeItem | Thenable<TreeItem>
    {
        const lineNumber = element.location.range.start.line + 1;
        const location: string = basename(element.location.uri.fsPath) + ':' + lineNumber.toString();
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
                    let jsonObj;
                    try
                    {
                        jsonObj = JSON.parse(output);
                    }
                    catch (_err)
                    {
                        return [];
                    }

                    const symbolName = jsonObj.symbolName;
                    if (!symbolName)
                    {
                        return [];
                    }

                    const symbolKind = jsonObj.kind;
                    if (!symbolKind)
                    {
                        return [];
                    }

                    if (!isFunctionKind(symbolKind))
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
