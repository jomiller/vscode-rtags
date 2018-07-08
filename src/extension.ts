'use strict';

import { commands, window, ExtensionContext } from 'vscode';

import { SpawnOptions, spawn } from 'child_process';

import { RtagsCodeActionProvider } from './codeActionProvider';

import { RtagsCompletionProvider } from './completionProvider';

import { RtagsDefinitionProvider } from './definitionProvider';

import { RtagsSymbolProvider } from './symbolProvider';

import { CallHierarchyProvider } from './callHierarchy';

import { InheritanceHierarchyProvider } from './inheritanceHierarchy';

import { ProjectManager } from './rtagsManager';

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

    let projectManager = new ProjectManager;
    let codeActionProvider = new RtagsCodeActionProvider(projectManager);
    let completionProvider = new RtagsCompletionProvider(projectManager);
    let definitionProvider = new RtagsDefinitionProvider(projectManager);
    let symbolProvider = new RtagsSymbolProvider(projectManager);
    let callHierarchyProvider = new CallHierarchyProvider(projectManager);
    let inheritanceHierarchyProvider = new InheritanceHierarchyProvider(projectManager);

    const gotoLocationCallback =
        (element: Locatable) : void =>
        {
            jumpToLocation(element.location.uri, element.location.range);
        };

    context.subscriptions.push(
        projectManager,
        codeActionProvider,
        completionProvider,
        definitionProvider,
        symbolProvider,
        callHierarchyProvider,
        inheritanceHierarchyProvider,
        commands.registerCommand("rtags.gotoLocation", gotoLocationCallback));
}
