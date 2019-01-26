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

import { commands, extensions, languages, window, workspace, ConfigurationChangeEvent, Diagnostic,
         DiagnosticCollection, DiagnosticSeverity, Disposable, Memento, Range, TextDocument, TextDocumentChangeEvent,
         TextDocumentWillSaveEvent, Uri, WorkspaceFolder, WorkspaceFoldersChangeEvent } from 'vscode';

import { ChildProcess, SpawnOptions, execFile } from 'child_process';

import { setTimeout, clearTimeout, setInterval, clearInterval } from 'timers';

import * as fs from 'fs';

import * as os from 'os';

import * as path from 'path';

import * as util from 'util';

import { ExtensionId, VsCodeCommand, RtagsCommand, ConfigurationId, WindowConfiguration, ResourceConfiguration,
         makeConfigurationId } from './constants';

import { Nullable, Optional, addTrailingSlash, removeTrailingSlash, isAbsolutePathOrFilename, fileExists, getRealPath,
         parseJson, safeSpawn } from './nodeUtil';

import { ConfigurationMap, getWorkspaceConfiguration, fromConfigurationPath, isSourceFile, isUnsavedSourceFile,
         isOpenSourceFile, showContribution, hideContribution } from './vscodeUtil';

import { toRtagsProjectPath, fromRtagsPosition, getRcExecutable, runRc } from './rtagsUtil';

const CompileCommandsFilename = "compile_commands.json";
const RtagsRepository         = "Andersbakken/rtags";
const RtagsMinimumVersion     = "2.18";
const RtagsRecommendedVersion = "2.21";
const RtagsRecommendedCommit  = "5f887b6f58be6150bd51f240ad4a7433fa552676";
const RtagsCommitAbbrevLength = 7;

interface RtagsVersionInfo
{
    version: string;
    linkUrl: Uri;
    linkText: string;
}

interface CompileCommandsInfo
{
    directory: Uri;
    isConfig?: boolean;
}

enum TaskType
{
    Load,
    Reindex
}

abstract class ProjectTask implements Disposable
{
    constructor(uri: Uri)
    {
        this.id = ProjectTask.getNextId();
        this.uri = uri;
    }

