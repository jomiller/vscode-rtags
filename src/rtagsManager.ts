'use strict';

import { commands, languages, window, workspace, Diagnostic, DiagnosticCollection, DiagnosticSeverity, Disposable,
         Position, Range, TextDocument, TextDocumentChangeEvent, Uri, WorkspaceFolder, WorkspaceFoldersChangeEvent }
         from 'vscode';

import { ChildProcess, ExecFileOptionsWithStringEncoding, SpawnOptions, SpawnSyncOptionsWithStringEncoding,
         SpawnSyncReturns, execFile, spawn, spawnSync } from 'child_process';

import { setTimeout, clearTimeout, setInterval, clearInterval } from 'timers';

import { stat } from 'fs';

import { Nullable, Optional, isSourceFile, isUnsavedSourceFile, parseJson } from './rtagsUtil';

enum IndexType
{
    Load,
    Reindex
}

interface Project
{
    uri: Uri;
    indexType: IndexType;
}

function getProjectAction(project: Project, capitalize: boolean = false) : string
{
    const projectAction: string = (project.indexType === IndexType.Load) ? "loading" : "reindexing";
    return (capitalize ? (projectAction.charAt(0).toUpperCase() + projectAction.slice(1)) : projectAction);
}

function fileExists(path: string) : Promise<boolean>
{
    return new Promise<boolean>(
        (resolve, _reject) =>
        {
            stat(path, (err, _stats) => { resolve(!err || (err.code !== "ENOENT")); });
        });
}

async function sleep(msec: number) : Promise<void>
{
    return new Promise<void>(
        (resolve, _reject) =>
        {
            setTimeout(resolve, msec);
        });
}

function getRcExecutable() : string
{
    const config = workspace.getConfiguration("rtags");
    return config.get("rcExecutable", "rc");
}

