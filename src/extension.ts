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

import { commands, ExtensionContext } from 'vscode';

import { RtagsCommand } from './constants';

import { RtagsCodeActionProvider } from './codeActionProvider';

import { RtagsCompletionProvider } from './completionProvider';

import { RtagsReferenceProvider } from './referenceProvider';

import { RtagsSymbolProvider } from './symbolProvider';

import { CallHierarchyProvider } from './callHierarchy';

import { InheritanceHierarchyProvider } from './inheritanceHierarchy';

import { RtagsManager } from './rtagsManager';

import { Locatable, jumpToLocation } from './vscodeUtil';

export function activate(context: ExtensionContext) : void
{
    let rtagsManager = new RtagsManager(context.globalState, context.workspaceState);
    let codeActionProvider = new RtagsCodeActionProvider(rtagsManager);
    let completionProvider = new RtagsCompletionProvider(rtagsManager);
    let referenceProvider = new RtagsReferenceProvider(rtagsManager);
    let symbolProvider = new RtagsSymbolProvider(rtagsManager);
    let callHierarchyProvider = new CallHierarchyProvider(rtagsManager);
    let inheritanceHierarchyProvider = new InheritanceHierarchyProvider(rtagsManager);

    const goToLocationCallback =
        (element: Locatable) : void =>
        {
            jumpToLocation(element.location.uri, element.location.range);
        };

    context.subscriptions.push(
        rtagsManager,
        codeActionProvider,
        completionProvider,
        referenceProvider,
        symbolProvider,
        callHierarchyProvider,
        inheritanceHierarchyProvider,
        commands.registerCommand(RtagsCommand.GoToLocation, goToLocationCallback));
}
