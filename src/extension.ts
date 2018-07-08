'use strict';

import { commands, window, ExtensionContext } from 'vscode';

import { SpawnOptions, spawn } from 'child_process';

import { RtagsCodeActionProvider } from './codeActionProvider';

import { RtagsCompletionProvider } from './completionProvider';

import { RtagsDefinitionProvider } from './definitionProvider';

import { RtagsSymbolProvider } from './symbolProvider';

import { CallHierarchyProvider } from './callHierarchy';

import { InheritanceHierarchyProvider } from './inheritanceHierarchy';

import { RtagsManager } from './rtagsManager';

import { Locatable, jumpToLocation, runRcSync } from './rtagsUtil';

function startServer() : void
{
    const rc = runRcSync(["--current-project"]);
    if (rc.error)
    {
        window.showErrorMessage("[RTags] Could not run client");
        return;
    }

    if (rc.status !== 0)
    {
        const options: SpawnOptions =
        {
            detached: true,
            stdio: "ignore"
        };

        let rdm = spawn("rdm", ["--silent"], options);

        if (rdm.pid)
        {
            rdm.unref();
            window.showInformationMessage("[RTags] Started server successfully");
        }
        else
        {
            window.showErrorMessage("[RTags] Could not start server");
        }
    }
}

export function activate(context: ExtensionContext) : void
{
    startServer();

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
