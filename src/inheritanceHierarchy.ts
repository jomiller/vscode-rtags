'use strict';

import { commands, window, workspace, Disposable, Event, EventEmitter, Location, Position, ProviderResult,
         TextDocument, TreeDataProvider, TreeItem, TreeItemCollapsibleState, Uri } from 'vscode';

import { basename } from 'path';

import { Nullable, Locatable, setContext, fromRtagsLocation, toRtagsLocation, jumpToLocation, runRc } from './rtagsUtil';

enum NodeType
{
    Root,
    BaseRoot,
    Common
}

enum ClassType
{
    Base,
    Derived
}

interface InheritanceNode extends Locatable
{
    nodeType: NodeType;
    classType: ClassType;
    name: string;
    document?: TextDocument;
}

function getClasses(nodeType: NodeType, classType: ClassType, uri: Uri, position: Position, document?: TextDocument) :
    Thenable<InheritanceNode[]>
{
    const location = toRtagsLocation(uri, position);

    const args =
    [
        "--absolute-path",
        "--no-context",
        "--class-hierarchy",
        location
    ];

    const processCallback =
        (output: string) : InheritanceNode[] =>
        {
            let nodes: InheritanceNode[] = [];

            const lines = output.split('\n');
            const baseIndex = lines.indexOf("Superclasses:");
            const derivedIndex = lines.indexOf("Subclasses:");
            let startIndex = baseIndex;
            let endIndex = lines.length - 1;
            switch (classType)
            {
                case ClassType.Base:
                    if (derivedIndex !== -1)
                    {
                        endIndex = derivedIndex - 1;
                    }
                    break;

                case ClassType.Derived:
                    startIndex = derivedIndex;
                    break;
            }

            if (startIndex !== -1)
            {
                startIndex += 2;
                for (let i = startIndex; i <= endIndex; ++i)
                {
                    const classInfo = lines[i].match(/^ {4}\w.*/);
                    if (classInfo)
                    {
                        const [name, loc] =
                            classInfo[0].split('\t', 2).map((token) => { return token.trim(); });

                        const location = fromRtagsLocation(loc);
                        const doc = workspace.textDocuments.find(
                            (val) => { return (val.uri.fsPath === location.uri.fsPath); });

                        const node: InheritanceNode =
                        {
                            nodeType: nodeType,
                            classType: classType,
                            name: name,
                            location: location,
                            document: doc
                        };
                        nodes.push(node);
                    }
                }
            }

            return nodes;
        };

    return runRc(args, processCallback, document);
}

export class InheritanceHierarchyProvider implements TreeDataProvider<InheritanceNode>, Disposable
{
    constructor()
    {
        const inheritanceHierarchyCallback =
            () : void =>
            {
                setContext("extension.rtags.inheritanceHierarchyVisible", true);
                this.refresh();
            };

        const closeInheritanceHierarchyCallback =
            () : void =>
            {
                setContext("extension.rtags.inheritanceHierarchyVisible", false);
                this.refresh();
            };

        const showBaseClassesCallback =
            () : void =>
            {
                const editor = window.activeTextEditor;
                if (!editor)
                {
                    return;
                }

                const document = editor.document;
                const position = editor.selection.active;

                const location = toRtagsLocation(document.uri, position);

                const args =
                [
                    "--absolute-path",
                    "--no-context",
                    "--class-hierarchy",
                    location
                ];

                const processCallback =
                    (output: string) : Location[] =>
                    {
                        let locations: Location[] = [];

                        const lines = output.split('\n');
                        const baseIndex = lines.indexOf("Superclasses:");
                        if (baseIndex !== -1)
                        {
                            const startIndex = baseIndex + 2;
                            const derivedIndex = lines.indexOf("Subclasses:");
                            const endIndex = (derivedIndex === -1) ? (lines.length - 1) : (derivedIndex - 1);
                            for (let i = startIndex; i <= endIndex; ++i)
                            {
                                const baseInfo = lines[i].match(/^ {4}\w.*/);
                                if (baseInfo)
                                {
                                    let [_unused, location] =
                                        baseInfo[0].split('\t', 2).map((token) => { return token.trim(); });
                                    _unused = _unused;
                                    locations.push(fromRtagsLocation(location));
                                }
                            }
                        }

                        return locations;
                    };

                const resolveCallback =
                    (locations: Location[]) : void =>
                    {
                        if (locations.length === 1)
                        {
                            jumpToLocation(document.uri, locations[0].range);
                        }
                        else
                        {
                            commands.executeCommand("editor.action.showReferences",
                                                    document.uri,
                                                    position,
                                                    locations);
                        }
                    };

                runRc(args, processCallback, document).then(resolveCallback);
            };

        this.disposables.push(
            window.registerTreeDataProvider("rtags.inheritanceHierarchy", this),
            commands.registerCommand("rtags.inheritanceHierarchy", inheritanceHierarchyCallback),
            commands.registerCommand("rtags.closeInheritanceHierarchy", closeInheritanceHierarchyCallback),
            commands.registerCommand("rtags.showBaseClasses", showBaseClassesCallback));
    }

