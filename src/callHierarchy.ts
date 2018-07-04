'use strict';

import { commands, window, workspace, Disposable, Event, EventEmitter, Location, Position, ProviderResult,
         TextDocument, TreeDataProvider, TreeItem, TreeItemCollapsibleState, Uri } from 'vscode';

import { basename } from 'path';

import { Nullable, Locatable, setContext, fromRtagsLocation, toRtagsLocation, runRc } from './rtagsUtil';

interface Caller extends Locatable
{
    containerName: string;
    containerLocation: Location;
    containerDocument?: TextDocument;
}

function getCallers(uri: Uri, position: Position, document?: TextDocument) : Thenable<Caller[]>
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
            let callers: Caller[] = [];

            try
            {
                const jsonObj = JSON.parse(output);
                for (const c of jsonObj)
                {
                    const containerLocation = fromRtagsLocation(c.cfl);
                    const containerDoc = workspace.textDocuments.find(
                        (val) => { return (val.uri.fsPath === containerLocation.uri.fsPath); });

                    const caller: Caller =
                    {
                        location: fromRtagsLocation(c.loc),
                        containerName: c.cf.trim(),
                        containerLocation: containerLocation,
                        containerDocument: containerDoc
                    };
                    callers.push(caller);
                }
            }
            catch (_err)
            {
            }

            return callers;
        };

    return runRc(args, processCallback, document);
}

export class CallHierarchyProvider implements TreeDataProvider<Caller>, Disposable
{
    constructor()
    {
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
            () : void =>
            {
                const editor = window.activeTextEditor;
                if (!editor)
                {
                    return;
                }

                const document = editor.document;
                const position = editor.selection.active;

                let promise = getCallers(document.uri, position, document);

                promise.then(
                    (callers: Caller[]) : void =>
                    {
                        const locations: Location[] = callers.map((c) => { return c.location; });
                        commands.executeCommand("editor.action.showReferences",
                                                document.uri,
                                                position,
                                                locations);
                    });
            };

        this.disposables.push(
            window.registerTreeDataProvider("rtags.callHierarchy", this),
            commands.registerCommand("rtags.callHierarchy", callHierarchyCallback),
            commands.registerCommand("rtags.closeCallHierarchy", closeCallHierarchyCallback),
            commands.registerCommand("rtags.showCallers", showCallersCallback));
    }

    dispose() : void
    {
        for (let d of this.disposables)
        {
            d.dispose();
        }
    }

    getTreeItem(element: Caller) : TreeItem | Thenable<TreeItem>
    {
        const lineNumber = element.location.range.start.line + 1;
        const location: string = basename(element.location.uri.fsPath) + ':' + lineNumber.toString();
        let treeItem = new TreeItem(element.containerName + " (" + location + ')', TreeItemCollapsibleState.Collapsed);
        treeItem.contextValue = "rtagsLocation";
        return treeItem;
    }

    getChildren(element?: Caller) : ProviderResult<Caller[]>
    {
        if (!element)
        {
            const editor = window.activeTextEditor;
            if (!editor)
            {
                return [];
            }

            const position = editor.selection.active;
            const document = editor.document;

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

            const resolveCallback =
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

                    const symbolKinds =
                    [
                        "CXXConstructor",
                        "CXXDestructor",
                        "CXXMethod",
                        "FunctionDecl",
                        "VarDecl",
                        "MemberRefExpr",
                        "DeclRefExpr"
                    ];
                    if (!symbolKinds.includes(symbolKind))
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
                        containerName: symbolName,
                        containerDocument: document
                    };

                    return [root];
                };

            return runRc(args, (output) => { return output; }, document).then(resolveCallback);
        }

        return getCallers(element.containerLocation.uri,
                          element.containerLocation.range.start,
                          element.containerDocument);
    }

    private refresh() : void
    {
        this.onDidChangeEmitter.fire();
    }

    private disposables: Disposable[] = [];
    private onDidChangeEmitter: EventEmitter<Nullable<Caller>> = new EventEmitter<Nullable<Caller>>();
    readonly onDidChangeTreeData: Event<Nullable<Caller>> = this.onDidChangeEmitter.event;
}
