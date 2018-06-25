'use strict';

import { commands, languages, window, workspace, ExtensionContext, TextDocument, TextDocumentChangeEvent }
         from 'vscode';

import { spawn, spawnSync, SpawnOptions } from 'child_process';

import { setTimeout, clearTimeout } from 'timers';

import { Nullable, RtagsSelector, runRc } from './rtagsUtil';

import { RtagsCodeActionProvider } from './codeActionProvider';

import { RtagsCompletionProvider } from './completionProvider';

import { RtagsDefinitionProvider } from './definitionProvider';

import { RtagsSymbolProvider } from './symbolProvider';

import { CallHierarchyProvider } from './callHierarchy';

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

/*
function addProject(uri: Uri) : void
{
    runRc(["--load-compile-commands", uri.fsPath],
          (output: string) : void =>
          {
              window.showInformationMessage(output);
          });
}
*/

function reindex(doc?: TextDocument) : void
{
    if (doc)
    {
        const uri = doc.uri;

        if (languages.match(RtagsSelector, doc) === 0)
        {
            return;
        }

        let promise = runRc(["--reindex", uri.fsPath],
                            (output: string) : boolean =>
                            {
                                return (output !== "No matches");
                            },
                            doc);

        promise.then(
            (reindexed: boolean) : void =>
            {
                if (reindexed)
                {
                    runRc(["--json", "--diagnose", uri.fsPath], (_unused) => {});
                }
            });
    }
    else
    {
        let promise = runRc(["--reindex"], (_unused) => {});

        promise.then(() => runRc(["--diagnose-all"], (_unused) => {}));
    }
}

export function activate(context: ExtensionContext) : void
{
    startDaemon();

    let codeActionProvider = new RtagsCodeActionProvider;
    let completionProvider = new RtagsCompletionProvider;
    let definitionProvider = new RtagsDefinitionProvider;
    let symbolProvider = new RtagsSymbolProvider;
    let callHierarchyProvider = new CallHierarchyProvider;

    context.subscriptions.push(
        codeActionProvider,
        completionProvider,
        definitionProvider,
        symbolProvider,
        callHierarchyProvider,
        commands.registerCommand("rtags.freshenIndex", () => { reindex(); }));

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