    dispose() : void
    {
        for (let d of this.disposables)
        {
            d.dispose();
        }
    }

    getTreeItem(element: InheritanceNode) : TreeItem | Thenable<TreeItem>
    {
        let label = element.name;
        if (element.nodeType !== NodeType.BaseRoot)
        {
            const location: string =
                basename(element.location.uri.fsPath) + ':' + (element.location.range.start.line + 1);
            label += " (" + location + ')';
        }
        let treeItem = new TreeItem(label, TreeItemCollapsibleState.Collapsed);
        if (element.nodeType !== NodeType.BaseRoot)
        {
            treeItem.contextValue = "rtagsLocation";
        }
        return treeItem;
    }

    getChildren(element?: InheritanceNode) : ProviderResult<InheritanceNode[]>
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
                (output: string) : InheritanceNode[] =>
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
                        "ClassDecl",
                        "StructDecl",
                        "TypeRef"
                    ];
                    if (!symbolKinds.includes(symbolKind))
                    {
                        return [];
                    }

                    let classType = ClassType.Derived;
                    const baseClasses = jsonObj.baseClasses;
                    if (baseClasses && (baseClasses.length !== 0))
                    {
                        classType = ClassType.Base;
                    }

                    let classLocation = new Location(document.uri, position);
                    const targets = jsonObj.targets;
                    if (targets && (targets.length !== 0))
                    {
                        classLocation = fromRtagsLocation(targets[0].location);
                    }

                    const node: InheritanceNode =
                    {
                        nodeType: NodeType.Root,
                        classType: classType,
                        name: symbolName,
                        location: classLocation,
                        document: document
                    };

                    return [node];
                };

            return runRc(args, (output) => { return output; }, document).then(resolveCallback);
        }

        if (element.nodeType === NodeType.Root)
        {
            let promise = getClasses(NodeType.Common,
                                     ClassType.Derived,
                                     element.location.uri,
                                     element.location.range.start,
                                     element.document);

            const resolveCallback =
                (derivedNodes: InheritanceNode[]) : InheritanceNode[] =>
                {
                    if (element.classType === ClassType.Base)
                    {
                        const baseRoot: InheritanceNode =
                        {
                            nodeType: NodeType.BaseRoot,
                            classType: ClassType.Base,
                            name: "[[Base]]",
                            location: element.location,
                            document: element.document
                        };

                        derivedNodes.unshift(baseRoot);
                    }

                    return derivedNodes;
                };

            return promise.then(resolveCallback);
        }

        return getClasses(NodeType.Common,
                          element.classType,
                          element.location.uri,
                          element.location.range.start,
                          element.document);
    }

    private refresh() : void
    {
        this.onDidChangeEmitter.fire();
    }

    private disposables: Disposable[] = [];
    private onDidChangeEmitter: EventEmitter<Nullable<InheritanceNode>> =
        new EventEmitter<Nullable<InheritanceNode>>();
    readonly onDidChangeTreeData: Event<Nullable<InheritanceNode>> = this.onDidChangeEmitter.event;
}
