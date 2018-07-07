'use strict';

import { commands, window, ExtensionContext } from 'vscode';

import { spawn, SpawnOptions } from 'child_process';

import { RtagsCodeActionProvider } from './codeActionProvider';

import { RtagsCompletionProvider } from './completionProvider';

import { RtagsDefinitionProvider } from './definitionProvider';

import { RtagsSymbolProvider } from './symbolProvider';

import { CallHierarchyProvider } from './callHierarchy';

import { InheritanceHierarchyProvider } from './inheritanceHierarchy';

import { ProjectManager } from './projectManager';

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

        let rdm = spawn("rdm", [], options);

        if (rdm.pid)
        {
            rdm.unref();
            window.showInformationMessage("[RTags] Started server successfully");
        }
        else
        {
            window.showErrorMessage("[RTags] Could not start server; start it by running 'rdm'");
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
    let callHierarchyProvider = new CallHierarchyProvider;
    let inheritanceHierarchyProvider = new InheritanceHierarchyProvider;

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
