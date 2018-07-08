'use strict';

import { commands, languages, window, workspace, Disposable, TextDocument, TextDocumentChangeEvent, Uri,
         WorkspaceFolder, WorkspaceFoldersChangeEvent } from 'vscode';

import { SpawnOptions, spawn } from 'child_process';

import { setTimeout, clearTimeout } from 'timers';

import { Nullable, RtagsDocSelector, runRc, runRcSync } from './rtagsUtil';

export class RtagsManager implements Disposable
{
    constructor()
    {
        this.disposables.push(
            commands.registerCommand("rtags.freshenIndex", this.reindex, this),
            workspace.onDidChangeTextDocument(this.reindexOnChange, this),
            workspace.onDidSaveTextDocument(this.reindexOnSave, this),
            workspace.onDidChangeWorkspaceFolders(this.updateProjects, this));

        this.startRdm();

        this.addProjects(workspace.workspaceFolders);
    }

    public dispose() : void
    {
        for (let d of this.disposables)
        {
            d.dispose();
        }
    }

    public getProjectPaths() : Uri[]
    {
        return this.projectPaths;
    }

    public getProjectPath(uri: Uri) : Uri | undefined
    {
        return this.projectPaths.find((f) => { return (uri.fsPath.startsWith(f.fsPath)); });
    }

    public getCurrentProjectPath() : Thenable<Uri | undefined>
    {
        const processCallback =
            (output: string) : Uri | undefined =>
            {
                if (!output)
                {
                    return undefined;
                }
                const path = Uri.file(output.trim().replace(/\/$/, ""));
                const pathFound = this.projectPaths.some((p) => { return (p.fsPath === path.fsPath); });
                return (pathFound ? path : undefined);
            };

        return runRc(["--current-project"], processCallback);
    }

    public isInProject(uri: Uri) : boolean
    {
        return (this.getProjectPath(uri) !== undefined);
    }

    public getTextDocuments() : TextDocument[]
    {
        return workspace.textDocuments.filter((doc) => { return this.isInProject(doc.uri); });
    }

    private startRdm() : void
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

    private addProjects(folders?: WorkspaceFolder[]) : void
    {
        if (!folders || (folders.length === 0))
        {
            return;
        }

        let rtagsProjectPaths: Uri[] = [];

        const rc = runRcSync(["--project"]);
        if (rc.stdout)
        {
            rtagsProjectPaths = rc.stdout.trim().split('\n').map(
                (p) => { return Uri.file(p.replace(" <=", "").trim().replace(/\/$/, "")); });
        }

        for (const f of folders)
        {
            const projectAdded = rtagsProjectPaths.some((p) => { return (p.fsPath === f.uri.fsPath); });
            if (projectAdded)
            {
                if (this.projectPaths.indexOf(f.uri) === -1)
                {
                    this.projectPaths.push(f.uri);
                }
            }
            else
            {
                this.addProject(f.uri);
            }
        }
    }

    private addProject(uri: Uri) : void
    {
        const rc = runRcSync(["--load-compile-commands", uri.fsPath]);
        if (rc.status === 0)
        {
            this.projectPaths.push(uri);
            window.showInformationMessage("[RTags] Loading project: " + uri.fsPath);
        }
    }

    private removeProjects(folders?: WorkspaceFolder[]) : void
    {
        if (!folders)
        {
            return;
        }

        for (const f of folders)
        {
            const index = this.projectPaths.indexOf(f.uri);
            if (index !== -1)
            {
                this.projectPaths.splice(index, 1);
            }
        }
    }

    private updateProjects(event: WorkspaceFoldersChangeEvent) : void
    {
        this.removeProjects(event.removed);
        this.addProjects(event.added);
    }

    private reindex(document?: TextDocument, saved: boolean = false) : void
    {
        if (document)
        {
            if (!this.isInProject(document.uri) || (languages.match(RtagsDocSelector, document) === 0))
            {
                return;
            }

            const args =
            [
                saved ? "--check-reindex" : "--reindex",
                document.uri.fsPath
            ];

            runRc(args, (_unused) => {}, this.getTextDocuments());

            return;
        }

        const editor = window.activeTextEditor;
        if (editor)
        {
            const activeDocPath = editor.document.uri;

            if (!this.isInProject(activeDocPath))
            {
                return;
            }

            const args =
            [
                "--current-file",
                activeDocPath.fsPath,
                "--reindex"
            ];

            runRc(args, (_unused) => {}, this.getTextDocuments());

            return;
        }

        const resolveCallback =
            (projectPath?: Uri) : void =>
            {
                if (!projectPath)
                {
                    return;
                }

                window.showInformationMessage("Reindexing project: " + projectPath.fsPath);

                runRc(["--reindex"], (_unused) => {}, this.getTextDocuments());
            };

        this.getCurrentProjectPath().then(resolveCallback);
    }

    private reindexOnChange(event: TextDocumentChangeEvent) : void
    {
        if (event.contentChanges.length === 0)
        {
            return;
        }

        if (this.timerId)
        {
            clearTimeout(this.timerId);
        }

        this.timerId = setTimeout(() : void =>
                                  {
                                      this.reindex(event.document);
                                      this.timerId = null;
                                  },
                                  1000);
    }

    private reindexOnSave(document: TextDocument) : void
    {
        this.reindex(document, true);
    }

    private timerId: Nullable<NodeJS.Timer> = null;
    private projectPaths: Uri[] = [];
    private disposables: Disposable[] = [];
}
