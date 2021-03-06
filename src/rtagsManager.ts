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

import { Nullable, Optional, addTrailingSeparator, removeTrailingSeparator, isAbsolutePathOrFilename,
         makeAbsolutePath, isContainingDirectory, findFiles, isSymbolicLink, getRealPath, parseJson, safeSpawn }
         from './nodeUtil';

import { ConfigurationMap, getWorkspaceConfiguration, fromConfigurationPath, isSourceFile, isUnsavedSourceFile,
         isOpenSourceFile, showContribution, hideContribution } from './vscodeUtil';

import { RdmInfo, isRtagsRealPathEnabled, getRtagsRealPathArgument, getRtagsProjectPathArgument, fromRtagsPosition,
         getRcExecutable, runRc } from './rtagsUtil';

const CompileCommandsFilename = "compile_commands.json";
const RtagsRepository         = "Andersbakken/rtags";
const RtagsMinimumVersion     = "2.18";
const RtagsRecommendedVersion = "2.22";
const RtagsRecommendedCommit  = "";
const RtagsCommitAbbrevLength = 7;

interface RtagsVersionInfo
{
    version: string;
    linkUrl: Uri;
    linkText: string;
}

class CompileCommandsInfo
{
    constructor(directory: string | Uri, isDirectoryFromConfig?: boolean, recursiveSearchEnabled?: boolean)
    {
        this.directory = (typeof directory === "string") ? Uri.file(directory) : directory;
        this.isDirectoryFromConfig = isDirectoryFromConfig;
        this.recursiveSearchEnabled = recursiveSearchEnabled;
    }

    public directory: Uri;
    public isDirectoryFromConfig?: boolean;
    public recursiveSearchEnabled?: boolean;
}

enum CompileCommandsState
{
    Loaded,
    Unloaded
}

type CompileCommandsDirectories = [Uri[], Uri[]];

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

        window.showInformationMessage(
            "[RTags] " + actionCapital + " for workspace folder: " + this.uri.fsPath);

        onStart(this);

        // Keep polling RTags until it is finished indexing the project
        const intervalCallback =
            () : void =>
            {
                const timeoutMs = 1000;

                const args = getRtagsRealPathArgument();
                args.push(
                    // For backward compatibility with RTags before it supported the path argument
                    "--is-indexing=" + getRtagsProjectPathArgument(this.uri),
                    "--timeout",
                    timeoutMs.toString());

                const processCallback =
                    (output: string) : void =>
                    {
                        const indexing = (output.trim() === "1");
                        if (!indexing)
                        {
                            onStop(this);

                            window.showInformationMessage(
                                "[RTags] Finished " + action + " for workspace folder: " + this.uri.fsPath);
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
        return ("loading the compilation database " + this.compileFile.fsPath);
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
        return "reindexing the project";
    }

    protected execute() : Promise<Optional<boolean>>
    {
        const args = getRtagsRealPathArgument();
        args.push(
            "--project",
            getRtagsProjectPathArgument(this.uri),
            "--reindex");

        return runRc(args, (_unused) => { return true; }, this.unsavedFiles);
    }

    private unsavedFiles: TextDocument[];
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

function spawnRc(args: ReadonlyArray<string>, ignoreStdio: boolean = false) : Nullable<ChildProcess>
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
        window.showErrorMessage("[RTags] Could not start the server. Check the \"" + rdmExecutableId + "\" and \"" +
                                    rdmArgumentsId + "\" settings.");
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

    const rdmRunning = await startRdm();
    if (rdmRunning)
    {
        await RdmInfo.initialize();
    }

    return rdmRunning;
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
            return paths.map((p) => { return Uri.file(removeTrailingSeparator(p.replace(" <=", "").trim())); });
        };

    return runRc(["--project"], processCallback);
}

function validateProjectRoot(parentRoot: string, subRoot: string) : void
{
    if (isContainingDirectory(parentRoot, subRoot))
    {
        throw new Error("Nested project roots are not supported. Project root " + subRoot +
                            " is a subdirectory of project root " + parentRoot);
    }
}

