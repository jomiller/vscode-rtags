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

import { commands, languages, window, workspace, ConfigurationChangeEvent, Diagnostic, DiagnosticCollection,
         DiagnosticSeverity, Disposable, Memento, Range, TextDocument, TextDocumentChangeEvent,
         TextDocumentWillSaveEvent, Uri, WorkspaceFolder, WorkspaceFoldersChangeEvent } from 'vscode';

import { ChildProcess, ExecFileOptionsWithStringEncoding, SpawnOptions, execFile, spawn } from 'child_process';

import { setTimeout, clearTimeout, setInterval, clearInterval } from 'timers';

import * as fs from 'fs';

import * as os from 'os';

import * as util from 'util';

import { Nullable, Optional, isSourceFile, isUnsavedSourceFile, isOpenSourceFile, fromRtagsPosition, parseJson }
         from './rtagsUtil';

enum TaskType
{
    Load,
    Reload,
    Reindex
}

interface ProjectTask
{
    uri: Uri;
    type: TaskType;
}

interface ResumeTimerInfo
{
    file: TextDocument;
    timer: NodeJS.Timer;
}

function isLoadingTask(task: ProjectTask) : boolean
{
    return ((task.type === TaskType.Load) || (task.type === TaskType.Reload));
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

export function runRc<T = void>(args: string[], process?: (stdout: string) => T, unsavedFiles: TextDocument[] = []) :
    Promise<Optional<T>>
{
    const executorCallback =
        (resolve: (value?: T) => void, _reject: (reason?: any) => void) : void =>
        {
            let localArgs: string[] = [];

            for (const file of unsavedFiles)
            {
                const text = file.uri.fsPath + ':' + file.getText().length.toString();
                localArgs.push("--unsaved-file", text);
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
                            let message = "[RTags] ";
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
                    else if (process)
                    {
                        resolve(process(stdout));
                    }
                    else
                    {
                        resolve();
                    }
                };

            let rc = execFile(getRcExecutable(), args.concat(localArgs), options, exitCallback);

            for (const file of unsavedFiles)
            {
                rc.stdin.write(file.getText());
            }
            if (unsavedFiles.length !== 0)
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
        window.showErrorMessage("[RTags] Server is not running and auto-launch is disabled; " +
                                "launch server manually or enable \"rtags.rdm.autoLaunch\" setting");
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
        const delayMs = 1000;
        const timeoutMs = 30 * delayMs;
        const endTimeMs = Date.now() + timeoutMs;
        while (!(rcStatus = await testRcStatus()))
        {
            if (Date.now() >= endTimeMs)
            {
                break;
            }
            await sleep(delayMs);
        }
    }

    if (rcStatus)
    {
        window.showInformationMessage("[RTags] Started server successfully");
    }
    else
    {
        window.showErrorMessage("[RTags] Could not start server; " +
                                "check \"rtags.rdm.executable\" and \"rtags.rdm.arguments\" settings");
    }

    return rcStatus;
}

function getKnownProjectPaths() : Promise<Optional<Uri[]>>
{
    const processCallback =
        (output: string) : Uri[] =>
        {
            const trimmedOutput = output.trim();
            if (trimmedOutput.length === 0)
            {
                return [];
            }

            const paths = trimmedOutput.split('\n');
            return paths.map((p) => { return Uri.file(p.replace(" <=", "").trim().replace(/\/$/, "")); });
        };

    return runRc(["--project"], processCallback);
}

async function getLoadedProjectPaths(knownProjectPaths?: Uri[]) : Promise<Uri[]>
{
    if (!knownProjectPaths)
    {
        return [];
    }

    let loadedProjectPaths: Uri[] = [];

    for (const path of knownProjectPaths)
    {
        const statusHeaderLineCount = 3;

        const args =
        [
            "--project",
            path.fsPath,
            "--status",
            "sources",
            "--max",
            (statusHeaderLineCount + 1).toString()
        ];

        const processStatusCallback =
            (output: string) : boolean =>
            {
                const trimmedOutput = output.trim();
                if (trimmedOutput.length === 0)
                {
                    return false;
                }

                const lines = trimmedOutput.split('\n');
                return (lines.length > statusHeaderLineCount);
            };

        const sourcesLoaded = await runRc(args, processStatusCallback);
        if (sourcesLoaded)
        {
            loadedProjectPaths.push(path);
        }
    }

    return loadedProjectPaths;
}

function getSuspendedFilePaths(projectPath: Uri, timeout: number = 0) : Promise<Optional<string[]>>
{
    let args =
    [
        "--project",
        projectPath.fsPath,
        "--suspend"
    ];

    if (timeout > 0)
    {
        args.push("--timeout", timeout.toString());
    }

    const processCallback =
        (output: string) : string[] =>
        {
            let paths: string[] = [];

            for (const line of output.split('\n'))
            {
                if (line.trim().length === 0)
                {
                    continue;
                }
                const pathIndex = line.indexOf(" is suspended");
                if (pathIndex !== -1)
                {
                    paths.push(line.slice(0, pathIndex));
                }
            }

            return paths;
        };

    return runRc(args, processCallback);
}

export class RtagsManager implements Disposable
{
    constructor(workspaceState: Memento)
    {
        this.workspaceState = workspaceState;

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
            async (event: ConfigurationChangeEvent) : Promise<void> =>
            {
                if (event.affectsConfiguration("rtags"))
                {
                    let projectPathsToReload =
                        new Set<string>(this.workspaceState.get<string[]>("rtags.projectPathsToReload", []));

                    const origProjectPathCount = projectPathsToReload.size;

                    for (const path of this.projectPaths)
                    {
                        if (event.affectsConfiguration("rtags.misc.compilationDatabaseDirectory", path))
                        {
                            projectPathsToReload.add(path.fsPath);
                        }
                    }

                    if (projectPathsToReload.size !== origProjectPathCount)
                    {
                        await this.workspaceState.update("rtags.projectPathsToReload", [...projectPathsToReload]);
                    }

                    const reloadAction = "Reload Now";
                    const selectedAction =
                        await window.showInformationMessage("Reload to apply the configuration change", reloadAction);

                    if (selectedAction === reloadAction)
                    {
                        commands.executeCommand("workbench.action.reloadWindow");
                    }
                }
            };

        this.disposables.push(
            commands.registerCommand("rtags.reindexActiveFolder", this.reindexActiveProject, this),
            commands.registerCommand("rtags.reindexWorkspace", this.reindexProjects, this),
            workspace.onDidChangeTextDocument(this.reindexChangedFile, this),
            workspace.onDidSaveTextDocument(this.reindexSavedFile, this),
            workspace.onWillSaveTextDocument(this.suspendFileWatch, this),
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
        if (!this.currentProjectTask || !isLoadingTask(this.currentProjectTask))
        {
            return false;
        }

        const loadingProjectPath = this.currentProjectTask.uri;

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

    public getOpenSourceFiles(projectPath?: Uri) : TextDocument[]
    {
        return workspace.textDocuments.filter(
            (file) => { return (isSourceFile(file) && this.isInProject(file.uri, projectPath)); });
    }

    public getUnsavedSourceFiles(projectPath?: Uri) : TextDocument[]
    {
        return workspace.textDocuments.filter(
            (file) => { return (isUnsavedSourceFile(file) && this.isInProject(file.uri, projectPath)); });
    }

    private async addProjects(folders?: WorkspaceFolder[]) : Promise<void>
    {
        if (!folders || (folders.length === 0))
        {
            return;
        }

        // Delete projects that need to be reloaded

        const projectPathsToReload =
            new Set<string>(this.workspaceState.get<string[]>("rtags.projectPathsToReload", []));

        const origProjectPathCount = projectPathsToReload.size;

        let args: string[] = [];
        for (const path of projectPathsToReload)
        {
            const folderAdded = folders.some((f) => { return (f.uri.fsPath === path); });
            if (folderAdded)
            {
                args.push("--delete-project", path + '/');
                projectPathsToReload.delete(path);
            }
        }
        if (args.length !== 0)
        {
            await runRc(args);
        }

        if (projectPathsToReload.size !== origProjectPathCount)
        {
            const paths = (projectPathsToReload.size !== 0) ? [...projectPathsToReload] : undefined;
            await this.workspaceState.update("rtags.projectPathsToReload", paths);
        }

        const knownProjectPaths = await getKnownProjectPaths();
        const loadedProjectPaths = await getLoadedProjectPaths(knownProjectPaths);

        // Consider only VS Code workspace folders, and ignore RTags projects that are not known to VS Code
        for (const f of folders)
        {
            const projectLoaded = loadedProjectPaths.some((p) => { return (p.fsPath === f.uri.fsPath); });
            if (projectLoaded)
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
                            runRc(args);
                        }
                    }
                    else
                    {
                        // Resend diagnostics for all files in the project
                        runRc(["--project", f.uri.fsPath, "--diagnose-all"]);
                    }
                }
            }
            else
            {
                // Add the project to the task queue
                let taskType = TaskType.Load;
                if (knownProjectPaths)
                {
                    const projectExists = knownProjectPaths.some((p) => { return (p.fsPath === f.uri.fsPath); });
                    if (projectExists)
                    {
                        taskType = TaskType.Reload;
                    }
                }

                const task: ProjectTask = {uri: f.uri, type: taskType};
                this.processNextProjectTask(task);
            }
        }
    }

    private removeProjects(folders?: WorkspaceFolder[]) : void
    {
        if (folders)
        {
            folders.forEach((f) => { this.removeProject(f.uri); });
        }
    }

    private removeProject(uri: Uri) : void
    {
        const projectPath = uri.fsPath;

        if (this.currentProjectTask && (projectPath === this.currentProjectTask.uri.fsPath))
        {
            this.currentProjectTask = null;
        }

        this.projectTaskQueue = this.projectTaskQueue.filter((p) => { return (p.uri.fsPath !== projectPath); });

        const index = this.projectPaths.findIndex((p) => { return (p.fsPath === projectPath); });
        if (index !== -1)
        {
            this.projectPaths.splice(index, 1);
        }
    }

    private updateProjects(event: WorkspaceFoldersChangeEvent) : void
    {
        this.removeProjects(event.removed);
        this.addProjects(event.added);
    }

    private reindexFile(file: TextDocument, force?: boolean) : void
    {
        const projectPath = this.getProjectPath(file.uri);
        if (!projectPath)
        {
            return;
        }

        const unsavedFiles = this.getUnsavedSourceFiles(projectPath);
        let reindexArg = "--check-reindex";
        let delayReindex = false;

        if (force || (force === undefined))
        {
            reindexArg = "--reindex";
        }
        else if (unsavedFiles.length !== 0)
        {
            // Force reindexing if there are any unsaved files
            reindexArg = "--reindex";
            delayReindex = true;
        }

        const reindex = () => { runRc([reindexArg, file.uri.fsPath], undefined, unsavedFiles); };

        if (delayReindex)
        {
            // Add a delay in order to override the automatic reindexing on save
            setTimeout(reindex, 1000);
        }
        else
        {
            reindex();
        }
    }

    private reindexChangedFile(event: TextDocumentChangeEvent) : void
    {
        if (event.contentChanges.length === 0)
        {
            return;
        }

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
        }

        const timeoutCallback =
            async () : Promise<void> =>
            {
                this.reindexDelayTimers.delete(path);

                await Promise.all(this.resumeDelayedFileWatches(projectPath));

                this.reindexFile(event.document, true);
            };

        this.reindexDelayTimers.set(path, setTimeout(timeoutCallback, 500));
    }

    private async reindexSavedFile(file: TextDocument) : Promise<void>
    {
        const projectPath = this.getProjectPath(file.uri);

        if (!isSourceFile(file) || !projectPath)
        {
            return;
        }

        await Promise.all(this.resumeDelayedFileWatches(projectPath));

        // Force reindexing if the file was suspended
        // Checking whether reindexing is needed does not work for files that were suspended
        const suspended = await this.resumeFileWatch(file);

        this.reindexFile(file, suspended);
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

        // Rely on the file watch to reindex on save if there are no other unsaved files
        const unsavedFiles = this.getUnsavedSourceFiles(projectPath);
        if ((unsavedFiles.length === 0) || ((unsavedFiles.length === 1) && (unsavedFiles[0].uri.fsPath === path)))
        {
            return;
        }

        if (this.suspendedFilePaths.has(path))
        {
            return;
        }

        const timeoutMs = 100;

        const resolveCallback =
            (paths?: string[]) : Promise<Optional<void>> =>
            {
                if (!paths)
                {
                    return Promise.resolve();
                }

                if (paths.includes(path))
                {
                    // The file is already suspended
                    this.suspendedFilePaths.add(path);
                    return Promise.resolve();
                }

                const args =
                [
                    "--suspend",
                    path,
                    "--timeout",
                    timeoutMs.toString()
                ];

                const processCallback =
                    (output: string) : void =>
                    {
                        const message = path + " is now suspended";
                        if (output.trim() === message)
                        {
                            // The file was suspended successfully
                            this.suspendedFilePaths.add(path);
                        }
                    };

                return runRc(args, processCallback);
            };

        // Block the event loop to ensure that the file is suspended before it is saved
        // Use a timeout because VS Code imposes a time budget on subscribers to the onWillSaveTextDocument event
        event.waitUntil(getSuspendedFilePaths(projectPath, timeoutMs).then(resolveCallback));

        if (!event.document.isDirty)
        {
            // The onDidSaveTextDocument event will not fire for clean files
            // Delay until the file has been saved, and then manually resume the file watch
            const timeoutCallback =
                () : void =>
                {
                    this.resumeDelayTimers.delete(path);
                    this.resumeFileWatch(event.document);
                };

            const timerInfo: ResumeTimerInfo =
            {
                file: event.document,
                timer: setTimeout(timeoutCallback, 2000)
            };
            this.resumeDelayTimers.set(path, timerInfo);
        }
    }

    private resumeFileWatch(file: TextDocument) : Promise<Optional<boolean>>
    {
        const projectPath = this.getProjectPath(file.uri);

        if (!isSourceFile(file) || !projectPath)
        {
            return Promise.resolve(undefined);
        }

        const path = file.uri.fsPath;

        const resolveCallback =
            (paths?: string[]) : Promise<Optional<boolean>> =>
            {
                if (!paths)
                {
                    return Promise.resolve(undefined);
                }

                if (!paths.includes(path))
                {
                    // The file is not suspended, so it does not need to be resumed
                    this.suspendedFilePaths.delete(path);
                    return Promise.resolve(false);
                }

                const processCallback =
                    (output: string) : boolean =>
                    {
                        const message = path + " is no longer suspended";
                        if (output.trim() === message)
                        {
                            // The file was resumed successfully
                            this.suspendedFilePaths.delete(path);
                        }
                        return true;
                    };

                return runRc(["--suspend", path], processCallback);
            };

        return getSuspendedFilePaths(projectPath).then(resolveCallback);
    }

    private resumeDelayedFileWatches(projectPath: Uri) : Promise<Optional<boolean>>[]
    {
        // Resume files early so that they may be reindexed if necessary
        let promises: Promise<Optional<boolean>>[] = [];
        for (const info of this.resumeDelayTimers.values())
        {
            if (this.isInProject(info.file.uri, projectPath))
            {
                clearTimeout(info.timer);
                this.resumeDelayTimers.delete(info.file.uri.fsPath);
                promises.push(this.resumeFileWatch(info.file));
            }
        }
        return promises;
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
        const task: ProjectTask = {uri: projectPath, type: TaskType.Reindex};
        this.processNextProjectTask(task);
    }

    private reindexProjects() : void
    {
        for (const path of this.projectPaths)
        {
            const task: ProjectTask = {uri: path, type: TaskType.Reindex};
            this.processNextProjectTask(task);
        }
    }

    private async processNextProjectTask(enqueuedTask?: ProjectTask) : Promise<void>
    {
        if (enqueuedTask)
        {
            this.projectTaskQueue.push(enqueuedTask);
        }

        // Allow indexing only one project at a time because RTags reports only a global status of whether or not
        // it is currently indexing
        while (!this.currentProjectTask && (this.projectTaskQueue.length !== 0))
        {
            const dequeuedTask = this.projectTaskQueue.shift();
            this.currentProjectTask = dequeuedTask ? dequeuedTask : null;

            if (this.currentProjectTask)
            {
                const projectPath = this.currentProjectTask.uri;
                let indexMsg = "";

                switch (this.currentProjectTask.type)
                {
                    case TaskType.Load:
                    case TaskType.Reload:
                    {
                        const config = workspace.getConfiguration("rtags", this.currentProjectTask.uri);
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
                        else if ((this.currentProjectTask.type === TaskType.Reload) || compilationDatabaseDir)
                        {
                            window.showErrorMessage("[RTags] Could not load project: " + projectPath.fsPath +
                                                    "; compilation database not found: " + compileCommands);
                        }
                        if (!status)
                        {
                            this.currentProjectTask = null;
                        }
                        indexMsg = "Loading";
                        break;
                    }

                    case TaskType.Reindex:
                    {
                        const status = await runRc(["--project", projectPath.fsPath, "--reindex"],
                                                   (_unused) => { return true; },
                                                   this.getUnsavedSourceFiles(projectPath));
                        if (!status)
                        {
                            this.currentProjectTask = null;
                        }
                        indexMsg = "Reindexing";
                        break;
                    }
                }

                if (this.currentProjectTask)
                {
                    window.showInformationMessage("[RTags] " + indexMsg + " project: " + projectPath.fsPath);
                    this.finishProjectTask();
                }
            }
        }
    }

    private finishProjectTask() : void
    {
        // Keep polling RTags until it is finished indexing the project
        const intervalCallback =
            () : void =>
            {
                const timeoutMs = 1000;

                const args =
                [
                    "--is-indexing",
                    "--timeout",
                    timeoutMs.toString()
                ];

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
                            if (this.currentProjectTask)
                            {
                                let indexMsg = "reindexing";
                                if (isLoadingTask(this.currentProjectTask))
                                {
                                    this.projectPaths.push(this.currentProjectTask.uri);
                                    indexMsg = "loading";
                                }

                                window.showInformationMessage("[RTags] Finished " + indexMsg + " project: " +
                                                              this.currentProjectTask.uri.fsPath);

                                this.currentProjectTask = null;
                            }
                            this.processNextProjectTask();
                        }
                    };

                runRc(args, processCallback);
            };

        this.indexPollTimer = setInterval(intervalCallback, 5000);
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

            if (this.diagnosticsOpenFilesOnly && !isOpenSourceFile(uri))
            {
                continue;
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

        runRc(["--diagnose", file.uri.fsPath]);
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

    private workspaceState: Memento;
    private projectTaskQueue: ProjectTask[] = [];
    private currentProjectTask: Nullable<ProjectTask> = null;
    private projectPaths: Uri[] = [];
    private diagnosticsEnabled: boolean = true;
    private diagnosticsOpenFilesOnly: boolean = true;
    private diagnosticCollection: Nullable<DiagnosticCollection> = null;
    private diagnosticProcess: Nullable<ChildProcess> = null;
    private unprocessedDiagnostics: string = "";
    private reindexDelayTimers = new Map<string, NodeJS.Timer>();
    private suspendedFilePaths = new Set<string>();
    private resumeDelayTimers = new Map<string, ResumeTimerInfo>();
    private indexPollTimer: Nullable<NodeJS.Timer> = null;
    private disposables: Disposable[] = [];
}
