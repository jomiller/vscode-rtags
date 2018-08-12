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
         DiagnosticSeverity, Disposable, Position, Range, TextDocument, TextDocumentChangeEvent, Uri, WorkspaceFolder,
         WorkspaceFoldersChangeEvent } from 'vscode';

import { ChildProcess, ExecFileOptionsWithStringEncoding, SpawnOptions, SpawnSyncOptionsWithStringEncoding,
         SpawnSyncReturns, execFile, spawn, spawnSync } from 'child_process';

import { setTimeout, clearTimeout, setInterval, clearInterval } from 'timers';

import * as fs from 'fs';

import * as util from 'util';

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
    const rdmAutoLaunch = config.get<boolean>("rdm.autoLaunch", true);
    if (!rdmAutoLaunch)
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

        const rdmExecutable = config.get<string>("rdm.executable", "rdm");
        const rdmArguments = config.get<string[]>("rdm.arguments", []);

        let rdm = spawn(rdmExecutable, rdmArguments, options);

        if (rdm.pid)
        {
            rdm.unref();
            window.showInformationMessage("[RTags] Started server successfully");

            // Wait for rc to connect to rdm
            const sleep = util.promisify(setTimeout);
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
        this.diagnosticsEnabled = config.get<boolean>("diagnostics.enabled", true);
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

        const changeConfigCallback =
            (event: ConfigurationChangeEvent) : void =>
            {
                if (event.affectsConfiguration("rtags"))
                {
                    const reload = "Reload";
                    let message = "Please reload to apply the configuration change";

                    for (const path of this.projectPaths)
                    {
                        if (event.affectsConfiguration("rtags.misc.compilationDatabaseDirectory", path))
                        {
                            this.projectPathsToPurge.add(path);
                        }
                    }

                    const resolveCallback =
                        (selected?: string) : void =>
                        {
                            if (selected === reload)
                            {
                                this.projectPathsToPurge.forEach((p) => { this.removeProject(p, true); });
                                this.projectPathsToPurge.clear();

                                commands.executeCommand("workbench.action.reloadWindow");
                            }
                        };

                    if (event.affectsConfiguration("rtags.misc.compilationDatabaseDirectory"))
                    {
                        message += ", otherwise new compilation databases will not be loaded";
                        window.showWarningMessage(message, reload).then(resolveCallback);
                    }
                    else
                    {
                        window.showInformationMessage(message, reload).then(resolveCallback);
                    }
                }
            };

        this.disposables.push(
            commands.registerCommand("rtags.reindexActiveFolder", this.reindexActiveProject, this),
            commands.registerCommand("rtags.reindexWorkspace", this.reindexProjects, this),
            workspace.onDidChangeTextDocument(this.reindexChangedDocument, this),
            workspace.onDidSaveTextDocument(this.reindexSavedDocument, this),
            workspace.onDidChangeWorkspaceFolders(this.updateProjects, this),
            workspace.onDidChangeConfiguration(changeConfigCallback));
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

        folders.forEach((f) => { this.removeProject(f.uri, false); });
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
                let indexMsg = "";

                switch (this.currentIndexingProject.indexType)
                {
                    case IndexType.Load:
                    {
                        const config = workspace.getConfiguration("rtags", this.currentIndexingProject.uri);
                        const compilationDatabaseDir = config.get<string>("misc.compilationDatabaseDirectory");
                        const compileCommandsDir =
                            compilationDatabaseDir ? compilationDatabaseDir.replace(/\/*$/, "") : projectPath;
                        const compileCommands = compileCommandsDir + "/compile_commands.json";
                        let status: Optional<boolean> = await fileExists(compileCommands);
                        if (status)
                        {
                            status = await runRc(["--load-compile-commands", compileCommandsDir],
                                                 (_unused) => { return true; });
                        }
                        else if (compilationDatabaseDir)
                        {
                            window.showErrorMessage("[RTags] Could not load project: " + projectPath +
                                                    "; Compilation database not found: " + compileCommands);
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
                        const status = await runRc(["--project", projectPath, "--reindex"],
                                                   (_unused) => { return true; },
                                                   this.getTextDocuments());
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
                    window.showInformationMessage("[RTags] " + indexMsg + " project: " + projectPath);
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
    private projectPathsToPurge: Set<Uri> = new Set<Uri>();
    private diagnosticsEnabled: boolean = true;
    private diagnosticCollection: Nullable<DiagnosticCollection> = null;
    private diagnosticProcess: Nullable<ChildProcess> = null;
    private unprocessedDiagnostics: string = "";
    private reindexDelayTimer: Nullable<NodeJS.Timer> = null;
    private indexPollTimer: Nullable<NodeJS.Timer> = null;
    private disposables: Disposable[] = [];
}
