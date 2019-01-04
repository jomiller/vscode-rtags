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

import { RtagsManager } from './rtagsManager';

import { Nullable, Optional, Locatable, fromRtagsLocation, toRtagsLocation, jumpToLocation, showContribution,
         hideContribution, showReferences, runRc } from './rtagsUtil';

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

function getClasses(classType: ClassType, uri: Uri, position: Position) : Promise<Optional<InheritanceNode[]>>
{
    const location = toRtagsLocation(uri, position);

    const args =
    [
        "--class-hierarchy",
        location,
        "--absolute-path",
        "--no-context"
    ];

    const processCallback =
        (output: string) : InheritanceNode[] =>
        {
            let nodes: InheritanceNode[] = [];

            const trimmedOutput = output.trim();
            const lines: string[] = (trimmedOutput.length !== 0) ? trimmedOutput.split('\n') : [];
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
                        const [name, loc] = classInfo[0].split(/\t+/, 2).map((tok) => { return tok.trim(); });

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

export async function getDerivedClasses(uri: Uri, position: Position) : Promise<Optional<Location[]>>
{
    const nodes = await getClasses(ClassType.Derived, uri, position);
    if (!nodes)
    {
        return undefined;
    }

    return nodes.map((n) => { return n.location; });
}

export class InheritanceHierarchyProvider implements TreeDataProvider<InheritanceNode>, Disposable
{
    constructor(rtagsMgr: RtagsManager)
    {
        this.rtagsMgr = rtagsMgr;

        const inheritanceHierarchyCallback =
            () : void =>
            {
                showContribution("rtags.inheritanceHierarchy");
                this.refresh();
            };

        const closeInheritanceHierarchyCallback =
            () : void =>
            {
                hideContribution("rtags.inheritanceHierarchy");
                this.refresh();
            };

        const showBaseCallback =
            async (textEditor: TextEditor, _edit: TextEditorEdit) : Promise<void> =>
            {
                const document = textEditor.document;
                const position = textEditor.selection.active;

                if (!this.rtagsMgr.isInProject(document.uri))
                {
                    return;
                }

                let nodes = await getClasses(ClassType.Base, document.uri, position);
                if (!nodes)
                {
                    nodes = [];
                }

                if (nodes.length === 1)
                {
                    jumpToLocation(nodes[0].location.uri, nodes[0].location.range);
                }
                else
                {
                    const locations: Location[] = nodes.map((n) => { return n.location; });
                    showReferences(document.uri, position, locations);
                }
            };

        this.disposables.push(
            window.registerTreeDataProvider("rtags.inheritanceHierarchy", this),
            commands.registerCommand("rtags.inheritanceHierarchy", inheritanceHierarchyCallback),
            commands.registerCommand("rtags.closeInheritanceHierarchy", closeInheritanceHierarchyCallback),
            commands.registerTextEditorCommand("rtags.showBase", showBaseCallback));
    }

    public dispose() : void
    {
        this.disposables.forEach((d) => { d.dispose(); });
    }

    public getTreeItem(element: InheritanceNode) : TreeItem | Thenable<TreeItem>
    {
        let label = element.name;
        if (element.nodeType !== NodeType.BaseRoot)
        {
            const lineNumber = element.location.range.start.line + 1;
            const location: string = path.basename(element.location.uri.fsPath) + ':' + lineNumber.toString();
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

            const document = editor.document;
            const position = editor.selection.active;

            if (!this.rtagsMgr.isInProject(document.uri))
            {
                return [];
            }

            const resolveCallback =
                async (nodes?: InheritanceNode[]) : Promise<InheritanceNode[]> =>
                {
                    if (!nodes || (nodes.length === 0))
                    {
                        return [];
                    }

                    const baseNodes = await getClasses(ClassType.Base, document.uri, position);

                    if (!baseNodes)
                    {
                        return [];
                    }

                    const classType = (baseNodes.length !== 0) ? ClassType.Base : ClassType.Derived;

                    const root: InheritanceNode =
                    {
                        nodeType: NodeType.Root,
                        classType: classType,
                        name: nodes[0].name,
                        location: nodes[0].location
                    };

                    return [root];
                };

            return getClasses(ClassType.This, document.uri, position).then(resolveCallback);
        }

        if (element.nodeType === NodeType.Root)
        {
            let promise = getClasses(ClassType.Derived, element.location.uri, element.location.range.start);

            const resolveCallback =
                (derivedNodes?: InheritanceNode[]) : InheritanceNode[] =>
                {
                    if (!derivedNodes)
                    {
                        return [];
                    }

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

    private rtagsMgr: RtagsManager;
    private onDidChangeEmitter: EventEmitter<Nullable<InheritanceNode>> =
        new EventEmitter<Nullable<InheritanceNode>>();
    readonly onDidChangeTreeData: Event<Nullable<InheritanceNode>> = this.onDidChangeEmitter.event;
    private disposables: Disposable[] = [];
}