    public dispose() : void
    {
        if (this.timer)
        {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    public abstract getType() : TaskType;

    public async start(onStart: (task: ProjectTask) => void, onStop: (task: ProjectTask) => void) : Promise<void>
    {
        const status = await this.execute();
        if (!status)
        {
            return;
        }

        const action = this.getAction();
        const actionCapital = action.charAt(0).toUpperCase() + action.slice(1);

        window.showInformationMessage("[RTags] " + actionCapital + " project: " + this.uri.fsPath);

        onStart(this);

        // Keep polling RTags until it is finished indexing the project
        const intervalCallback =
            () : void =>
            {
                const timeoutMs = 1000;

                const args =
                [
                    // For backward compatibility with RTags before it supported the path argument
                    "--is-indexing=" + toRtagsProjectPath(this.uri),
                    "--timeout",
                    timeoutMs.toString()
                ];

                const processCallback =
                    (output: string) : void =>
                    {
                        const indexing = (output.trim() === "1");
                        if (!indexing)
                        {
                            onStop(this);

                            window.showInformationMessage("[RTags] Finished " + action + " project: " +
                                                          this.uri.fsPath);
                        }
                    };

                runRc(args, processCallback);
            };

        this.timer = setInterval(intervalCallback, 5000);
    }

    public readonly id: number;
    public readonly uri: Uri;

    protected abstract getAction() : string;
    protected abstract execute() : Promise<Optional<boolean>>;

    private static getNextId() : number
    {
        const id = ProjectTask.nextId;
        ProjectTask.nextId = (ProjectTask.nextId !== Number.MAX_SAFE_INTEGER) ? (ProjectTask.nextId + 1) : 0;
        return id;
    }

    private static nextId: number = 0;
    private timer: Nullable<NodeJS.Timer> = null;
}

class ProjectLoadTask extends ProjectTask
{
    constructor(projectPath: Uri, compileFile: Uri)
    {
        super(projectPath);
        this.compileFile = compileFile;
    }

    public getType() : TaskType
    {
        return TaskType.Load;
    }

    protected getAction() : string
    {
        return "loading";
    }

    protected execute() : Promise<Optional<boolean>>
    {
        return runRc(["--load-compile-commands", this.compileFile.fsPath], (_unused) => { return true; });
    }

    private compileFile: Uri;
}

class ProjectReindexTask extends ProjectTask
{
    constructor(projectPath: Uri, unsavedFiles: TextDocument[])
    {
        super(projectPath);
        this.unsavedFiles = unsavedFiles;
    }

    public getType() : TaskType
    {
        return TaskType.Reindex;
    }

    protected getAction() : string
    {
        return "reindexing";
    }

    protected execute() : Promise<Optional<boolean>>
    {
        return runRc(["--project", toRtagsProjectPath(this.uri), "--reindex"],
                     (_unused) => { return true; },
                     this.unsavedFiles);
    }

    private unsavedFiles: TextDocument[];
}

interface ResumeTimerInfo
{
    file: TextDocument;
    timer: NodeJS.Timer;
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

function spawnRc(args: string[], ignoreStdio: boolean = false) : Nullable<ChildProcess>
{
    const options: SpawnOptions =
    {
        stdio: (ignoreStdio ? "ignore" : "pipe")
    };

    return safeSpawn(getRcExecutable(), args, options);
}

function testRcProcess() : boolean
{
    const rc = spawnRc(["--current-project"], true);
    return ((rc !== null) && (rc.pid !== undefined));
}

async function testRcConnection() : Promise<boolean>
{
    let status = false;
    const execFilePromise = util.promisify(execFile);

    try
    {
        await execFilePromise(getRcExecutable(), ["--current-project"]);
        status = true;
    }
    catch (_err)
    {
    }

    return status;
}

function isExtensionUpgraded(globalState: Memento) : boolean
{
    const extension = extensions.getExtension(ExtensionId);
    if (!extension)
    {
        return false;
    }

    const extVersion: string = extension.packageJSON.version;
    const [extMajor, extMinor, extPatch] = extVersion.split('.');

    const prevExtVersion = globalState.get<string>("rtags.extensionVersion", "0.0.0");
    const [prevExtMajor, prevExtMinor, prevExtPatch] = prevExtVersion.split('.');

    if (prevExtVersion !== extVersion)
    {
        globalState.update("rtags.extensionVersion", extVersion);
    }

    return ((extMajor > prevExtMajor) ||
            ((extMajor === prevExtMajor) && (extMinor > prevExtMinor)) ||
            ((extMajor === prevExtMajor) && (extMinor === prevExtMinor) && (extPatch > prevExtPatch)));
}

function getRtagsVersion() : Promise<Optional<string>>
{
    const processCallback =
        (output: string) : string =>
        {
            const trimmedOutput = output.trim();
            const databaseIndex = trimmedOutput.lastIndexOf('.');
            return ((databaseIndex !== -1) ? trimmedOutput.slice(0, databaseIndex) : trimmedOutput);
        };

    return runRc(["--version"], processCallback);
}

function getRtagsRecommendedVersionInfo() : RtagsVersionInfo
{
    let version: string;
    let url = "https://github.com/" + RtagsRepository;
    if (RtagsRecommendedCommit.length !== 0)
    {
        version = RtagsRecommendedCommit.slice(0, RtagsCommitAbbrevLength);
        url += "/commit/" + RtagsRecommendedCommit;
    }
    else
    {
        version = 'v' + RtagsRecommendedVersion;
        url += "/releases/tag/" + version;
    }

    const versionInfo: RtagsVersionInfo =
    {
        version: version,
        linkUrl: Uri.parse(url),
        linkText: RtagsRepository + '@' + version
    };

    return versionInfo;
}

function isRtagsVersionGreater(version: string, referenceVersion: string, orEqual: boolean = false) : boolean
{
    if (orEqual && (version === referenceVersion))
    {
        return true;
    }

    const [major, minor] = version.split('.');
    const [refMajor, refMinor] = referenceVersion.split('.');

    return ((major > refMajor) || ((major === refMajor) && (minor > refMinor)));
}

function showRtagsVersionMessage(versionInfo: RtagsVersionInfo, message: string, isError: boolean = false) : void
{
    const resolveCallback =
        (selectedAction?: string) : void =>
        {
            if (selectedAction === versionInfo.linkText)
            {
                commands.executeCommand(VsCodeCommand.Open, versionInfo.linkUrl);
            }
        };

    const showMessage = isError ? window.showErrorMessage : window.showInformationMessage;

    showMessage(message, versionInfo.linkText).then(resolveCallback);
}

function showRtagsRecommendedVersion(currentVersion: string, globalState: Memento) : void
{
    if (!isExtensionUpgraded(globalState))
    {
        return;
    }

    if (isRtagsVersionGreater(currentVersion, RtagsRecommendedVersion))
    {
        return;
    }

    if ((currentVersion === RtagsRecommendedVersion) && (RtagsRecommendedCommit.length === 0))
    {
        return;
    }

    const recommendedVersionInfo = getRtagsRecommendedVersionInfo();

    let message = "[RTags] ";
    if (currentVersion === RtagsRecommendedVersion)
    {
        message += "Recommended RTags version: " + recommendedVersionInfo.version + " or later.";
    }
    else
    {
        message += "A newer version of RTags is recommended" +
                   ". Installed version: v" + currentVersion +
                   ". Recommended version: " + recommendedVersionInfo.version + " or later.";
    }

    showRtagsVersionMessage(recommendedVersionInfo, message);
}

async function startRdm() : Promise<boolean>
{
    let rcStatus = await testRcConnection();
    if (rcStatus)
    {
        // rc connected to rdm successfully
        return true;
    }

    const config = workspace.getConfiguration(ConfigurationId);
    const rdmAutoLaunch = config.get<boolean>(WindowConfiguration.RdmAutoLaunch, true);
    if (!rdmAutoLaunch)
    {
        const rdmAutoLaunchId = makeConfigurationId(WindowConfiguration.RdmAutoLaunch);
        window.showErrorMessage("[RTags] The server is not running and auto-launch is disabled. " +
                                "Launch the server manually or enable the \"" + rdmAutoLaunchId + "\" setting.");
        return false;
    }

    const rdmExecutableId = makeConfigurationId(WindowConfiguration.RdmExecutable);
    const rdmExecutable = config.get<string>(WindowConfiguration.RdmExecutable, "rdm");
    if (!isAbsolutePathOrFilename(rdmExecutable))
    {
        window.showErrorMessage("[RTags] The \"" + rdmExecutableId + "\" setting must be an absolute path or an " +
                                "executable name (in the PATH).");
        return false;
    }

    let rdmArguments = config.get<string[]>(WindowConfiguration.RdmArguments, []);

    const jobCountExists = rdmArguments.some((arg) => { return (/^(-j=?(\d+)?|--job-count(=(\d+)?)?)$/).test(arg); });
    if (!jobCountExists)
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

    let rdm = safeSpawn(rdmExecutable, rdmArguments, options);

    if (rdm && rdm.pid)
    {
        rdm.unref();

        const errorCallback =
            (error: Error) : void =>
            {
                window.showErrorMessage("[RTags] Server error: " + error.message);
            };

        rdm.on("error", errorCallback);

        // Wait for rc to connect to rdm
        const sleep = util.promisify(setTimeout);
        const delayMs = 1000;
        const timeoutMs = 30 * delayMs;
        const endTimeMs = Date.now() + timeoutMs;
        while (!(rcStatus = await testRcConnection()))
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
        window.showInformationMessage("[RTags] Started the server successfully.");

        if (rdm)
        {
            const exitCallback =
                (_code: number, _signal: string) : void =>
                {
                    // Restart the server if it was killed unexpectedly
                    window.showErrorMessage("[RTags] The server stopped running. Restarting it.");
                    setTimeout(() => { startRdm(); }, 5000);
                };

            rdm.on("exit", exitCallback);
        }
    }
    else
    {
        const rdmArgumentsId = makeConfigurationId(WindowConfiguration.RdmArguments);
        window.showErrorMessage("[RTags] Could not start the server. " +
                                "Check the \"" + rdmExecutableId + "\" and \"" + rdmArgumentsId + "\" settings.");
    }

    return rcStatus;
}

async function initializeRtags(globalState: Memento) : Promise<boolean>
{
    const rcExecutableId = makeConfigurationId(WindowConfiguration.RcExecutable);

    if (!isAbsolutePathOrFilename(getRcExecutable()))
    {
        window.showErrorMessage("[RTags] The \"" + rcExecutableId + "\" setting must be an absolute path or an " +
                                "executable name (in the PATH).");
        return false;
    }

    if (!testRcProcess())
    {
        window.showErrorMessage("[RTags] Could not run the client. Check the \"" + rcExecutableId + "\" setting.");
        return false;
    }

    const rtagsVersion = await getRtagsVersion();
    if (!rtagsVersion)
    {
        return false;
    }

    if (!isRtagsVersionGreater(rtagsVersion, RtagsMinimumVersion, true))
    {
        const recommendedVersionInfo = getRtagsRecommendedVersionInfo();

        const message = "[RTags] A newer version of RTags is required" +
                        ". Installed version: v" + rtagsVersion +
                        ". Minimum version: v" + RtagsMinimumVersion +
                        ". Recommended version: " + recommendedVersionInfo.version + " or later.";

        showRtagsVersionMessage(recommendedVersionInfo, message, true);

        return false;
    }

    showRtagsRecommendedVersion(rtagsVersion, globalState);

    return startRdm();
}

function getProjectRoots() : Promise<Optional<Uri[]>>
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
            return paths.map((p) => { return Uri.file(removeTrailingSlash(p.replace(" <=", "").trim())); });
        };

    return runRc(["--project"], processCallback);
}

function getProjectRoot(workspacePath: Uri) : Promise<Optional<Uri>>
{
    const processCallback =
        (output: string) : Optional<Uri> =>
        {
            if (output.startsWith("No matches"))
            {
                return undefined;
            }
            return Uri.file(removeTrailingSlash(output.trim()));
        };

    return runRc(["--project", toRtagsProjectPath(workspacePath)], processCallback);
}

async function getLoadedCompileCommandsInfo(projectRoots?: Uri[]) :
    Promise<Optional<Map<string, CompileCommandsInfo[]>>>
{
    if (!projectRoots)
    {
        return undefined;
    }

    let loadedCompileInfo = new Map<string, CompileCommandsInfo[]>();

    for (const root of projectRoots)
    {
        const args =
        [
            "--project",
            toRtagsProjectPath(root),
            "--status",
            "project"
        ];

        const processStatusCallback =
            (output: string) : string[] =>
            {
                let dirs: string[] = [];
                const regex = new RegExp("File: (.*)/" + CompileCommandsFilename.replace('.', "\\."), 'g');
                let dir: Nullable<RegExpExecArray>;
                while ((dir = regex.exec(output)) !== null)
                {
                    dirs.push(dir[1]);
                }
                return dirs;
            };

        const directories = await runRc(args, processStatusCallback);
        if (directories)
        {
            let compileInfo: CompileCommandsInfo[] = [];
            for (const dir of directories)
            {
                const info: CompileCommandsInfo =
                {
                    directory: Uri.file(dir)
                };
                compileInfo.push(info);
            }
            loadedCompileInfo.set(root.fsPath, compileInfo);
        }
    }

    return loadedCompileInfo;
}

function getCompileCommandsInfo(workspacePath: Uri) : CompileCommandsInfo
{
    const config = workspace.getConfiguration(ConfigurationId, workspacePath);
    const compileDirectory =
        fromConfigurationPath(config.get<string>(ResourceConfiguration.MiscCompilationDatabaseDirectory, ""));

    let directory: Uri;
    let isConfig: boolean;
    if (compileDirectory.length !== 0)
    {
        if (!path.isAbsolute(compileDirectory))
        {
            const compileDirectoryId =
                makeConfigurationId(ResourceConfiguration.MiscCompilationDatabaseDirectory);

            throw new RangeError("The \"" + compileDirectoryId + "\" setting must be an absolute path.");
        }
        directory = Uri.file(compileDirectory);
        isConfig = true;
    }
    else
    {
        directory = workspacePath;
        isConfig = false;
    }

    const info: CompileCommandsInfo =
    {
        directory: directory,
        isConfig: isConfig
    };
    return info;
}

function showProjectLoadErrorMessage(workspacePath: Uri, message: string) : void
{
    window.showErrorMessage("[RTags] Could not load the project: " + workspacePath.fsPath + ". " + message);
}

function validateLoadedProjects(workspaceCompileInfo: CompileCommandsInfo,
                                projectRoot?: Uri,
                                loadedCompileInfo?: Map<string, CompileCommandsInfo[]>) :
    boolean
{
    if (!loadedCompileInfo)
    {
        return false;
    }

    let projectLoaded = false;

    if (projectRoot)
    {
        const compileInfo = loadedCompileInfo.get(projectRoot.fsPath);
        if (compileInfo)
        {
            projectLoaded = compileInfo.some(
                (info) => { return (info.directory.fsPath === workspaceCompileInfo.directory.fsPath); });
        }
    }

    if (!projectLoaded)
    {
        for (const [root, compileInfo] of loadedCompileInfo)
        {
            const loaded = compileInfo.some(
                (info) => { return (info.directory.fsPath === workspaceCompileInfo.directory.fsPath); });

            if (loaded)
            {
                throw RangeError("The workspace folder is already loaded at a different project root: " + root);
            }
        }
    }

    return projectLoaded;
}

function readFirstCompileCommand(compileCommandsFile: Uri) : Promise<Optional<string>>
{
    const executorCallback =
        (resolve: (value?: string) => void, _reject: (reason?: any) => void) : void =>
        {
            let resolved = false;

            const resolveError =
                () : void =>
                {
                    if (!resolved)
                    {
                        resolved = true;
                        resolve();
                    }
                };

            try
            {
                const stream = fs.createReadStream(compileCommandsFile.fsPath,
                                                   {encoding: "utf8", autoClose: true, highWaterMark: 512});

                let compileCommand = "";

                const dataCallback =
                    (chunk: string) : void =>
                    {
                        const endIndex = chunk.indexOf('}');
                        if (endIndex !== -1)
                        {
                            chunk = chunk.slice(0, endIndex + 1);
                        }
                        compileCommand += chunk;
                        if (endIndex !== -1)
                        {
                            compileCommand += "\n]";
                            resolved = true;
                            stream.destroy();
                            resolve(compileCommand);
                        }
                    };

                stream.on("data", dataCallback);

                stream.on("end", resolveError);
                stream.on("error", resolveError);
            }
            catch (_err)
            {
                resolveError();
            }
        };

    return new Promise<string>(executorCallback);
}

async function findProjectRoot(compileCommandsFile: Uri) : Promise<Optional<Uri>>
{
    const compileCommandString = await readFirstCompileCommand(compileCommandsFile);
    if (!compileCommandString)
    {
        return undefined;
    }

    const compileCommandArray = parseJson(compileCommandString);
    if (!compileCommandArray)
    {
        return undefined;
    }

    const compileCommand = compileCommandArray[0];
    if (!compileCommand.hasOwnProperty("directory") || !compileCommand.hasOwnProperty("file"))
    {
        return undefined;
    }

    const compileDirectory: string = compileCommand.directory;
    if (!path.isAbsolute(compileDirectory))
    {
        return undefined;
    }

    let compileFile: string = compileCommand.file;
    if (!path.isAbsolute(compileFile))
    {
        compileFile = path.resolve(compileCommand.directory, compileFile);
    }

    const processCallback =
        (output: string) : Optional<string> =>
        {
            const projectRoot = output.match(/=> \[(.*)\]/);
            return (projectRoot ? removeTrailingSlash(projectRoot[1]) : undefined);
        };

    let projectRoot = await runRc(["--no-realpath", "--find-project-root", compileFile], processCallback);
    if (!projectRoot)
    {
        projectRoot = await runRc(["--find-project-root", compileFile], processCallback);
    }
    if (projectRoot)
    {
        projectRoot = await getRealPath(projectRoot);
    }
    if (!projectRoot)
    {
        return undefined;
    }

    return Uri.file(projectRoot);
}

async function validateCompileCommands(compileCommandsFile: Uri, workspacePath: Uri) : Promise<boolean>
{
    const projectRoot = await findProjectRoot(compileCommandsFile);
    if (!projectRoot)
    {
        showProjectLoadErrorMessage(
            workspacePath, "Unable to find the project root path in " + compileCommandsFile.fsPath);

        return false;
    }

    if (!addTrailingSlash(workspacePath.fsPath).startsWith(addTrailingSlash(projectRoot.fsPath)))
    {
        showProjectLoadErrorMessage(
            workspacePath, "The workspace folder must be inside the expected project root " + projectRoot.fsPath);

        return false;
    }

    return true;
}

async function removeProject(workspacePath: Uri, canDeleteProject: boolean, compileDirectory?: string) :
    Promise<Optional<boolean>>
{
    let projectRemoved: Optional<boolean> = false;

    const projectPath = toRtagsProjectPath(workspacePath);

    const processCallback =
        (output: string) : boolean =>
        {
            return !output.startsWith("No");
        };

    if (compileDirectory)
    {
        const compileFile = addTrailingSlash(compileDirectory) + CompileCommandsFilename;

        const args =
        [
            "--project",
            projectPath,
            "--remove",
            compileFile
        ];

        projectRemoved = await runRc(args, processCallback);
    }

    if (!projectRemoved && canDeleteProject)
    {
        projectRemoved = await runRc(["--delete-project", projectPath], processCallback);
    }

    return projectRemoved;
}

function getSuspendedFilePaths(projectPath: Uri) : Promise<Optional<string[]>>
{
    const args =
    [
        "--project",
        toRtagsProjectPath(projectPath),
        "--suspend"
    ];

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
    constructor(globalState: Memento, workspaceState: Memento)
    {
        this.workspaceState = workspaceState;

        this.cachedWorkspaceConfig = getWorkspaceConfiguration();

        const config = workspace.getConfiguration(ConfigurationId);
        this.diagnosticsEnabled = config.get<boolean>(WindowConfiguration.DiagnosticsEnabled, true);
        if (this.diagnosticsEnabled)
        {
            this.diagnosticCollection = languages.createDiagnosticCollection(ConfigurationId);
            this.disposables.push(this.diagnosticCollection);

            this.diagnosticsOpenFilesOnly = config.get<boolean>(WindowConfiguration.DiagnosticsOpenFilesOnly, true);
            if (this.diagnosticsOpenFilesOnly)
            {
                this.disposables.push(
                    workspace.onDidOpenTextDocument(this.diagnoseFile, this),
                    workspace.onDidCloseTextDocument(this.undiagnoseFile, this));
            }
        }

        (async () =>
        {
            this.rtagsInitialized = initializeRtags(globalState);
            if (await this.rtagsInitialized)
            {
                this.startDiagnostics();
                this.addProjects(workspace.workspaceFolders);
            }
        })();

        const changeConfigCallback =
            async (event: ConfigurationChangeEvent) : Promise<void> =>
            {
                let reloadWindow = false;

                for (const key in WindowConfiguration)
                {
                    const val = WindowConfiguration[key];
                    if (event.affectsConfiguration(makeConfigurationId(val)))
                    {
                        reloadWindow = true;
                        break;
                    }
                }

                const newWorkspaceConfig = getWorkspaceConfiguration();

                let projectPathsToReload = this.getProjectPathsToReload();

                const origProjectPathCount = projectPathsToReload.size;

                if (workspace.workspaceFolders)
                {
                    for (const folder of workspace.workspaceFolders)
                    {
                        const workspacePath = folder.uri.fsPath;

                        const cachedConfig = this.cachedWorkspaceConfig.get(workspacePath);
                        const newConfig = newWorkspaceConfig.get(workspacePath);
                        if (cachedConfig && newConfig)
                        {
                            const cachedCompileDirectory = fromConfigurationPath(
                                cachedConfig[ResourceConfiguration.MiscCompilationDatabaseDirectory]);
                            const newCompileDirectory = fromConfigurationPath(
                                newConfig[ResourceConfiguration.MiscCompilationDatabaseDirectory]);

                            if (cachedCompileDirectory !== newCompileDirectory)
                            {
                                reloadWindow = true;

                                const projectExists =
                                    this.projectPaths.some((p) => { return (p.fsPath === workspacePath); });

                                if (projectExists)
                                {
                                    if (!projectPathsToReload.has(workspacePath))
                                    {
                                        projectPathsToReload.set(workspacePath, cachedCompileDirectory);
                                    }
                                }
                            }
                        }
                    }
                }

                this.cachedWorkspaceConfig = newWorkspaceConfig;

                if (!reloadWindow)
                {
                    return;
                }

                if (projectPathsToReload.size !== origProjectPathCount)
                {
                    await this.setProjectPathsToReload(projectPathsToReload);
                }

                const reloadAction = "Reload Now";
                const selectedAction =
                    await window.showInformationMessage("Reload to apply the configuration change.", reloadAction);

                if (selectedAction === reloadAction)
                {
                    commands.executeCommand(VsCodeCommand.ReloadWindow);
                }
            };

        this.disposables.push(
            commands.registerCommand(RtagsCommand.ReindexActiveFolder, this.reindexActiveProject, this),
            commands.registerCommand(RtagsCommand.ReindexWorkspace, this.reindexProjects, this),
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
        const candidatePaths =
            this.projectPaths.filter((p) => { return (uri.fsPath.startsWith(addTrailingSlash(p.fsPath))); });

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
        let candidateTasks: ProjectTask[] = [];
        for (const task of this.projectTasks.values())
        {
            if ((task.getType() === TaskType.Load) && (uri.fsPath.startsWith(addTrailingSlash(task.uri.fsPath))))
            {
                candidateTasks.push(task);
            }
        }

        let projectTask = candidateTasks.pop();
        for (const task of candidateTasks)
        {
            // Assume that the URI belongs to the project with the deepest path
            if (projectTask && (task.uri.fsPath.length > projectTask.uri.fsPath.length))
            {
                projectTask = task;
            }
        }
        if (!projectTask)
        {
            return false;
        }

        const loadingProjectPath = projectTask.uri;

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

    private addProjectPath(uri: Uri) : void
    {
        this.projectPaths.push(uri);

        if (this.projectPaths.length > 1)
        {
            showContribution(RtagsCommand.ReindexActiveFolder);
        }
    }

    private removeProjectPath(uri: Uri) : void
    {
        const index = this.projectPaths.findIndex((p) => { return (p.fsPath === uri.fsPath); });
        if (index !== -1)
        {
            this.projectPaths.splice(index, 1);
        }

        if (this.projectPaths.length <= 1)
        {
            hideContribution(RtagsCommand.ReindexActiveFolder);
        }
    }

    private getProjectPathsToReload() : Map<string, string>
    {
        return new Map<string, string>(
            this.workspaceState.get<ReadonlyArray<[string, string]>>("rtags.projectPathsToReload", []));
    }

    private setProjectPathsToReload(paths: Map<string, string>) : Thenable<void>
    {
        return this.workspaceState.update("rtags.projectPathsToReload", (paths.size !== 0) ? [...paths] : undefined);
    }

    private async addProjects(folders?: WorkspaceFolder[]) : Promise<void>
    {
        if (!folders || (folders.length === 0))
        {
            return;
        }

        let projectPathsToReload = this.getProjectPathsToReload();

        const origProjectPathCount = projectPathsToReload.size;

        const projectRoots = await getProjectRoots();
        const loadedCompileInfo = await getLoadedCompileCommandsInfo(projectRoots);

        // Consider only VS Code workspace folders, and ignore RTags projects that are not known to VS Code

        for (const folder of folders)
        {
            const workspacePath = folder.uri;

            let workspaceCompileInfo: CompileCommandsInfo;
            try
            {
                workspaceCompileInfo = getCompileCommandsInfo(workspacePath);
            }
            catch (err)
            {
                showProjectLoadErrorMessage(workspacePath, err.message);
                continue;
            }

            const projectRoot = await getProjectRoot(workspacePath);

            let projectLoaded = false;
            try
            {
                projectLoaded = validateLoadedProjects(workspaceCompileInfo, projectRoot, loadedCompileInfo);
            }
            catch (err)
            {
                showProjectLoadErrorMessage(workspacePath, err.message);
                continue;
            }

            const compileDirectoryToReload = projectPathsToReload.get(workspacePath.fsPath);

            const projectNeedsReload = (projectRoot && compileDirectoryToReload);

            const compileFile =
                Uri.file(addTrailingSlash(workspaceCompileInfo.directory.fsPath) + CompileCommandsFilename);

            const compileFileExists = await fileExists(compileFile.fsPath);
            if (compileFileExists)
            {
                const compileFileValid = await validateCompileCommands(compileFile, workspacePath);
                if (!compileFileValid)
                {
                    continue;
                }
            }
            else if (!projectLoaded || projectNeedsReload || workspaceCompileInfo.isConfig)
            {
                if (projectRoot || projectNeedsReload || workspaceCompileInfo.isConfig)
                {
                    showProjectLoadErrorMessage(
                        workspacePath, "Unable to find the compilation database: " + compileFile.fsPath);
                }
                continue;
            }

            if (projectLoaded && !projectNeedsReload)
            {
                this.addProjectPath(workspacePath);
                this.diagnoseProject(workspacePath);
            }
            else
            {
                if (projectNeedsReload)
                {
                    let canDeleteProject = false;
                    if (projectRoot && loadedCompileInfo)
                    {
                        const compileInfo = loadedCompileInfo.get(projectRoot.fsPath);
                        if (compileInfo)
                        {
                            canDeleteProject = (compileInfo.length <= 1);
                        }
                    }

                    const projectRemoved =
                        await removeProject(workspacePath, canDeleteProject, compileDirectoryToReload);

                    if (projectRemoved)
                    {
                        projectPathsToReload.delete(workspacePath.fsPath);
                    }
                    else
                    {
                        showProjectLoadErrorMessage(workspacePath, "Could not delete the project before reloading it.");
                        continue;
                    }
                }

                this.startProjectTask(new ProjectLoadTask(workspacePath, compileFile));
            }
        }

        if (projectPathsToReload.size !== origProjectPathCount)
        {
            await this.setProjectPathsToReload(projectPathsToReload);
        }
    }

    private removeProjects(folders?: WorkspaceFolder[]) : void
    {
        if (!folders)
        {
            return;
        }

        for (const folder of folders)
        {
            for (const task of this.projectTasks.values())
            {
                if (task.uri.fsPath === folder.uri.fsPath)
                {
                    this.stopProjectTask(task);
                }
            }

            this.removeProjectPath(folder.uri);
        }
    }

    private async updateProjects(event: WorkspaceFoldersChangeEvent) : Promise<void>
    {
        if (await this.rtagsInitialized)
        {
            this.removeProjects(event.removed);
            this.addProjects(event.added);
        }
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

        const args =
        [
            "--suspend",
            path,
            "on",
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

        // Block the event loop to ensure that the file is suspended before it is saved
        // Use a timeout because VS Code imposes a time budget on subscribers to the onWillSaveTextDocument event
        event.waitUntil(runRc(args, processCallback));

        if (!event.document.isDirty)
        {
            // FIXME: See https://github.com/Microsoft/vscode/issues/66338
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
        this.startProjectTask(new ProjectReindexTask(projectPath, this.getUnsavedSourceFiles(projectPath)));
    }

    private reindexProjects() : void
    {
        this.projectPaths.forEach(
            (p) => { this.startProjectTask(new ProjectReindexTask(p, this.getUnsavedSourceFiles(p))); });
    }

    private async startProjectTask(task: ProjectTask) : Promise<void>
    {
        const startCallback =
            (task: ProjectTask) : void =>
            {
                this.projectTasks.set(task.id, task);
            };

        const stopCallback =
            (task: ProjectTask) : void =>
            {
                this.stopProjectTask(task);

                if (task.getType() === TaskType.Load)
                {
                    this.addProjectPath(task.uri);
                }
            };

        task.start(startCallback, stopCallback);
    }

    private stopProjectTask(task: ProjectTask) : void
    {
        task.dispose();
        this.projectTasks.delete(task.id);
    }

    private startDiagnostics() : void
    {
        if (!this.diagnosticsEnabled)
        {
            return;
        }

        // Start a separate process for receiving asynchronous diagnostics
        this.diagnosticProcess = spawnRc(["--diagnostics", "--json"]);
        if (!this.diagnosticProcess || !this.diagnosticProcess.pid)
        {
            window.showErrorMessage("[RTags] Could not start the diagnostics process.");
            this.diagnosticProcess = null;
            return;
        }

        const dataCallback =
            (data: string) : void =>
            {
                this.unprocessedDiagnostics = this.processDiagnostics(this.unprocessedDiagnostics + data);
            };

        this.diagnosticProcess.stdout.on("data", dataCallback);

        const errorCallback =
            (error: Error) : void =>
            {
                window.showErrorMessage("[RTags] Diagnostics process error: " + error.message);
            };

        this.diagnosticProcess.on("error", errorCallback);

        const exitCallback =
            (_code: number, _signal: string) : void =>
            {
                this.unprocessedDiagnostics = "";
                if (this.diagnosticsEnabled)
                {
                    // Restart the diagnostics process if it was killed unexpectedly
                    window.showErrorMessage("[RTags] The diagnostics process stopped running. Restarting it.");
                    setTimeout(() => { this.startDiagnostics(); }, 5000);
                }
                else if (this.diagnosticCollection)
                {
                    this.diagnosticCollection.clear();
                }
            };

        this.diagnosticProcess.on("exit", exitCallback);
    }

    private stopDiagnostics() : void
    {
        if (this.diagnosticProcess)
        {
            this.diagnosticsEnabled = false;
            this.diagnosticProcess.kill();
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

    private diagnoseProject(projectPath: Uri) : void
    {
        if (!this.diagnosticsEnabled)
        {
            return;
        }

        if (this.diagnosticsOpenFilesOnly)
        {
            // Resend diagnostics for open files in the project
            const openSourceFiles = this.getOpenSourceFiles(projectPath);
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
            runRc(["--project", toRtagsProjectPath(projectPath), "--diagnose-all"]);
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
    private cachedWorkspaceConfig: Map<string, ConfigurationMap>;
    private rtagsInitialized: Promise<boolean> = Promise.resolve(false);
    private projectTasks = new Map<number, ProjectTask>();
    private projectPaths: Uri[] = [];
    private diagnosticsEnabled: boolean = true;
    private diagnosticsOpenFilesOnly: boolean = true;
    private diagnosticCollection: Nullable<DiagnosticCollection> = null;
    private diagnosticProcess: Nullable<ChildProcess> = null;
    private unprocessedDiagnostics: string = "";
    private reindexDelayTimers = new Map<string, NodeJS.Timer>();
    private suspendedFilePaths = new Set<string>();
    private resumeDelayTimers = new Map<string, ResumeTimerInfo>();
    private disposables: Disposable[] = [];
}