function validateProjectRoots(projectRoots?: Uri[]) : void
{
    if (!projectRoots)
    {
        return;
    }

    for (const parent of projectRoots)
    {
        for (const sub of projectRoots)
        {
            validateProjectRoot(parent.fsPath, sub.fsPath);
        }
    }
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
        const args = getRtagsRealPathArgument();
        args.push(
            "--project",
            getRtagsProjectPathArgument(root),
            "--status",
            "project");

        const processStatusCallback =
            (output: string) : string[] =>
            {
                let dirs: string[] = [];
                let file: Nullable<RegExpExecArray>;
                let regex = /File: (.*)/g;
                while ((file = regex.exec(output)) !== null)
                {
                    dirs.push(file[1].replace(path.sep + CompileCommandsFilename, "").trim());
                }
                return dirs;
            };

        const directories = await runRc(args, processStatusCallback);
        if (directories)
        {
            let compileInfo: CompileCommandsInfo[] = [];
            for (const dir of directories)
            {
                compileInfo.push(new CompileCommandsInfo(dir));
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

    let compileInfo: CompileCommandsInfo;
    if (compileDirectory.length !== 0)
    {
        compileInfo = new CompileCommandsInfo(makeAbsolutePath(workspacePath.fsPath, compileDirectory), true);
    }
    else
    {
        compileInfo = new CompileCommandsInfo(workspacePath, false);
    }

    compileInfo.recursiveSearchEnabled =
        config.get<boolean>(ResourceConfiguration.MiscCompilationDatabaseRecursiveSearch, false);

    return compileInfo;
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
    if (!Array.isArray(compileCommandArray))
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

    const compileFile = makeAbsolutePath(compileCommand.directory, compileCommand.file);

    const processCallback =
        (output: string) : Optional<string> =>
        {
            const projectRoot = output.match(/=> \[(.*)\]/);
            return (projectRoot ? removeTrailingSeparator(projectRoot[1]) : undefined);
        };

    let projectRoot = await runRc(["--no-realpath", "--find-project-root", compileFile], processCallback);
    if (isRtagsRealPathEnabled())
    {
        if (!projectRoot)
        {
            projectRoot = await runRc(["--find-project-root", compileFile], processCallback);
        }
        if (projectRoot)
        {
            projectRoot = await getRealPath(projectRoot);
        }
    }
    if (!projectRoot)
    {
        return undefined;
    }

    return Uri.file(projectRoot);
}

function getProjectRoot(workspacePath: Uri) : Promise<Optional<Uri>>
{
    const args = getRtagsRealPathArgument();
    args.push(
        "--project",
        getRtagsProjectPathArgument(workspacePath));

    const processCallback =
        (output: string) : Optional<Uri> =>
        {
            if (output.startsWith("No matches"))
            {
                return undefined;
            }
            return Uri.file(removeTrailingSeparator(output.trim()));
        };

    return runRc(args, processCallback);
}

async function removeProject(workspacePath: Uri,
                             projectCompileDirectories: Uri[],
                             deleteAllowed: boolean,
                             deleteRequired: boolean) :
    Promise<Optional<boolean>>
{
    let projectRemoved: Optional<boolean> = false;

    const projectPath = getRtagsProjectPathArgument(workspacePath);

    const processCallback =
        (output: string) : boolean =>
        {
            return !output.startsWith("No");
        };

    if (deleteAllowed)
    {
        const args = getRtagsRealPathArgument();
        args.push(
            "--delete-project",
            projectPath);

        projectRemoved = await runRc(args, processCallback);
    }

    if (!projectRemoved && !deleteRequired)
    {
        let compileRemoved: Optional<boolean>[] = [];

        for (const dir of projectCompileDirectories)
        {
            const compileFile = addTrailingSeparator(dir.fsPath) + CompileCommandsFilename;

            const args = getRtagsRealPathArgument();
            args.push(
                "--project",
                projectPath,
                "--remove",
                compileFile);

            compileRemoved.push(await runRc(args, processCallback));
        }

        if (compileRemoved.length !== 0)
        {
            projectRemoved = compileRemoved.every((removed) => { return (removed === true); });
        }
    }

    return projectRemoved;
}

async function validateProject(workspacePath: Uri,
                               dirtyWorkspaceInfo: Map<string, CompileCommandsInfo>,
                               loadedCompileInfo?: Map<string, CompileCommandsInfo[]>) :
    Promise<CompileCommandsDirectories>
{
    if (isRtagsRealPathEnabled() && (await isSymbolicLink(workspacePath.fsPath)))
    {
        throw new Error("The workspace path must not be a symbolic link when the server is configured to follow " +
                            "symbolic links. Start the server with the --no-realpath option.");
    }

    const targetWorkspaceCompileInfo = getCompileCommandsInfo(workspacePath);

    const targetCompileBaseDirectory = targetWorkspaceCompileInfo.directory;

    // Find and validate the project root path from the target compilation databases

    const currentProjectRoot = await getProjectRoot(workspacePath);

    let targetProjectRoot: Optional<Uri> = undefined;

    let compileCommandsPattern = "";
    if (targetWorkspaceCompileInfo.recursiveSearchEnabled)
    {
        compileCommandsPattern += "**" + path.sep;
    }
    compileCommandsPattern += CompileCommandsFilename;

    const targetCompileFiles = await findFiles(targetCompileBaseDirectory.fsPath, compileCommandsPattern);

    for (const file of targetCompileFiles)
    {
        const projectRoot = await findProjectRoot(Uri.file(file));
        if (!projectRoot)
        {
            throw new Error("Unable to find the project root path from the compilation database: " + file);
        }

        if (!targetProjectRoot)
        {
            targetProjectRoot = projectRoot;

            if (!isContainingDirectory(targetProjectRoot.fsPath, workspacePath.fsPath, true))
            {
                throw new Error(
                    "The workspace folder must be within the target project root: " + targetProjectRoot.fsPath);
            }

            if (loadedCompileInfo)
            {
                for (const root of loadedCompileInfo.keys())
                {
                    if (!currentProjectRoot || (root !== currentProjectRoot.fsPath))
                    {
                        validateProjectRoot(root, targetProjectRoot.fsPath);
                        validateProjectRoot(targetProjectRoot.fsPath, root);
                    }
                }
            }
        }

        if (projectRoot.fsPath !== targetProjectRoot.fsPath)
        {
            throw new Error("The compilation database " + file + " has a different project root than others in the " +
                                "same directory: " + targetCompileBaseDirectory.fsPath + ". All compilation " +
                                "databases in the directory must have the same project root.");
        }
    }

    let projectRootDirty = false;
    if (currentProjectRoot && targetProjectRoot && (currentProjectRoot.fsPath !== targetProjectRoot.fsPath))
    {
        projectRootDirty = true;
    }

    // Check whether the target compilation databases are already loaded at the current or any other project root

    let targetCompileDirectories: CompileCommandsDirectories = [[], []];

    if (loadedCompileInfo)
    {
        for (const file of targetCompileFiles)
        {
            const targetCompileDirectory = Uri.file(file.replace(path.sep + CompileCommandsFilename, ""));

            let targetCompileLoaded = false;

            for (const [root, compileInfo] of loadedCompileInfo)
            {
                const compileLoaded =
                    compileInfo.some((info) => { return (info.directory.fsPath === targetCompileDirectory.fsPath); });

                if (compileLoaded)
                {
                    if (!currentProjectRoot || (root !== currentProjectRoot.fsPath))
                    {
                        throw new Error("The compilation database " + file + " is already loaded at another project " +
                                            "root: " + root);
                    }

                    targetCompileLoaded = true;
                }
            }

            const compileState = (targetCompileLoaded && !projectRootDirty) ?
                                     CompileCommandsState.Loaded : CompileCommandsState.Unloaded;

            targetCompileDirectories[compileState].push(targetCompileDirectory);
        }
    }

    // Check whether the current compilation databases must be removed before loading the target ones

    if (!currentProjectRoot)
    {
        dirtyWorkspaceInfo.delete(workspacePath.fsPath);
    }

    const currentWorkspaceCompileInfo = dirtyWorkspaceInfo.get(workspacePath.fsPath);

    const currentCompileBaseDirectory =
        currentWorkspaceCompileInfo ? currentWorkspaceCompileInfo.directory : undefined;

    const currentLoadedCompileInfo =
        (loadedCompileInfo && currentProjectRoot) ? loadedCompileInfo.get(currentProjectRoot.fsPath) : undefined;

    let compileDirectoryDirty = false;
    if (currentCompileBaseDirectory && (currentCompileBaseDirectory.fsPath !== targetCompileBaseDirectory.fsPath))
    {
        compileDirectoryDirty = true;
    }

    let recursiveSearchDirty = false;
    if (currentWorkspaceCompileInfo && currentWorkspaceCompileInfo.recursiveSearchEnabled &&
        !targetWorkspaceCompileInfo.recursiveSearchEnabled)
    {
        recursiveSearchDirty = true;
    }

    let currentInternalCompileDirectories: Uri[] = [];

    if (currentLoadedCompileInfo && currentCompileBaseDirectory)
    {
        const orEqual = (projectRootDirty || compileDirectoryDirty || !recursiveSearchDirty);

        for (const info of currentLoadedCompileInfo)
        {
            if (isContainingDirectory(currentCompileBaseDirectory.fsPath, info.directory.fsPath, orEqual))
            {
                currentInternalCompileDirectories.push(info.directory);
            }
        }
    }

    if (currentInternalCompileDirectories.length === 0)
    {
        compileDirectoryDirty = false;
        recursiveSearchDirty = false;
    }

    const projectDirty = (projectRootDirty || compileDirectoryDirty || recursiveSearchDirty);

    if (!targetProjectRoot)
    {
        const workspaceModified = (projectDirty || targetWorkspaceCompileInfo.isDirectoryFromConfig ||
                                  targetWorkspaceCompileInfo.recursiveSearchEnabled);

        if ((targetCompileDirectories[CompileCommandsState.Loaded].length === 0) || workspaceModified)
        {
            let message: Optional<string> = undefined;

            if (currentProjectRoot || workspaceModified)
            {
                const compileDirectoryId =
                    makeConfigurationId(ResourceConfiguration.MiscCompilationDatabaseDirectory);

                const recursiveSearchId =
                    makeConfigurationId(ResourceConfiguration.MiscCompilationDatabaseRecursiveSearch);

                message = "Unable to find a compilation database in the directory: " +
                              targetCompileBaseDirectory.fsPath + ". Check the \"" + compileDirectoryId +
                              "\" and \"" + recursiveSearchId + "\" settings.";
            }

            throw new Error(message);
        }
    }

    if (projectDirty)
    {
        // Prompt the user to remove the current project root or compilation databases

        let projectDesc = "";
        let projectPath = "";
        if (projectRootDirty)
        {
            projectDesc = "project root";
            if (currentProjectRoot)
            {
                projectPath = currentProjectRoot.fsPath;
            }
        }
        else
        {
            projectDesc = "compilation database";
            projectPath = currentInternalCompileDirectories.map(
                (dir) => { return (addTrailingSeparator(dir.fsPath) + CompileCommandsFilename); }).join(", ");
        }

        const message = "[RTags] The " + projectDesc + " is changing for workspace folder: " + workspacePath.fsPath +
                            ". Do you want to remove the existing " + projectDesc + ": " + projectPath + '?';

        const removeAction = "Remove";
        const keepAction = "Keep";
        const selectedAction = await window.showInformationMessage(message, removeAction, keepAction);

        if (selectedAction === removeAction)
        {
            const currentExternalCompileDirectoryExists =
                (!currentLoadedCompileInfo ||
                 (currentInternalCompileDirectories.length !== currentLoadedCompileInfo.length));

            const projectRemoved = await removeProject(workspacePath,
                                                       currentInternalCompileDirectories,
                                                       !currentExternalCompileDirectoryExists,
                                                       projectRootDirty);

            if (!projectRemoved)
            {
                const message = "Unable to remove the existing " + projectDesc;
                if (projectRootDirty)
                {
                    throw new Error(message + '.');
                }
                else
                {
                    window.showWarningMessage(
                        "[RTags] " + message + " for workspace folder: " + workspacePath.fsPath);
                }
            }
        }
        else if (projectRootDirty)
        {
            throw new Error("The existing " + projectDesc + " must first be removed.");
        }
    }

    dirtyWorkspaceInfo.delete(workspacePath.fsPath);

    return targetCompileDirectories;
}

function getSuspendedFilePaths(projectPath: Uri) : Promise<Optional<string[]>>
{
    const args = getRtagsRealPathArgument();
    args.push(
        "--project",
        getRtagsProjectPathArgument(projectPath),
        "--suspend");

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
                // FIXME: See https://github.com/microsoft/vscode/issues/73353
                // The onDidChangeWorkspaceFolders event fires before the onDidChangeConfiguration event
                // Allow the cached workspace configuration to be updated before proceeding
                await Promise.resolve();

                let reloadWindow = false;

                for (const val of Object.values(WindowConfiguration))
                {
                    if (event.affectsConfiguration(makeConfigurationId(val)))
                    {
                        reloadWindow = true;
                        break;
                    }
                }

                const newWorkspaceConfig = getWorkspaceConfiguration();

                let dirtyWorkspaceInfo = this.getDirtyWorkspaceInfo();

                const origDirtyWorkspaceInfoSize = dirtyWorkspaceInfo.size;

                for (const [workspacePath, newConfig] of newWorkspaceConfig)
                {
                    const cachedConfig = this.cachedWorkspaceConfig.get(workspacePath);
                    if (!cachedConfig)
                    {
                        continue;
                    }

                    const cachedCompileDirectoryConfig =
                        fromConfigurationPath(cachedConfig[ResourceConfiguration.MiscCompilationDatabaseDirectory]);

                    const newCompileDirectoryConfig =
                        fromConfigurationPath(newConfig[ResourceConfiguration.MiscCompilationDatabaseDirectory]);

                    const cachedCompileDirectory = makeAbsolutePath(workspacePath, cachedCompileDirectoryConfig);
                    const newCompileDirectory = makeAbsolutePath(workspacePath, newCompileDirectoryConfig);

                    const cachedRecursiveSearch: boolean =
                        cachedConfig[ResourceConfiguration.MiscCompilationDatabaseRecursiveSearch];

                    const newRecursiveSearch: boolean =
                        newConfig[ResourceConfiguration.MiscCompilationDatabaseRecursiveSearch];

                    if ((cachedCompileDirectory !== newCompileDirectory) ||
                        (cachedRecursiveSearch !== newRecursiveSearch))
                    {
                        reloadWindow = true;

                        const projectExists = this.projectPaths.some((p) => { return (p.fsPath === workspacePath); });
                        if (projectExists && !dirtyWorkspaceInfo.has(workspacePath))
                        {
                            let compileInfo: CompileCommandsInfo;
                            if (cachedCompileDirectory.length !== 0)
                            {
                                compileInfo = new CompileCommandsInfo(cachedCompileDirectory, true);
                            }
                            else
                            {
                                compileInfo = new CompileCommandsInfo(workspacePath, false);
                            }
                            compileInfo.recursiveSearchEnabled = cachedRecursiveSearch;

                            // The fsPath property is generated on demand
                            // Force it to be generated so that it will be serialized
                            // tslint:disable-next-line: no-unused-expression
                            compileInfo.directory.fsPath;

                            dirtyWorkspaceInfo.set(workspacePath, compileInfo);
                        }
                    }
                }

                this.cachedWorkspaceConfig = newWorkspaceConfig;

                if (!reloadWindow)
                {
                    return;
                }

                if (dirtyWorkspaceInfo.size !== origDirtyWorkspaceInfoSize)
                {
                    await this.setDirtyWorkspaceInfo(dirtyWorkspaceInfo);
                }

                const reloadAction = "Reload Now";
                const selectedAction = await window.showInformationMessage("Please reload the window to apply the " +
                                                                               "configuration change.", reloadAction);

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
            this.projectPaths.filter((p) => { return isContainingDirectory(p.fsPath, uri.fsPath); });

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
        const projectExists = this.projectPaths.some((p) => { return (p.fsPath === uri.fsPath); });
        if (!projectExists)
        {
            this.projectPaths.push(uri);

            if (this.projectPaths.length > 1)
            {
                showContribution(RtagsCommand.ReindexActiveFolder);
            }
        }
    }

    private removeProjectPath(uri: Uri) : void
    {
        const index = this.projectPaths.findIndex((p) => { return (p.fsPath === uri.fsPath); });
        if (index !== -1)
        {
            this.projectPaths.splice(index, 1);

            if (this.projectPaths.length <= 1)
            {
                hideContribution(RtagsCommand.ReindexActiveFolder);
            }
        }
    }

    private getDirtyWorkspaceInfo() : Map<string, CompileCommandsInfo>
    {
        return new Map<string, CompileCommandsInfo>(
            this.workspaceState.get<ReadonlyArray<[string, CompileCommandsInfo]>>("rtags.dirtyWorkspaceInfo", []));
    }

    private setDirtyWorkspaceInfo(info: Map<string, CompileCommandsInfo>) : Thenable<void>
    {
        return this.workspaceState.update("rtags.dirtyWorkspaceInfo", (info.size !== 0) ? [...info] : undefined);
    }

    private async addProjects(folders?: ReadonlyArray<WorkspaceFolder>) : Promise<void>
    {
        if (!folders || (folders.length === 0))
        {
            return;
        }

        let dirtyWorkspaceInfo = this.getDirtyWorkspaceInfo();

        const origDirtyWorkspaceInfoSize = dirtyWorkspaceInfo.size;

        const projectRoots = await getProjectRoots();

        try
        {
            validateProjectRoots(projectRoots);
        }
        catch (err)
        {
            const plural = (folders.length > 1) ? 's' : "";
            window.showErrorMessage("[RTags] Could not load the compilation database" + plural +
                                        " for the opened workspace folder" + plural + ". " +
                                        err.message);

            return;
        }

        const loadedCompileInfo = await getLoadedCompileCommandsInfo(projectRoots);

        // Consider only VS Code workspace folders, and ignore RTags projects that are not known to VS Code

        for (const folder of folders)
        {
            const workspacePath = folder.uri;

            try
            {
                const compileDirectories = await validateProject(workspacePath,
                                                                 dirtyWorkspaceInfo,
                                                                 loadedCompileInfo);

                if (compileDirectories[CompileCommandsState.Loaded].length !== 0)
                {
                    this.addProjectPath(workspacePath);
                    this.diagnoseProject(workspacePath);
                }

                for (const dir of compileDirectories[CompileCommandsState.Unloaded])
                {
                    const compileFile = Uri.file(addTrailingSeparator(dir.fsPath) + CompileCommandsFilename);

                    await this.startProjectTask(new ProjectLoadTask(workspacePath, compileFile));
                }
            }
            catch (err)
            {
                if (err.message)
                {
                    window.showErrorMessage("[RTags] Could not load the compilation database for workspace folder: " +
                                                workspacePath.fsPath + ". " + err.message);
                }
            }
        }

        if (dirtyWorkspaceInfo.size !== origDirtyWorkspaceInfoSize)
        {
            await this.setDirtyWorkspaceInfo(dirtyWorkspaceInfo);
        }
    }

    private removeProjects(folders?: ReadonlyArray<WorkspaceFolder>) : void
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
        // FIXME: See https://github.com/microsoft/vscode/issues/73353
        // The onDidChangeWorkspaceFolders event fires before the workspace configuration has been updated
        // Allow the workspace configuration to be updated before proceeding
        if (await this.rtagsInitialized)
        {
            this.cachedWorkspaceConfig = getWorkspaceConfiguration();
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

        const reindex =
            () : void =>
            {
                const args = getRtagsRealPathArgument();
                args.push(
                    reindexArg,
                    file.uri.fsPath);

                runRc(args, undefined, unsavedFiles);
            };

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

        const timeoutCallback =
            async () : Promise<void> =>
            {
                this.reindexDelayTimers.delete(path);

                this.reindexFile(event.document, true);
            };

        this.reindexDelayTimers.set(path, setTimeout(timeoutCallback, 500));
    }

    private async reindexSavedFile(file: TextDocument) : Promise<void>
    {
        if (!isSourceFile(file) || !this.isInProject(file.uri))
        {
            return;
        }

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

                return runRc(["--suspend", path, "off"], processCallback);
            };

        return getSuspendedFilePaths(projectPath).then(resolveCallback);
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

    private async reindexProjects() : Promise<void>
    {
        for (const path of this.projectPaths)
        {
            await this.startProjectTask(new ProjectReindexTask(path, this.getUnsavedSourceFiles(path)));
        }
    }

    private startProjectTask(task: ProjectTask) : Promise<void>
    {
        const startCallback =
            (task: ProjectTask) : void =>
            {
                this.projectTasks.set(task.id, task);

                if (task.getType() === TaskType.Load)
                {
                    this.addProjectPath(task.uri);
                }
            };

        const stopCallback =
            (task: ProjectTask) : void =>
            {
                this.stopProjectTask(task);
            };

        return task.start(startCallback, stopCallback);
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

            if (!this.isInProject(uri))
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
                let args = getRtagsRealPathArgument();
                openSourceFiles.forEach((file) => { args.push("--diagnose", file.uri.fsPath); });
                runRc(args);
            }
        }
        else
        {
            // Resend diagnostics for all files in the project
            const args = getRtagsRealPathArgument();
            args.push(
                "--project",
                getRtagsProjectPathArgument(projectPath),
                "--diagnose-all");

            runRc(args);
        }
    }

    private diagnoseFile(file: TextDocument) : void
    {
        if (!isSourceFile(file) || !this.isInProject(file.uri))
        {
            return;
        }

        const args = getRtagsRealPathArgument();
        args.push(
            "--diagnose",
            file.uri.fsPath);

        runRc(args);
    }

    private undiagnoseFile(file: TextDocument) : void
    {
        if (!isSourceFile(file) || !this.isInProject(file.uri))
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
    private disposables: Disposable[] = [];
}
