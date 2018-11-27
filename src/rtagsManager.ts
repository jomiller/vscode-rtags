/*
 * This file is part of RTags Client for Visual Studio Code.
 *
 * Copyright (c) yorver
 * Copyright (c) 2018 Jonathan Miller
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

'use strict';

import { commands, languages, window, workspace, ConfigurationChangeEvent, Diagnostic, DiagnosticCollection,
         DiagnosticSeverity, Disposable, Range, TextDocument, TextDocumentChangeEvent, TextDocumentWillSaveEvent, Uri,
         WorkspaceFolder, WorkspaceFoldersChangeEvent } from 'vscode';

import { ChildProcess, ExecFileOptionsWithStringEncoding, SpawnOptions, execFile, spawn } from 'child_process';

import { setTimeout, clearTimeout, setInterval, clearInterval } from 'timers';

import * as fs from 'fs';

import * as os from 'os';

import * as util from 'util';

import { Nullable, Optional, isSourceFile, isUnsavedSourceFile, fromRtagsPosition, parseJson } from './rtagsUtil';

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

function toDiagnosticSeverity(severity: string) : DiagnosticSeverity
{
    switch (severity)
    {
        case "error":
        case "fixit":
            return DiagnosticSeverity.Error;

        case "warning":
            return DiagnosticSeverity.Warning;

        default:
            return DiagnosticSeverity.Information;
    }
}

function fileExists(file: string) : Promise<boolean>
{
    return new Promise<boolean>(
        (resolve, _reject) =>
        {
            fs.access(file, fs.constants.F_OK, (err) => { resolve(!err); });
        });
}

function getRcExecutable() : string
{
    const config = workspace.getConfiguration("rtags");
    return config.get<string>("rc.executable", "rc");
}

export function runRc<T>(args: string[], process: (stdout: string) => T, files: TextDocument[] = []) :
    Promise<Optional<T>>
{
    const executorCallback =
        (resolve: (value?: T) => void, _reject: (reason?: any) => void) : void =>
        {
            const unsavedSourceFiles = files.filter((file) => { return isUnsavedSourceFile(file); });
            for (const file of unsavedSourceFiles)
            {
                const text = file.uri.fsPath + ':' + file.getText().length.toString();
                args.push("--unsaved-file", text);
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

            for (const file of unsavedSourceFiles)
            {
                rc.stdin.write(file.getText());
            }
            if (unsavedSourceFiles.length !== 0)
            {
                rc.stdin.end();
            }
        };

    return new Promise<T>(executorCallback);
}

function spawnRc(args: string[], ignoreStdio: boolean = false) : ChildProcess
{
    const options: SpawnOptions =
    {
        stdio: (ignoreStdio ? "ignore" : "pipe")
    };

    return spawn(getRcExecutable(), args, options);
}

function testRcProcess() : boolean
{
    const rc = spawnRc(["--current-project"], true);
    return (rc.pid !== undefined);
}

async function testRcStatus() : Promise<boolean>
{
    let status = false;
    const run = util.promisify(execFile);

    try
    {
        await run(getRcExecutable(), ["--current-project"]);
        status = true;
    }
    catch (_err)
    {
    }

    return status;
}

async function startRdm() : Promise<boolean>
{
    if (!testRcProcess())
    {
        window.showErrorMessage("[RTags] Could not run client; check \"rtags.rc.executable\" setting");
        return false;
    }

    let rcStatus = await testRcStatus();
    if (rcStatus)
    {
        // rc connected to rdm successfully
        return true;
    }

    const config = workspace.getConfiguration("rtags");
    const rdmAutoLaunch = config.get<boolean>("rdm.autoLaunch", true);
    if (!rdmAutoLaunch)
    {
        window.showErrorMessage("[RTags] Server is not running and auto-launch is disabled; launch server manually or enable \"rtags.rdm.autoLaunch\" setting");
        return false;
    }

    const rdmExecutable = config.get<string>("rdm.executable", "rdm");
    let rdmArguments = config.get<string[]>("rdm.arguments", []);

    const jobCountArg = rdmArguments.find((arg) => { return (/^(-j=?(\d+)?|--job-count(=(\d+)?)?)$/).test(arg); });
    if (!jobCountArg)
    {
        const logicalCpuCount = os.cpus().length;
        const jobCount = Math.max(1, logicalCpuCount / 2);
        rdmArguments.push("--job-count", jobCount.toString());
    }

    const options: SpawnOptions =
    {
        detached: true,
        stdio: "ignore"
    };

    let rdm = spawn(rdmExecutable, rdmArguments, options);

    if (rdm.pid)
    {
        rdm.unref();

        // Wait for rc to connect to rdm
        const sleep = util.promisify(setTimeout);
        const delayMsec = 1000;
        const timeoutMsec = 30 * delayMsec;
        for (let ms = 0; ms < timeoutMsec; ms += delayMsec)
        {
            rcStatus = await testRcStatus();
            if (rcStatus)
            {
                window.showInformationMessage("[RTags] Started server successfully");
                return true;
            }
            await sleep(delayMsec);
        }
    }

    window.showErrorMessage("[RTags] Could not start server; check \"rtags.rdm.executable\" and \"rtags.rdm.arguments\" settings");
    return false;
}

function getSuspendedFilePaths(projectPath: Uri) : Promise<Optional<string[]>>
{
    const args =
    [
        "--project",
        projectPath.fsPath,
        "--suspend"
    ];

    const processCallback =
        (output: string) : string[] =>
        {
            let suspendedPaths: string[] = [];

            for (const line of output.split('\n'))
            {
                if (line.trim().length === 0)
                {
                    continue;
                }
                const pathIndex = line.indexOf(" is suspended");
                if (pathIndex !== -1)
                {
                    suspendedPaths.push(line.slice(0, pathIndex));
                }
            }

            return suspendedPaths;
        };

    return runRc(args, processCallback);
}

export class RtagsManager implements Disposable
{
    constructor()
    {
        const config = workspace.getConfiguration("rtags");
        this.diagnosticsEnabled = config.get<boolean>("diagnostics.enabled", true);
        if (this.diagnosticsEnabled)
        {
            this.diagnosticCollection = languages.createDiagnosticCollection("rtags");
            this.disposables.push(this.diagnosticCollection);

            this.diagnosticsOpenFilesOnly = config.get<boolean>("diagnostics.openFilesOnly", true);
            if (this.diagnosticsOpenFilesOnly)
            {
                this.disposables.push(
                    workspace.onDidOpenTextDocument(this.diagnoseFile, this),
                    workspace.onDidCloseTextDocument(this.undiagnoseFile, this));
            }
        }

        (async () =>
        {
            const rdmRunning = await startRdm();
            if (rdmRunning)
            {
                this.startDiagnostics();
                this.addProjects(workspace.workspaceFolders);
            }
        })();

        const changeConfigCallback =
            (event: ConfigurationChangeEvent) : void =>
            {
                if (event.affectsConfiguration("rtags"))
                {
                    const reloadAction = "Reload Now";
                    let message = "Reload to apply the configuration change";

                    for (const path of this.projectPaths)
                    {
                        if (event.affectsConfiguration("rtags.misc.compilationDatabaseDirectory", path))
                        {
                            this.projectPathsToPurge.add(path);
                        }
                    }

                    const resolveCallback =
                        (selectedAction?: string) : void =>
                        {
                            if (selectedAction === reloadAction)
                            {
                                this.projectPathsToPurge.forEach((p) => { this.removeProject(p, true); });
                                this.projectPathsToPurge.clear();

                                commands.executeCommand("workbench.action.reloadWindow");
                            }
                        };

                    if (event.affectsConfiguration("rtags.misc.compilationDatabaseDirectory"))
                    {
                        message += ", otherwise new compilation databases will not be loaded";
                        window.showWarningMessage(message, reloadAction).then(resolveCallback);
                    }
                    else
                    {
                        window.showInformationMessage(message, reloadAction).then(resolveCallback);
                    }
                }
            };

        this.disposables.push(
            commands.registerCommand("rtags.reindexActiveFolder", this.reindexActiveProject, this),
            commands.registerCommand("rtags.reindexWorkspace", this.reindexProjects, this),
            workspace.onDidChangeTextDocument(this.reindexChangedFile, this),
            workspace.onDidSaveTextDocument(this.reindexSavedFile, this),
            workspace.onWillSaveTextDocument(this.suspendFileWatch, this),
            workspace.onDidCloseTextDocument(this.resumeFileWatch, this),
            workspace.onDidChangeWorkspaceFolders(this.updateProjects, this),
            workspace.onDidChangeConfiguration(changeConfigCallback));
    }

    public dispose() : void
    {
        this.stopDiagnostics();

        this.disposables.forEach((d) => { d.dispose(); });
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

    public isInProject(uri: Uri, projectPath?: Uri) : boolean
    {
        const path = this.getProjectPath(uri);
        return (projectPath ? (path === projectPath) : (path !== undefined));
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

    public getOpenTextFiles(projectPath?: Uri) : TextDocument[]
    {
        return workspace.textDocuments.filter((file) => { return this.isInProject(file.uri, projectPath); });
    }

    public getOpenSourceFiles(projectPath?: Uri) : TextDocument[]
    {
        return this.getOpenTextFiles(projectPath).filter((file) => { return isSourceFile(file); });
    }

    public getUnsavedSourceFiles(projectPath?: Uri) : TextDocument[]
    {
        return this.getOpenTextFiles(projectPath).filter((file) => { return isUnsavedSourceFile(file); });
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
                    if (this.diagnosticsOpenFilesOnly)
                    {
                        // Resend diagnostics for open files in the project
                        const openSourceFiles = this.getOpenSourceFiles(f.uri);
                        if (openSourceFiles.length !== 0)
                        {
                            let args: string[] = [];
                            openSourceFiles.forEach((file) => { args.push("--diagnose", file.uri.fsPath); });
                            runRc(args, (_unused) => {});
                        }
                    }
                    else
                    {
                        // Resend diagnostics for all files in the project
                        runRc(["--project", f.uri.fsPath, "--diagnose-all"], (_unused) => {});
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
        if (folders)
        {
            folders.forEach((f) => { this.removeProject(f.uri, false); });
        }
    }

    private removeProject(uri: Uri, purge: boolean) : void
    {
        const projectPath = uri.fsPath;

        if (this.currentIndexingProject && (projectPath === this.currentIndexingProject.uri.fsPath))
        {
            this.currentIndexingProject = null;
        }

        this.projectIndexingQueue = this.projectIndexingQueue.filter((p) => { return (p.uri.fsPath !== projectPath); });

        const index = this.projectPaths.findIndex((p) => { return (p.fsPath === projectPath); });
        if (index !== -1)
        {
            this.projectPaths.splice(index, 1);
        }

        if (purge)
        {
            runRc(["--delete-project", projectPath + '/'], (_unused) => {});
        }
    }

    private updateProjects(event: WorkspaceFoldersChangeEvent) : void
    {
        this.removeProjects(event.removed);
        this.addProjects(event.added);
    }

    private reindexFile(file: TextDocument) : void
    {
        const projectPath = this.getProjectPath(file.uri);
        if (!projectPath)
        {
            return;
        }

        runRc(["--reindex", file.uri.fsPath], (_unused) => {}, this.getOpenTextFiles(projectPath));
    }

    private reindexChangedFile(event: TextDocumentChangeEvent) : void
    {
        if (event.contentChanges.length === 0)
        {
            return;
        }

        if (!isSourceFile(event.document) || !this.isInProject(event.document.uri))
        {
            return;
        }

        const path = event.document.uri.fsPath;
        const timer = this.reindexDelayTimers.get(path);

        if (timer)
        {
            clearTimeout(timer);
        }

        this.reindexDelayTimers.set(path,
                                    setTimeout(() : void =>
                                               {
                                                   this.reindexFile(event.document);
                                                   this.reindexDelayTimers.delete(path);
                                               },
                                               500));
    }

    private async reindexSavedFile(document: TextDocument) : Promise<void>
    {
        if (!isSourceFile(document) || !this.isInProject(document.uri))
        {
            return;
        }

        const path = document.uri.fsPath;

        const promise = this.fileWatchSuspendPromises.get(path);
        if (promise)
        {
            await promise;
            this.fileWatchSuspendPromises.delete(path);
        }

        this.reindexFile(document);
    }

    private suspendFileWatch(event: TextDocumentWillSaveEvent) : void
    {
        const projectPath = this.getProjectPath(event.document.uri);

        if (!isSourceFile(event.document) || !projectPath)
        {
            return;
        }

        const path = event.document.uri.fsPath;
        const timer = this.reindexDelayTimers.get(path);

        if (timer)
        {
            clearTimeout(timer);
            this.reindexDelayTimers.delete(path);
        }

        const resolveCallback =
            (suspendedPaths?: string[]) : void =>
            {
                if (!suspendedPaths || !suspendedPaths.includes(path))
                {
                    const promise = runRc(["--suspend", path], (_unused) => {});
                    this.fileWatchSuspendPromises.set(path, promise);
                }
            };

        getSuspendedFilePaths(projectPath).then(resolveCallback);
    }

    private resumeFileWatch(file: TextDocument) : void
    {
        const projectPath = this.getProjectPath(file.uri);

        if (!isSourceFile(file) || !projectPath)
        {
            return;
        }

        const path = file.uri.fsPath;

        const resolveCallback =
            (suspendedPaths?: string[]) : void =>
            {
                if (suspendedPaths && suspendedPaths.includes(path))
                {
                    runRc(["--suspend", path], (_unused) => {});
                }
            };

        getSuspendedFilePaths(projectPath).then(resolveCallback);
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
        }

        // Allow indexing only one project at a time because RTags reports only a global status of whether or not
        // it is currently indexing
        while (!this.currentIndexingProject && (this.projectIndexingQueue.length !== 0))
        {
            const dequeuedProject = this.projectIndexingQueue.shift();
            this.currentIndexingProject = dequeuedProject ? dequeuedProject : null;

            if (this.currentIndexingProject)
            {
                const projectPath = this.currentIndexingProject.uri;
                let indexMsg = "";

                switch (this.currentIndexingProject.indexType)
                {
                    case IndexType.Load:
                    {
                        const config = workspace.getConfiguration("rtags", this.currentIndexingProject.uri);
                        const compilationDatabaseDir = config.get<string>("misc.compilationDatabaseDirectory");
                        const compileCommandsDir =
                            compilationDatabaseDir ? compilationDatabaseDir.replace(/\/*$/, "") : projectPath.fsPath;
                        const compileCommands = compileCommandsDir + "/compile_commands.json";
                        let status: Optional<boolean> = await fileExists(compileCommands);
                        if (status)
                        {
                            status = await runRc(["--load-compile-commands", compileCommandsDir],
                                                 (_unused) => { return true; });
                        }
                        else if (compilationDatabaseDir)
                        {
                            window.showErrorMessage("[RTags] Could not load project: " + projectPath.fsPath +
                                                    "; compilation database not found: " + compileCommands);
                        }
                        if (!status)
                        {
                            this.currentIndexingProject = null;
                        }
                        indexMsg = "Loading";
                        break;
                    }

                    case IndexType.Reindex:
                    {
                        const status = await runRc(["--project", projectPath.fsPath, "--reindex"],
                                                   (_unused) => { return true; },
                                                   this.getOpenTextFiles(projectPath));
                        if (!status)
                        {
                            this.currentIndexingProject = null;
                        }
                        indexMsg = "Reindexing";
                        break;
                    }
                }

                if (this.currentIndexingProject)
                {
                    window.showInformationMessage("[RTags] " + indexMsg + " project: " + projectPath.fsPath);
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
                        let indexMsg = "reindexing";
                        if (this.currentIndexingProject.indexType === IndexType.Load)
                        {
                            this.projectPaths.push(this.currentIndexingProject.uri);
                            indexMsg = "loading";
                        }

                        window.showInformationMessage("[RTags] Finished " + indexMsg + " project: " +
                                                      this.currentIndexingProject.uri.fsPath);

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
        this.diagnosticProcess = spawnRc(["--diagnostics", "--json"]);
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
                this.unprocessedDiagnostics = "";
                if (signal === "SIGTERM")
                {
                    if (this.diagnosticCollection)
                    {
                        this.diagnosticCollection.clear();
                    }
                }
                else
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
            data = data.slice(end + 1);
        }

        return data.trim();
    }

    private processDiagnosticsLine(line: string) : void
    {
        if (line.trim().length === 0)
        {
            return;
        }

        const jsonObj = parseJson(line);
        if (!jsonObj)
        {
            window.showErrorMessage("[RTags] Diagnostics parse error: " + line);
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

            if (this.diagnosticsOpenFilesOnly)
            {
                const fileOpen = workspace.textDocuments.some((file) => { return (file.uri.fsPath === uri.fsPath); });
                if (!fileOpen)
                {
                    continue;
                }
            }

            let diagnostics: Diagnostic[] = [];

            for (const d of jsonObj.checkStyle[file])
            {
                try
                {
                    const start = fromRtagsPosition(d.line, d.column);
                    const end = d.length ? start.translate(0, parseInt(d.length)) : start;

                    const diag: Diagnostic =
                    {
                        message: d.message,
                        range: new Range(start, end),
                        severity: toDiagnosticSeverity(d.type),
                        source: "RTags"
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

    private diagnoseFile(file: TextDocument) : void
    {
        if (!isSourceFile(file) || (!this.isInProject(file.uri) && !this.isInLoadingProject(file.uri)))
        {
            return;
        }

        runRc(["--diagnose", file.uri.fsPath], (_unused) => {});
    }

    private undiagnoseFile(file: TextDocument) : void
    {
        if (!isSourceFile(file) || (!this.isInProject(file.uri) && !this.isInLoadingProject(file.uri)))
        {
            return;
        }

        if (this.diagnosticCollection)
        {
            this.diagnosticCollection.delete(file.uri);
        }
    }

    private projectIndexingQueue: Project[] = [];
    private currentIndexingProject: Nullable<Project> = null;
    private projectPaths: Uri[] = [];
    private projectPathsToPurge = new Set<Uri>();
    private diagnosticsEnabled: boolean = true;
    private diagnosticsOpenFilesOnly: boolean = true;
    private diagnosticCollection: Nullable<DiagnosticCollection> = null;
    private diagnosticProcess: Nullable<ChildProcess> = null;
    private unprocessedDiagnostics: string = "";
    private reindexDelayTimers = new Map<string, NodeJS.Timer>();
    private fileWatchSuspendPromises = new Map<string, Promise<void>>();
    private indexPollTimer: Nullable<NodeJS.Timer> = null;
    private disposables: Disposable[] = [];
}