export function runRc<T>(args: string[], process: (stdout: string) => T, documents: TextDocument[] = []) :
    Thenable<Optional<T>>
{
    const executorCallback =
        (resolve: (value?: T) => void, _reject: (reason?: any) => void) : void =>
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
                (error: Nullable<Error>, stdout: string, stderr: string) : void =>
                {
                    if (error)
                    {
                        const stderrMsg = stderr.trim();
                        const stdoutMsg = stdout.trim();
                        if (stderrMsg || (stdoutMsg && (stdoutMsg !== "null") && (stdoutMsg !== "Not indexed")))
                        {
                            let message: string = "[RTags] ";
                            if (error.message)
                            {
                                message += error.message + " (";
                            }
                            message += "Client error: " + (stderrMsg ? stderrMsg : stdoutMsg);
                            if (error.message)
                            {
                                message += ')';
                            }
                            window.showErrorMessage(message);
                        }

                        resolve();
                    }
                    else
                    {
                        resolve(process(stdout));
                    }
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

    return new Promise<T>(executorCallback);
}

function runRcSync(args: string[], documents: TextDocument[] = []) : SpawnSyncReturns<string>
{
    const unsavedDocs = documents.filter((doc) => { return isUnsavedSourceFile(doc); });
    let inputLength = 0;
    unsavedDocs.forEach((doc) => { inputLength += doc.getText().length; });
    let inputBuffer = (inputLength !== 0) ? Buffer.allocUnsafe(inputLength) : undefined;

    let inputOffset = 0;
    for (const doc of unsavedDocs)
    {
        const textLength = doc.getText().length;
        const unsavedFile = doc.uri.fsPath + ':' + textLength.toString();
        args.push("--unsaved-file", unsavedFile);
        if (inputBuffer)
        {
            inputOffset += inputBuffer.write(doc.getText(), inputOffset, textLength, "utf8");
        }
    }

    const options: SpawnSyncOptionsWithStringEncoding =
    {
        encoding: "utf8",
        input: inputBuffer
    };

    return spawnSync(getRcExecutable(), args, options);
}

function runRcPipe(args: string[]) : ChildProcess
{
    const options: SpawnOptions =
    {
        stdio: "pipe"
    };

    return spawn(getRcExecutable(), args, options);
}

async function startRdm() : Promise<void>
{
    const config = workspace.getConfiguration("rtags");
    const autoLaunchRdm: boolean = config.get("autoLaunchRdm", true);
    if (!autoLaunchRdm)
    {
        return;
    }

    let rc = runRcSync(["--current-project"]);
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

            // Wait for rc to connect to rdm
            const delayMsec = 1000;
            const timeoutMsec = 30 * delayMsec;
            for (let ms = 0; ms < timeoutMsec; ms += delayMsec)
            {
                rc = runRcSync(["--current-project"]);
                if (rc.status === 0)
                {
                    break;
                }
                await sleep(delayMsec);
            }
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
        const config = workspace.getConfiguration("rtags");
        this.diagnosticsEnabled = config.get("enableDiagnostics", true);
        if (this.diagnosticsEnabled)
        {
            this.diagnosticCollection = languages.createDiagnosticCollection("rtags");
            this.disposables.push(this.diagnosticCollection);
        }

        (async () =>
        {
            await startRdm();
            this.startDiagnostics();
            this.addProjects(workspace.workspaceFolders);
        })();

        this.disposables.push(
            commands.registerCommand("rtags.reindexActiveFolder", this.reindexActiveProject, this),
            commands.registerCommand("rtags.reindexWorkspace", this.reindexProjects, this),
            workspace.onDidChangeTextDocument(this.reindexChangedDocument, this),
            workspace.onDidSaveTextDocument(this.reindexSavedDocument, this),
            workspace.onDidChangeWorkspaceFolders(this.updateProjects, this));
    }

    public dispose() : void
    {
        this.stopDiagnostics();

        for (let d of this.disposables)
        {
            d.dispose();
        }
    }

    public getProjectPaths() : Uri[]
    {
        return this.projectPaths;
    }

    public getProjectPath(uri: Uri) : Optional<Uri>
    {
        const candidatePaths = this.projectPaths.filter((p) => { return (uri.fsPath.startsWith(p.fsPath + '/')); });
        let projectPath = candidatePaths.pop();
        for (const path of candidatePaths)
        {
            // Assume that the URI belongs to the project with the deepest path
            if (projectPath && (path.fsPath.length > projectPath.fsPath.length))
            {
                projectPath = path;
            }
        }
        return projectPath;
    }

    public isInProject(uri: Uri) : boolean
    {
        return (this.getProjectPath(uri) !== undefined);
    }

    public isInLoadingProject(uri: Uri) : boolean
    {
        if (!this.currentIndexingProject || (this.currentIndexingProject.indexType !== IndexType.Load))
        {
            return false;
        }

        const loadingProjectPath = this.currentIndexingProject.uri;

        if (!uri.fsPath.startsWith(loadingProjectPath.fsPath + '/'))
        {
            return false;
        }

        const projectPath = this.getProjectPath(uri);
        if (!projectPath)
        {
            return true;
        }

        // Assume that the URI belongs to the project with the deepest path
        return (loadingProjectPath.fsPath.length > projectPath.fsPath.length);
    }

    public getTextDocuments() : TextDocument[]
    {
        return workspace.textDocuments.filter((doc) => { return this.isInProject(doc.uri); });
    }

    private async addProjects(folders?: WorkspaceFolder[]) : Promise<void>
    {
        if (!folders || (folders.length === 0))
        {
            return;
        }

        let rtagsProjectPaths: Uri[] = [];

        const output = await runRc(["--project"], (output: string) => { return output.trim(); });
        if (output)
        {
            rtagsProjectPaths = output.split('\n').map(
                (p) => { return Uri.file(p.replace(" <=", "").trim().replace(/\/$/, "")); });
        }

        function diagnoseProject(uri: Uri) : void
        {
            const args =
            [
                "--project",
                uri.fsPath,
                "--diagnose-all"
            ];

            runRc(args, (_unused) => {});
        }

        // Consider only VS Code workspace folders, and ignore RTags projects that are not known to VS Code
        for (const f of folders)
        {
            const projectExists = rtagsProjectPaths.some((p) => { return (p.fsPath === f.uri.fsPath); });
            if (projectExists)
            {
                // The project is already loaded into RTags
                this.projectPaths.push(f.uri);
                if (this.diagnosticsEnabled)
                {
                    // Resend diagnostics for all files in the project
                    diagnoseProject(f.uri);
                }
            }
            else
            {
                // Add the project to the indexing queue
                const project: Project = {uri: f.uri, indexType: IndexType.Load};
                this.indexNextProject(project);
            }
        }
    }

    private async removeProjects(folders?: WorkspaceFolder[]) : Promise<void>
    {
        if (!folders)
        {
            return;
        }

        for (const f of folders)
        {
            if (this.currentIndexingProject && (f.uri.fsPath === this.currentIndexingProject.uri.fsPath))
            {
                this.currentIndexingProject = null;
            }

            this.projectIndexingQueue = this.projectIndexingQueue.filter((p) => { return (p.uri.fsPath !== f.uri.fsPath); });

            const index = this.projectPaths.findIndex((p) => { return (p.fsPath === f.uri.fsPath); });
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

    private reindexDocument(document: TextDocument, saved: boolean = false) : void
    {
        if (!isSourceFile(document) || !this.isInProject(document.uri))
        {
            return;
        }

        const args =
        [
            saved ? "--check-reindex" : "--reindex",
            document.uri.fsPath
        ];

        runRc(args, (_unused) => {}, this.getTextDocuments());
    }

    private reindexChangedDocument(event: TextDocumentChangeEvent) : void
    {
        if (event.contentChanges.length === 0)
        {
            return;
        }

        if (this.reindexDelayTimer)
        {
            clearTimeout(this.reindexDelayTimer);
        }

        this.reindexDelayTimer =
            setTimeout(() : void =>
                       {
                           this.reindexDocument(event.document);
                           this.reindexDelayTimer = null;
                       },
                       1000);
    }

    private reindexSavedDocument(document: TextDocument) : void
    {
        this.reindexDocument(document, true);
    }

    private reindexActiveProject() : void
    {
        const editor = window.activeTextEditor;
        if (!editor)
        {
            return;
        }

        const projectPath = this.getProjectPath(editor.document.uri);
        if (!projectPath)
        {
            return;
        }

        // Reindex the project to which the active document belongs
        const project: Project = {uri: projectPath, indexType: IndexType.Reindex};
        this.indexNextProject(project);
    }

    private reindexProjects() : void
    {
        for (const path of this.projectPaths)
        {
            const project: Project = {uri: path, indexType: IndexType.Reindex};
            this.indexNextProject(project);
        }
    }

    private async indexNextProject(enqueuedProject?: Project) : Promise<void>
    {
        if (enqueuedProject)
        {
            this.projectIndexingQueue.push(enqueuedProject);

            if (this.currentIndexingProject || (this.projectIndexingQueue.length > 1))
            {
                window.showInformationMessage("[RTags] Enqueued project for " + getProjectAction(enqueuedProject) +
                                              ": " + enqueuedProject.uri.fsPath);
            }
        }

        // Allow indexing only one project at a time because RTags reports only a global status of whether or not
        // it is currently indexing
        while (!this.currentIndexingProject && (this.projectIndexingQueue.length !== 0))
        {
            const dequeuedProject = this.projectIndexingQueue.shift();
            this.currentIndexingProject = dequeuedProject ? dequeuedProject : null;

            if (this.currentIndexingProject)
            {
                const projectPath = this.currentIndexingProject.uri.fsPath;

                switch (this.currentIndexingProject.indexType)
                {
                    case IndexType.Load:
                    {
                        let status: Optional<boolean> = await fileExists(projectPath + "/compile_commands.json");
                        if (status)
                        {
                            status = await runRc(["--load-compile-commands", projectPath],
                                                 (_unused) => { return true; });
                        }
                        if (!status)
                        {
                            this.currentIndexingProject = null;
                        }
                        break;
                    }

                    case IndexType.Reindex:
                    {
                        const status = await runRc(["--project", projectPath, "--reindex"],
                                                   (_unused) => { return true; },
                                                   this.getTextDocuments());
                        if (!status)
                        {
                            this.currentIndexingProject = null;
                        }
                        break;
                    }
                }

                if (this.currentIndexingProject)
                {
                    window.showInformationMessage("[RTags] " + getProjectAction(this.currentIndexingProject, true) +
                                                  " project: " + projectPath);
                    this.finishIndexingProject();
                }
            }
        }
    }

    private finishIndexingProject() : void
    {
        const processCallback =
            (output: string) : void =>
            {
                const indexing = (output.trim() === "1");
                if (!indexing)
                {
                    if (this.indexPollTimer)
                    {
                        clearInterval(this.indexPollTimer);
                        this.indexPollTimer = null;
                    }
                    if (this.currentIndexingProject)
                    {
                        window.showInformationMessage("[RTags] Finished " +
                                                      getProjectAction(this.currentIndexingProject) + " project: " +
                                                      this.currentIndexingProject.uri.fsPath);

                        if (this.currentIndexingProject.indexType === IndexType.Load)
                        {
                            this.projectPaths.push(this.currentIndexingProject.uri);
                        }
                        this.currentIndexingProject = null;
                    }
                    this.indexNextProject();
                }
            };

        // Keep polling RTags until it is finished indexing the project
        this.indexPollTimer =
            setInterval(() : void =>
                        {
                            runRc(["--is-indexing"], processCallback);
                        },
                        5000);
    }

    private startDiagnostics() : void
    {
        if (!this.diagnosticsEnabled)
        {
            return;
        }

        // Start a separate process for receiving asynchronous diagnostics
        this.diagnosticProcess = runRcPipe(["--json", "--diagnostics"]);
        if (!this.diagnosticProcess.pid)
        {
            window.showErrorMessage("[RTags] Could not start diagnostics");
            this.diagnosticProcess = null;
            return;
        }

        const dataCallback =
            (data: string) : void =>
            {
                this.unprocessedDiagnostics = this.processDiagnostics(this.unprocessedDiagnostics + data);
            };

        this.diagnosticProcess.stdout.on("data", dataCallback);

        const exitCallback =
            (_code: number, signal: string) : void =>
            {
                if (this.diagnosticCollection)
                {
                    this.diagnosticCollection.clear();
                }
                this.unprocessedDiagnostics = "";
                if (signal !== "SIGTERM")
                {
                    // Restart the diagnostics process if it was killed unexpectedly
                    window.showErrorMessage("[RTags] Diagnostics stopped; restarting");
                    setTimeout(() => { this.startDiagnostics(); }, 5000);
                }
            };

        this.diagnosticProcess.on("exit", exitCallback);
    }

    private stopDiagnostics() : void
    {
        if (this.diagnosticProcess)
        {
            this.diagnosticProcess.kill("SIGTERM");
            this.diagnosticProcess = null;
        }
    }

    private processDiagnostics(data: string) : string
    {
        let end: number;
        while ((end = data.indexOf('\n')) !== -1)
        {
            this.processDiagnosticsLine(data.slice(0, end));
            data = data.substr(end + 1);
        }

        return data.trim();
    }

    private processDiagnosticsLine(output: string) : void
    {
        if (output.trim().length === 0)
        {
            return;
        }

        const jsonObj = parseJson(output);
        if (!jsonObj)
        {
            window.showErrorMessage("[RTags] Diagnostics parse error: " + output);
            return;
        }

        if (!jsonObj.checkStyle)
        {
            return;
        }

        for (const file in jsonObj.checkStyle)
        {
            if (!jsonObj.checkStyle.hasOwnProperty(file))
            {
                continue;
            }

            const uri = Uri.file(file);

            if (!this.isInProject(uri) && !this.isInLoadingProject(uri))
            {
                continue;
            }

            let diagnostics: Diagnostic[] = [];

            for (const d of jsonObj.checkStyle[file])
            {
                try
                {
                    const pos = new Position(d.line - 1, d.column - 1);

                    const diag: Diagnostic =
                    {
                        message: d.message,
                        range: new Range(pos, pos),
                        severity: DiagnosticSeverity.Error,
                        source: "RTags",
                        code: 0
                    };
                    diagnostics.push(diag);
                }
                catch (_err)
                {
                }
            }

            if (this.diagnosticCollection)
            {
                this.diagnosticCollection.set(uri, diagnostics);
            }
        }
    }

    private projectIndexingQueue: Project[] = [];
    private currentIndexingProject: Nullable<Project> = null;
    private projectPaths: Uri[] = [];
    private diagnosticsEnabled: boolean = true;
    private diagnosticCollection: Nullable<DiagnosticCollection> = null;
    private diagnosticProcess: Nullable<ChildProcess> = null;
    private unprocessedDiagnostics: string = "";
    private reindexDelayTimer: Nullable<NodeJS.Timer> = null;
    private indexPollTimer: Nullable<NodeJS.Timer> = null;
    private disposables: Disposable[] = [];
}
