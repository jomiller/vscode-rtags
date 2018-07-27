'use strict';

import { commands, languages, window, workspace, Diagnostic, DiagnosticCollection, DiagnosticSeverity, Disposable,
         Position, Range, TextDocument, TextDocumentChangeEvent, Uri, WorkspaceFolder, WorkspaceFoldersChangeEvent }
         from 'vscode';

import { ChildProcess, ExecFileOptionsWithStringEncoding, SpawnOptions, SpawnSyncOptionsWithStringEncoding,
         SpawnSyncReturns, execFile, spawn, spawnSync } from 'child_process';

import { setTimeout, clearTimeout, setInterval, clearInterval } from 'timers';

import { existsSync } from 'fs';

import { Nullable, Optional, isSourceFile, isUnsavedSourceFile } from './rtagsUtil';

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

function getRcExecutable() : string
{
    const config = workspace.getConfiguration("rtags");
    return config.get("rcExecutable", "rc");
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
        startRdm();

        const config = workspace.getConfiguration("rtags");
        this.diagnosticsEnabled = config.get("enableDiagnostics", true);
        if (this.diagnosticsEnabled)
        {
            this.diagnosticCollection = languages.createDiagnosticCollection("rtags");
            this.disposables.push(this.diagnosticCollection);
            this.startDiagnostics();
        }

        this.disposables.push(
            commands.registerCommand("rtags.freshenIndex", this.reindexActiveProject, this),
            workspace.onDidChangeTextDocument(this.reindexChangedDocument, this),
            workspace.onDidSaveTextDocument(this.reindexSavedDocument, this),
            workspace.onDidChangeWorkspaceFolders(this.updateProjects, this));

        this.addProjects(workspace.workspaceFolders);
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
        const candidatePaths = this.projectPaths.filter((p) => { return (uri.fsPath.startsWith(p.fsPath)); });
        let projectPath = candidatePaths.pop();
        for (const p of candidatePaths)
        {
            // Assume that the URI belongs to the project with the deepest path
            if (projectPath && (p.fsPath.length > projectPath.fsPath.length))
            {
                projectPath = p;
            }
        }
        return projectPath;
    }

    public getCurrentProjectPath() : Thenable<Optional<string>>
    {
        const processCallback =
            (output: string) : Optional<string> =>
            {
                if (!output)
                {
                    return undefined;
                }
                const path = output.trim().replace(/\/$/, "");
                const pathExists = this.projectPaths.some((p) => { return (p.fsPath === path); });
                return (pathExists ? path : undefined);
            };

        return runRc(["--current-project"], processCallback);
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

        if (!uri.fsPath.startsWith(loadingProjectPath.fsPath))
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
                if (this.projectPaths.indexOf(f.uri) === -1)
                {
                    this.projectPaths.push(f.uri);
                    if (this.diagnosticsEnabled)
                    {
                        // Resend diagnostics for all files in the project
                        diagnoseProject(f.uri);
                    }
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
        if (editor)
        {
            // Reindex the project to which the active document belongs

            const projectPath = this.getProjectPath(editor.document.uri);
            if (!projectPath)
            {
                return;
            }

            // Add the project to the indexing queue
            const project: Project = {uri: projectPath, indexType: IndexType.Reindex};
            this.indexNextProject(project);

            return;
        }

        // Reindex the current project

        const resolveCallback =
            (projectPath?: string) : void =>
            {
                if (!projectPath)
                {
                    return;
                }

                // Add the project to the indexing queue
                const project: Project = {uri: Uri.file(projectPath), indexType: IndexType.Reindex};
                this.indexNextProject(project);
            };

        this.getCurrentProjectPath().then(resolveCallback);
    }

    private indexNextProject(enqueuedProject?: Project) : void
    {
        if (enqueuedProject)
        {
            this.projectIndexingQueue.push(enqueuedProject);
        }

        let dequeuedProject: Optional<Project> = undefined;

        // Allow indexing only one project at a time because RTags reports only a global status of whether or not
        // it is currently indexing
        if (!this.currentIndexingProject)
        {
            dequeuedProject = this.projectIndexingQueue.shift();
        }

        if (enqueuedProject && (this.projectIndexingQueue.length !== 0))
        {
            const indexMsg = (enqueuedProject.indexType === IndexType.Load) ? "loading" : "reindexing";
            window.showInformationMessage("[RTags] Project queued for " + indexMsg + ": " +
                                          enqueuedProject.uri.fsPath);
        }

        if (dequeuedProject)
        {
            switch (dequeuedProject.indexType)
            {
                case IndexType.Load:
                    this.loadProject(dequeuedProject);
                    break;

                case IndexType.Reindex:
                    this.reindexProject(dequeuedProject);
                    break;
            }
        }
    }

    private loadProject(project: Project) : void
    {
        const projectPath = project.uri.fsPath;

        if (existsSync(projectPath + "/compile_commands.json"))
        {
            const rc = runRcSync(["--load-compile-commands", projectPath]);
            if (rc.status === 0)
            {
                window.showInformationMessage("[RTags] Loading project: " + projectPath);
                this.finishIndexingProject(project);
            }
        }
    }

    private reindexProject(project: Project) : void
    {
        const projectPath = project.uri.fsPath;

        const rc = runRcSync(["--project", projectPath, "--reindex"], this.getTextDocuments());
        if (rc.status === 0)
        {
            window.showInformationMessage("[RTags] Reindexing project: " + projectPath);
            this.finishIndexingProject(project);
        }
    }

    private finishIndexingProject(project: Project) : void
    {
        this.currentIndexingProject = project;

        const resolveCallback =
            (output: string) : void =>
            {
                const indexing = (output === "1");
                if (!indexing)
                {
                    if (this.indexPollTimer)
                    {
                        clearInterval(this.indexPollTimer);
                        this.indexPollTimer = null;
                    }
                    this.currentIndexingProject = null;
                    let indexMsg = "reindexing";
                    if (project.indexType === IndexType.Load)
                    {
                        this.projectPaths.push(project.uri);
                        indexMsg = "loading";
                    }
                    window.showInformationMessage("[RTags] Finished " + indexMsg + " project: " + project.uri.fsPath);
                    this.indexNextProject();
                }
            };

        // Keep polling RTags until it is finished indexing the project
        this.indexPollTimer =
            setInterval(() : void =>
                        {
                            runRc(["--is-indexing"], (output) => { return output.trim(); }).then(resolveCallback);
                        },
                        5000);
    }

    private startDiagnostics() : void
    {
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
                    setTimeout(() => { this.startDiagnostics(); }, 10000);
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

        let jsonObj;
        try
        {
            jsonObj = JSON.parse(output);
        }
        catch (_err)
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
