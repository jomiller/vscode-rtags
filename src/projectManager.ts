'use strict';

import { commands, languages, window, workspace, Disposable, TextDocument, TextDocumentChangeEvent, Uri,
         WorkspaceFolder, WorkspaceFoldersChangeEvent } from 'vscode';

import { setTimeout, clearTimeout } from 'timers';

import { Nullable, RtagsSelector, runRc, runRcSync } from './rtagsUtil';

export class ProjectManager implements Disposable
{
    constructor()
    {
        this.disposables.push(
            commands.registerCommand("rtags.freshenIndex", this.reindex, this),
            workspace.onDidChangeTextDocument(this.reindexOnChange, this),
            workspace.onDidSaveTextDocument(this.reindexOnSave, this),
            workspace.onDidChangeWorkspaceFolders(this.updateProjects, this));

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
                const uri = Uri.file(output.trim().replace(/\/$/, ""));
                const pathFound = this.projectPaths.some((p) => { return (p.fsPath === uri.fsPath); });
                return (pathFound ? uri : undefined);
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

    private addProjects(folders?: WorkspaceFolder[]) : void
    {
        if (!folders || (folders.length === 0))
        {
            return;
        }

        let rc = runRcSync(["--project"]);
        if (rc.error)
        {
            return;
        }

        const rtagsProjectPaths = rc.stdout.trim().split('\n').map(
            (p) => { return Uri.file(p.replace(" <=", "").trim().replace(/\/$/, "")); });

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
        let rc = runRcSync(["--load-compile-commands", uri.fsPath]);
        if (!rc.error)
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
        let args = ["--silent"];

        if (document)
        {
            if (languages.match(RtagsSelector, document) === 0)
            {
                return;
            }

            args.push(saved ? "--check-reindex" : "--reindex", document.uri.fsPath);
        }
        else
        {
            const editor = window.activeTextEditor;
            if (editor)
            {
                args.push("--current-file", editor.document.uri.fsPath);
            }
            args.push("--reindex");
        }

        let promise = runRc(args, (_unused) => {}, this.getTextDocuments());

        if (!document)
        {
            promise.then(
                () : void =>
                {
                    const resolveCallback =
                        (projectPath?: Uri) : void =>
                        {
                            if (projectPath)
                            {
                                window.showInformationMessage("Reindexing project: " + projectPath.fsPath);
                            }
                        };

                    this.getCurrentProjectPath().then(resolveCallback);
                });
        }
    }

    private reindexOnChange(event: TextDocumentChangeEvent) : void
    {
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
