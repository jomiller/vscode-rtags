'use strict';

import { commands, languages, window, workspace, ExtensionContext, TextDocument, TextDocumentChangeEvent }
         from 'vscode';

import { spawn, spawnSync, SpawnOptions } from 'child_process';

import { setTimeout, clearTimeout } from 'timers';

import { Nullable, RtagsSelector, isUnsavedSourceFile, jumpToLocation, runRc } from './rtagsUtil';

import { RtagsCodeActionProvider } from './codeActionProvider';

import { RtagsCompletionProvider } from './completionProvider';

import { RtagsDefinitionProvider } from './definitionProvider';

import { RtagsSymbolProvider } from './symbolProvider';

import { Caller, CallHierarchyProvider } from './callHierarchy';

import { InheritanceNode, InheritanceHierarchyProvider } from './inheritanceHierarchy';

function startServer() : void
{
    const rc = spawnSync("rc", ["--current-project", "--silent-query"]);
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
        const unsaved: boolean = workspace.textDocuments.some((doc) => { return isUnsavedSourceFile(doc); });
        if (unsaved)
        {
            window.showInformationMessage("[RTags] Save all source files first before reindexing");
            return;
        }

        let promise = runRc(["--reindex", "--silent"], (_unused) => {});

        promise.then(() => { runRc(["--diagnose-all"], (_unused) => {}); });
    }
}

export function activate(context: ExtensionContext) : void
{
    startServer();

    let codeActionProvider = new RtagsCodeActionProvider;
    let completionProvider = new RtagsCompletionProvider;
    let definitionProvider = new RtagsDefinitionProvider;
    let symbolProvider = new RtagsSymbolProvider;
    let callHierarchyProvider = new CallHierarchyProvider;
    let inheritanceHierarchyProvider = new InheritanceHierarchyProvider;

    const gotoLocationCallback =
        (node: Caller | InheritanceNode) : void =>
        {
            jumpToLocation(node.location.uri, node.location.range);
        };

    context.subscriptions.push(
        codeActionProvider,
        completionProvider,
        definitionProvider,
        symbolProvider,
        callHierarchyProvider,
        inheritanceHierarchyProvider,
        commands.registerCommand("rtags.freshenIndex", () => { reindex(); }),
        commands.registerCommand("rtags.gotoLocation", gotoLocationCallback));

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
