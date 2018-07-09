'use strict';

import { commands, window, workspace, ConfigurationChangeEvent, ExtensionContext } from 'vscode';

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

    const changeConfigCallback =
        (event: ConfigurationChangeEvent) : void =>
        {
            if (event.affectsConfiguration("rtags"))
            {
                const reload = "Reload";
                const message = "Please reload to apply the configuration change";

                const resolveCallback =
                    (selected?: string) : void =>
                    {
                        if (selected === reload)
                        {
                            commands.executeCommand("workbench.action.reloadWindow");
                        }
                    };

                window.showInformationMessage(message, reload).then(resolveCallback);
            }
        };

    context.subscriptions.push(
        rtagsManager,
        codeActionProvider,
        completionProvider,
        definitionProvider,
        symbolProvider,
        callHierarchyProvider,
        inheritanceHierarchyProvider,
        commands.registerCommand("rtags.gotoLocation", gotoLocationCallback),
        workspace.onDidChangeConfiguration(changeConfigCallback));
}
