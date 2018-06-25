'use strict';

import { commands, window, workspace, ExtensionContext, TextDocumentChangeEvent } from 'vscode';

import { spawn, spawnSync, SpawnOptions } from 'child_process';

import { setTimeout, clearTimeout } from 'timers';

import { Nullable, addProject, reindex } from './rtagsUtil';

import { RtagsCodeActionProvider } from './codeActionProvider';

import { RtagsCompletionProvider } from './completionProvider';

import { RtagsDefinitionProvider } from './definitionProvider';

import { RtagsSymbolProvider } from './symbolProvider';

import { CallHierarchy } from './callHierarchy';

function startDaemon() : void
{
    let rc = spawnSync("rc", ["--project", "--silent-query"]);
    if (rc.status !== 0)
    {
        let options: SpawnOptions =
        {
            detached: true,
            stdio: "ignore"
        };

        let rdm = spawn("rdm", [], options);

        if (rdm.pid)
        {
            rdm.unref();
            window.showInformationMessage("Started RTags daemon successfully");
        }
        else
        {
            window.showErrorMessage("Could not start RTags daemon; start it by running 'rdm'");
        }
    }
}

export function activate(context: ExtensionContext) : void
{
    startDaemon();

    let codeActionProvider = new RtagsCodeActionProvider;
    let completionProvider = new RtagsCompletionProvider;
    let definitionProvider = new RtagsDefinitionProvider;
    let symbolProvider = new RtagsSymbolProvider;
    let callHierarchy = new CallHierarchy;

    context.subscriptions.push(
        codeActionProvider,
        completionProvider,
        definitionProvider,
        symbolProvider,
        callHierarchy,
        commands.registerCommand("rtags.addProject", (uri) => { addProject(uri); }),
        commands.registerCommand("rtags.reindex", (uri) => { reindex(uri); }));

    let timerId: Nullable<NodeJS.Timer> = null;
    workspace.onDidChangeTextDocument(
        (event: TextDocumentChangeEvent) : void =>
        {
            if (timerId)
            {
                clearTimeout(timerId);
            }

            timerId = setTimeout(() : void =>
                                 {
                                     reindex(event.document);
                                     timerId = null;
                                 },
                                 1000);
        });

    workspace.onDidSaveTextDocument((doc) => { reindex(doc); });
}
