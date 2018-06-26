'use strict';

import { commands, window, workspace, Disposable, Event, EventEmitter, Location, Position, ProviderResult,
         TextDocument, TreeDataProvider, TreeItem, TreeItemCollapsibleState, Uri } from 'vscode';

import { Nullable, setContext, fromRtagsLocation, toRtagsLocation, runRc } from './rtagsUtil';

interface Caller
{
    location: Location;
    containerName: string;
    containerLocation: Location;
    document?: TextDocument;
    context: string;
}

function getCallers(document: TextDocument | undefined, uri: Uri, position: Position) : Thenable<Caller[]>
{
    const location = toRtagsLocation(uri, position);

    let args =
    [
        "--json",
        "--absolute-path",
        "--containing-function",
        "--containing-function-location",
        "--references",
        location
    ];

    let process =
        (output: string) : Caller[] =>
        {
            let result: Caller[] = [];

            const o = JSON.parse(output);

            for (let c of o)
            {
                try
                {
                    let containerLocation = fromRtagsLocation(c.cfl);
                    let doc = workspace.textDocuments.find(
                        (v, _i) => { return (v.uri.fsPath === containerLocation.uri.fsPath); });

                    let caller: Caller =
                    {
                        location: fromRtagsLocation(c.loc),
                        containerName: c.cf.trim(),
                        containerLocation: containerLocation,
                        document: doc,
                        context: c.ctx.trim()
                    };
                    result.push(caller);
                }
                catch (_err)
                {
                }
            }

            return result;
        };

    return runRc(args, process, document);
}

export class CallHierarchyProvider implements TreeDataProvider<Caller>, Disposable
{
    constructor()
    {
        this.disposables.push(
            window.registerTreeDataProvider("rtags.callHierarchy", this),
            commands.registerCommand("rtags.callHierarchy",
                                     () : void =>
                                     {
                                         setContext("extension.rtags.callHierarchyVisible", true);
                                         this.refresh();
                                     }),
            commands.registerCommand("rtags.closeCallHierarchy",
                                     () : void =>
                                     {
                                         setContext("extension.rtags.callHierarchyVisible", false);
                                         this.refresh();
                                     }),
            commands.registerCommand("rtags.gotoLocation",
                                     (caller: Caller) : void =>
                                     {
                                         window.showTextDocument(caller.containerLocation.uri,
                                                                 {selection: caller.location.range});
                                     }));
    }

    dispose() : void
    {
        for (let d of this.disposables)
        {
            d.dispose();
        }
    }

    getTreeItem(caller: Caller) : TreeItem | Thenable<TreeItem>
    {
        let ti = new TreeItem(caller.containerName + " : " + caller.context, TreeItemCollapsibleState.Collapsed);
        ti.contextValue = "rtagsLocation";
        return ti;
    }

    getChildren(node?: Caller) : ProviderResult<Caller[]>
    {
        const list: Caller[] = [];
        if (!node)
        {
            let editor = window.activeTextEditor;
            if (editor)
            {
                let pos = editor.selection.active;
                let doc = editor.document;
                let loc = new Location(doc.uri, pos);

                let caller: Caller =
                {
                    location: loc,
                    containerLocation: loc,
                    containerName: doc.getText(doc.getWordRangeAtPosition(pos)),
                    document: doc,
                    context: ""
                };
                list.push(caller);
            }
            return list;
        }

        return getCallers(node.document, node.containerLocation.uri, node.containerLocation.range.start);
    }

    private refresh() : void
    {
        this.onDidChangeEmitter.fire();
    }

    private disposables: Disposable[] = [];
    private onDidChangeEmitter: EventEmitter<Nullable<Caller>> = new EventEmitter<Nullable<Caller>>();
    readonly onDidChangeTreeData: Event<Nullable<Caller>> = this.onDidChangeEmitter.event;
}
