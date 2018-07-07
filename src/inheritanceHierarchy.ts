'use strict';

import { commands, window, Disposable, Event, EventEmitter, Location, Position, ProviderResult, TextEditor,
         TextEditorEdit, TreeDataProvider, TreeItem, TreeItemCollapsibleState, Uri } from 'vscode';

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
    This,
    Base,
    Derived
}

interface InheritanceNode extends Locatable
{
    nodeType: NodeType;
    classType: ClassType;
    name: string;
}

function getClasses(classType: ClassType, uri: Uri, position: Position) : Thenable<InheritanceNode[]>
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
                case ClassType.This:
                    if (baseIndex === -1)
                    {
                        startIndex = derivedIndex;
                    }
                    break;

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
                let startOffset = 2;
                let indent = 4;
                if (classType === ClassType.This)
                {
                    startOffset = 1;
                    indent = 2;
                }
                startIndex += startOffset;
                const classRegex = new RegExp("^ {" + indent.toString() + "}\\w.*");
                for (let i = startIndex; i <= endIndex; ++i)
                {
                    const classInfo = lines[i].match(classRegex);
                    if (classInfo)
                    {
                        const [name, loc] = classInfo[0].split('\t', 2).map((tok) => { return tok.trim(); });

                        const node: InheritanceNode =
                        {
                            nodeType: NodeType.Common,
                            classType: classType,
                            name: name,
                            location: fromRtagsLocation(loc)
                        };
                        nodes.push(node);
                    }
                }
            }

            return nodes;
        };

    return runRc(args, processCallback);
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
            (textEditor: TextEditor, _edit: TextEditorEdit) : void =>
            {
                const document = textEditor.document;
                const position = textEditor.selection.active;

                const resolveCallback =
                    (nodes: InheritanceNode[]) : void =>
                    {
                        if (nodes.length === 1)
                        {
                            jumpToLocation(nodes[0].location.uri, nodes[0].location.range);
                        }
                        else
                        {
                            const locations: Location[] = nodes.map((n) => { return n.location; });
                            commands.executeCommand("editor.action.showReferences",
                                                    document.uri,
                                                    position,
                                                    locations);
                        }
                    };

                getClasses(ClassType.Base, document.uri, position).then(resolveCallback);
            };

        this.disposables.push(
            window.registerTreeDataProvider("rtags.inheritanceHierarchy", this),
            commands.registerCommand("rtags.inheritanceHierarchy", inheritanceHierarchyCallback),
            commands.registerCommand("rtags.closeInheritanceHierarchy", closeInheritanceHierarchyCallback),
            commands.registerTextEditorCommand("rtags.showBaseClasses", showBaseClassesCallback));
    }

    public dispose() : void
    {
        for (let d of this.disposables)
        {
            d.dispose();
        }
    }

    public getTreeItem(element: InheritanceNode) : TreeItem | Thenable<TreeItem>
    {
        let label = element.name;
        if (element.nodeType !== NodeType.BaseRoot)
        {
            const lineNumber = element.location.range.start.line + 1;
            const location: string = basename(element.location.uri.fsPath) + ':' + lineNumber.toString();
            label += " (" + location + ')';
        }
        let treeItem = new TreeItem(label, TreeItemCollapsibleState.Collapsed);
        if (element.nodeType !== NodeType.BaseRoot)
        {
            treeItem.contextValue = "rtagsLocation";
        }
        return treeItem;
    }

    public getChildren(element?: InheritanceNode) : ProviderResult<InheritanceNode[]>
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

            const resolveCallback =
                (nodes: InheritanceNode[]) : Thenable<InheritanceNode[]> =>
                {
                    if (nodes.length === 0)
                    {
                        return Promise.resolve([]);
                    }

                    const baseResolveCallback =
                        (baseNodes: InheritanceNode[]) : InheritanceNode[] =>
                        {
                            const classType = (baseNodes.length === 0) ? ClassType.Derived : ClassType.Base;

                            const root: InheritanceNode =
                            {
                                nodeType: NodeType.Root,
                                classType: classType,
                                name: nodes[0].name,
                                location: nodes[0].location
                            };

                            return [root];
                        };

                    return getClasses(ClassType.Base, document.uri, position).then(baseResolveCallback);
                };

            return getClasses(ClassType.This, document.uri, position).then(resolveCallback);
        }

        if (element.nodeType === NodeType.Root)
        {
            let promise = getClasses(ClassType.Derived, element.location.uri, element.location.range.start);

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
                            location: element.location
                        };

                        derivedNodes.unshift(baseRoot);
                    }

                    return derivedNodes;
                };

            return promise.then(resolveCallback);
        }

        return getClasses(element.classType, element.location.uri, element.location.range.start);
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
