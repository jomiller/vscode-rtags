'use strict';

import { commands, languages, window, workspace, Disposable, TextDocument, TextDocumentChangeEvent, Uri,
         WorkspaceFolder, WorkspaceFoldersChangeEvent } from 'vscode';

import { ChildProcess, ExecFileOptionsWithStringEncoding, SpawnOptions, SpawnSyncOptionsWithStringEncoding,
         SpawnSyncReturns, execFile, spawn, spawnSync } from 'child_process';

import { setTimeout, clearTimeout, setInterval, clearInterval } from 'timers';

import { existsSync } from 'fs';

import { Nullable, RtagsDocSelector, isUnsavedSourceFile } from './rtagsUtil';

function getRcExecutable() : string
{
    const config = workspace.getConfiguration("rtags");
    return config.get("rcExecutable", "rc");
}

function isIndexing() : boolean
{
    const rc = runRcSync(["--is-indexing"]);
    return (rc.stdout === "1");
}

export function runRc(args: string[], process: (stdout: string) => any, documents: TextDocument[] = []) :
    Thenable<any>
{
    const executorCallback =
        (resolve: (value?: any) => any, _reject: (reason?: any) => any) : void =>
        {
            const unsavedDocs = documents.filter((doc) => { return isUnsavedSourceFile(doc); });
            for (const doc of unsavedDocs)
            {
                const unsavedFile = doc.uri.fsPath + ':' + doc.getText().length.toString();
                args.push("--unsaved-file", unsavedFile);
            }

            const options: ExecFileOptionsWithStringEncoding =
            {
                encoding: "utf8",
                maxBuffer: 4 * 1024 * 1024
            };

            const exitCallback =
                (error: Error | null, stdout: string, stderr: string) : void =>
                {
                    if (error)
                    {
                        if ((stdout && !stdout.startsWith("null")) || stderr)
                        {
                            let message: string = "[RTags] ";
                            if (stderr)
                            {
                                message += "Client error: " + stderr;
                            }
                            else if (error.message)
                            {
                                message += "Client error: " + error.message;
                            }
                            else
                            {
                                message += "Unknown client error";
                            }
                            window.showErrorMessage(message);
                        }
                        resolve([]);
                        return;
                    }
                    resolve(process(stdout));
                };

            let rc = execFile(getRcExecutable(), args, options, exitCallback);

            for (const doc of unsavedDocs)
            {
                rc.stdin.write(doc.getText());
            }
            if (unsavedDocs.length !== 0)
            {
                rc.stdin.end();
            }
        };

    return new Promise(executorCallback);
}

export function runRcSync(args: string[]) : SpawnSyncReturns<string>
{
    const options: SpawnSyncOptionsWithStringEncoding =
    {
        encoding: "utf8"
    };

    return spawnSync(getRcExecutable(), args, options);
}

export function runRcPipe(args: string[]) : ChildProcess
{
    const options: SpawnOptions =
    {
        stdio: "pipe"
    };

    return spawn(getRcExecutable(), args, options);
}

function startRdm() : void
{
    const config = workspace.getConfiguration("rtags");
    const autoLaunchRdm: boolean = config.get("autoLaunchRdm", true);
    if (!autoLaunchRdm)
    {
        return;
    }

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

        const rdmExecutable: string = config.get("rdmExecutable", "rdm");
        const rdmArguments: string[] = config.get("rdmArguments", []);

        let rdm = spawn(rdmExecutable, rdmArguments, options);

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

export class RtagsManager implements Disposable
{
    constructor()
    {
        this.disposables.push(
            commands.registerCommand("rtags.freshenIndex", this.reindex, this),
            workspace.onDidChangeTextDocument(this.reindexOnChange, this),
            workspace.onDidSaveTextDocument(this.reindexOnSave, this),
            workspace.onDidChangeWorkspaceFolders(this.updateProjects, this));

        startRdm();

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
                this.projectQueue.push(f.uri);
                this.processProjectQueue();
            }
        }
    }

    private processProjectQueue() : void
    {
        if (!this.loadTimer)
        {
            const uri = this.projectQueue.shift();
            if (uri)
            {
                this.loadProject(uri);
            }
        }
    }

    private loadProject(uri: Uri) : void
    {
        if (existsSync(uri.fsPath + "/compile_commands.json"))
        {
            const rc = runRcSync(["--load-compile-commands", uri.fsPath]);
            if (rc.status === 0)
            {
                window.showInformationMessage("[RTags] Loading project: " + uri.fsPath);
                this.finishLoadingProject(uri);
            }
        }
    }

    private finishLoadingProject(uri: Uri) : void
    {
        this.loadTimer =
            setInterval(() : void =>
                        {
                            if (!isIndexing() && this.loadTimer)
                            {
                                clearInterval(this.loadTimer);
                                this.loadTimer = null;
                                this.projectPaths.push(uri);
                                window.showInformationMessage("[RTags] Finished loading project: " + uri.fsPath);
                                this.processProjectQueue();
                            }
                        },
                        5000);
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

        if (this.reindexTimer)
        {
            clearTimeout(this.reindexTimer);
        }

        this.reindexTimer =
            setTimeout(() : void =>
                       {
                           this.reindex(event.document);
                           this.reindexTimer = null;
                       },
                       1000);
    }

    private reindexOnSave(document: TextDocument) : void
    {
        this.reindex(document, true);
    }

    private reindexTimer: Nullable<NodeJS.Timer> = null;
    private loadTimer: Nullable<NodeJS.Timer> = null;
    private projectQueue: Uri[] = [];
    private projectPaths: Uri[] = [];
    private disposables: Disposable[] = [];
}
