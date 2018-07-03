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
                        let locations: Location[] = [];
                        callers.forEach((c) => { locations.push(c.location); });
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
        const location: string = basename(element.location.uri.fsPath) + ':' + (element.location.range.start.line + 1);
        let treeItem = new TreeItem(element.containerName + " (" + location + ')', TreeItemCollapsibleState.Collapsed);
        treeItem.contextValue = "rtagsLocation";
        return treeItem;
    }

    getChildren(element?: Caller) : ProviderResult<Caller[]>
    {
        if (!element)
        {
            let callers: Caller[] = [];
            const editor = window.activeTextEditor;
            if (editor)
            {
                const pos = editor.selection.active;
                const doc = editor.document;
                const loc = new Location(doc.uri, pos);

                const caller: Caller =
                {
                    location: loc,
                    containerLocation: loc,
                    containerName: doc.getText(doc.getWordRangeAtPosition(pos)),
                    containerDocument: doc
                };
                callers.push(caller);
            }
            return callers;
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
