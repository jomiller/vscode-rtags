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

import { RtagsCodeActionProvider } from './codeActionProvider';

import { RtagsCompletionProvider } from './completionProvider';

import { RtagsDefinitionProvider } from './definitionProvider';

import { RtagsSymbolProvider } from './symbolProvider';

import { CallHierarchyProvider } from './callHierarchy';

import { InheritanceHierarchyProvider } from './inheritanceHierarchy';

import { RtagsManager } from './rtagsManager';

import { Locatable, jumpToLocation } from './rtagsUtil';

export function activate(context: ExtensionContext) : void
{
    let rtagsManager = new RtagsManager;
    let codeActionProvider = new RtagsCodeActionProvider(rtagsManager);
    let completionProvider = new RtagsCompletionProvider(rtagsManager);
    let definitionProvider = new RtagsDefinitionProvider(rtagsManager);
    let symbolProvider = new RtagsSymbolProvider(rtagsManager);
    let callHierarchyProvider = new CallHierarchyProvider(rtagsManager);
    let inheritanceHierarchyProvider = new InheritanceHierarchyProvider(rtagsManager);

    const gotoLocationCallback =
        (element: Locatable) : void =>
        {
            jumpToLocation(element.location.uri, element.location.range);
        };

    context.subscriptions.push(
        rtagsManager,
        codeActionProvider,
        completionProvider,
        definitionProvider,
        symbolProvider,
        callHierarchyProvider,
        inheritanceHierarchyProvider,
        commands.registerCommand("rtags.gotoLocation", gotoLocationCallback));
}
