'use strict';

import { commands, languages, window, workspace, ExtensionContext, TextDocument, TextDocumentChangeEvent }
         from 'vscode';

import { spawn, spawnSync, SpawnOptions } from 'child_process';

import { setTimeout, clearTimeout } from 'timers';

import { Nullable, Locatable, RtagsSelector, jumpToLocation, runRc } from './rtagsUtil';

import { RtagsCodeActionProvider } from './codeActionProvider';

import { RtagsCompletionProvider } from './completionProvider';

import { RtagsDefinitionProvider } from './definitionProvider';

import { RtagsSymbolProvider } from './symbolProvider';

import { CallHierarchyProvider } from './callHierarchy';

import { InheritanceHierarchyProvider } from './inheritanceHierarchy';

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

function reindex(document?: TextDocument) : void
{
    let args = ["--silent", "--reindex"];

    if (document)
    {
        if (languages.match(RtagsSelector, document) === 0)
        {
            return;
        }
        args.push(document.uri.fsPath);
    }
    else
    {
        const editor = window.activeTextEditor;
        if (editor)
        {
            args.push("--current-file", editor.document.uri.fsPath);
        }
    }

    let promise = runRc(args, (_unused) => {}, workspace.textDocuments);

    if (!document)
    {
        promise.then(
            () : void =>
            {
                const processCallback =
                    (output: string) : string =>
                    {
                        return output.trim();
                    };

                const resolveCallback =
                    (projectPath: string) : void =>
                    {
                        window.showInformationMessage("Reindexing project: " + projectPath);
                    };

                runRc(["--current-project"], processCallback).then(resolveCallback);
            });
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
        (element: Locatable) : void =>
        {
            jumpToLocation(element.location.uri, element.location.range);
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
