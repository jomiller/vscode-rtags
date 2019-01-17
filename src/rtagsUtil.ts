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

import { commands, languages, window, workspace, DocumentFilter, Location, Position, Range, TextDocument,
         TextDocumentShowOptions, Uri } from 'vscode';

import { ChildProcess, ExecFileOptionsWithStringEncoding, SpawnOptions, execFile, spawn } from 'child_process';

import * as path from 'path';

export type Nullable<T> = T | null;
export type Optional<T> = T | undefined;

export interface Locatable
{
    location: Location;
}

interface SymbolInfoBase
{
    location: string;
    name: string;
    length: number;
    kind: string;
    type?: string;
    isDefinition?: boolean;
    isVirtual?: boolean;
}

export interface SymbolInfo extends SymbolInfoBase
{
    targets?: SymbolInfoBase[];
}

export enum SymbolBaseCategory
{
    Macro,
    Namespace,
    Type,
    Function,
    Variable
}

export enum SymbolSubCategory
{
    MacroDef = SymbolBaseCategory.Variable + 1,
    NamespaceDef,
    TypeDecl,
    Declaration
}

export type SymbolCategory = SymbolBaseCategory | SymbolSubCategory;

export const SourceFileSelector: DocumentFilter[] =
[
    { language: "c",   scheme: "file" },
    { language: "cpp", scheme: "file" }
];

const RtagsMacroDefKinds = new Set<string>(
[
    "macrodefinition",
    "macro definition",
]);

const RtagsMacroKinds = new Set<string>(
[
    ...RtagsMacroDefKinds,
    "macroexpansion",
    "macro expansion"
]);

const RtagsNamespaceDefKinds = new Set<string>(
[
    "Namespace",
    "NamespaceAlias"
]);

const RtagsNamespaceKinds = new Set<string>(
[
    ...RtagsNamespaceDefKinds,
    "NamespaceRef"
]);

const RtagsTypeDeclKinds = new Set<string>(
[
    "ClassDecl",
    "ClassTemplate",
    "ClassTemplatePartialSpecialization",
    "StructDecl",
    "UnionDecl",
    "EnumDecl",
    "TypedefDecl",
    "TypeAliasDecl",
    "TypeAliasTemplateDecl",
    "TemplateTypeParameter",
    "TemplateTemplateParameter"
]);

const RtagsTypeFuncDeclKinds = new Set<string>(
[
    "CXXConstructor",
    "CXXDestructor"
]);

const RtagsTypeFuncKinds = new Set<string>(
[
    ...RtagsTypeFuncDeclKinds,
    "CallExpr"
]);

const RtagsTypeKinds = new Set<string>(
[
    ...RtagsTypeDeclKinds,
    ...RtagsTypeFuncKinds,
    "UsingDeclaration",
    "TypeRef",
    "TemplateRef"
]);

const RtagsFunctionDeclKinds = new Set<string>(
[
    ...RtagsTypeFuncDeclKinds,
    "CXXConversion",
    "CXXMethod",
    "FunctionDecl",
    "FunctionTemplate"
]);

const RtagsFunctionKinds = new Set<string>(
[
    ...RtagsTypeFuncKinds,
    ...RtagsFunctionDeclKinds,
    "MemberRefExpr",
    "DeclRefExpr"
]);

const RtagsVariableDeclKinds = new Set<string>(
[
    "FieldDecl",
    "ParmDecl",
    "VarDecl",
    "EnumConstantDecl",
    "NonTypeTemplateParameter"
]);

const RtagsVariableKinds = new Set<string>(
[
    ...RtagsVariableDeclKinds,
    "MemberRef",
    "VariableRef",
    "MemberRefExpr",
    "DeclRefExpr"
]);

const RtagsDeclarationKinds = new Set<string>(
[
    ...RtagsTypeDeclKinds,
    ...RtagsTypeFuncDeclKinds,
    ...RtagsFunctionDeclKinds,
    ...RtagsVariableDeclKinds
]);

const RtagsSymbolKinds = new Set<string>(
[
    ...RtagsMacroKinds,
    ...RtagsNamespaceKinds,
    ...RtagsTypeKinds,
    ...RtagsFunctionKinds,
    ...RtagsVariableKinds
]);

export function isSourceFile(file: TextDocument) : boolean
{
    return (languages.match(SourceFileSelector, file) > 0);
}

export function isUnsavedSourceFile(file: TextDocument) : boolean
{
    if (!file.isDirty)
    {
        return false;
    }
    return isSourceFile(file);
}

export function isOpenSourceFile(uri: Uri) : boolean
{
    const file = workspace.textDocuments.find((file) => { return (file.uri.fsPath === uri.fsPath); });
    if (!file)
    {
        return false;
    }
    return isSourceFile(file);
}

function getRtagsSymbolKindsImpl(category?: SymbolCategory) : Set<string>
{
    let symbolKinds: Set<string>;

    switch (category)
    {
        case SymbolBaseCategory.Macro:
            symbolKinds = RtagsMacroKinds;
            break;

        case SymbolBaseCategory.Namespace:
            symbolKinds = RtagsNamespaceKinds;
            break;

        case SymbolBaseCategory.Type:
            symbolKinds = RtagsTypeKinds;
            break;

        case SymbolBaseCategory.Function:
            symbolKinds = RtagsFunctionKinds;
            break;

        case SymbolBaseCategory.Variable:
            symbolKinds = RtagsVariableKinds;
            break;

        case SymbolSubCategory.MacroDef:
            symbolKinds = RtagsMacroDefKinds;
            break;

        case SymbolSubCategory.NamespaceDef:
            symbolKinds = RtagsNamespaceDefKinds;
            break;

        case SymbolSubCategory.TypeDecl:
            symbolKinds = RtagsTypeDeclKinds;
            break;

        case SymbolSubCategory.Declaration:
            symbolKinds = RtagsDeclarationKinds;
            break;

        default:
            symbolKinds = RtagsSymbolKinds;
            break;
    }

    return symbolKinds;
}

function getSymbolCategories(symbolKind: string) : SymbolCategory[]
{
    let categories: SymbolCategory[] = [];
    for (const cat in SymbolBaseCategory)
    {
        const category = parseInt(cat);
        if (!isNaN(category) && getRtagsSymbolKindsImpl(category).has(symbolKind))
        {
            categories.push(category);
        }
    }
    return categories;
}

export function isRtagsSymbolKind(symbolKind: string,
                                  symbolKindOrCategories?: string | SymbolCategory | SymbolCategory[])
    : boolean
{
    if (typeof symbolKindOrCategories === "string")
    {
        symbolKindOrCategories = getSymbolCategories(symbolKindOrCategories);
    }
    if (symbolKindOrCategories && Array.isArray(symbolKindOrCategories))
    {
        return symbolKindOrCategories.some((c) => { return getRtagsSymbolKindsImpl(c).has(symbolKind); });
    }
    return getRtagsSymbolKindsImpl(symbolKindOrCategories).has(symbolKind);
}

export function getRtagsSymbolKinds(symbolKindOrCategories?: string | SymbolCategory | SymbolCategory[]) : Set<string>
{
    if (typeof symbolKindOrCategories === "string")
    {
        symbolKindOrCategories = getSymbolCategories(symbolKindOrCategories);
    }
    if (symbolKindOrCategories && Array.isArray(symbolKindOrCategories))
    {
        let symbolKinds = new Set<string>();
        symbolKindOrCategories.forEach((c) => { getRtagsSymbolKindsImpl(c).forEach(Set.prototype.add, symbolKinds); });
        return symbolKinds;
    }
    return getRtagsSymbolKindsImpl(symbolKindOrCategories);
}

export function addTrailingSlash(dir: string) : string
{
    if ((dir.length !== 0) && !dir.endsWith(path.sep))
    {
        return (dir + path.sep);
    }
    return dir;
}

export function removeTrailingSlash(dir: string) : string
{
    if ((dir.length !== 0) && dir.endsWith(path.sep))
    {
        return dir.slice(0, -1);
    }
    return dir;
}

export function fromRtagsPosition(line: string, column: string) : Position
{
    return new Position(parseInt(line) - 1, parseInt(column) - 1);
}

export function fromRtagsLocation(location: string) : Location
{
    const [file, line, col] = location.split(':');
    const position = fromRtagsPosition(line, col);
    const uri = Uri.file(file);
    return new Location(uri, position);
}

export function toRtagsLocation(uri: Uri, position: Position) : string
{
    const lineNumber = position.line + 1;
    const colNumber = position.character + 1;
    const location = uri.fsPath + ':' + lineNumber.toString() + ':' + colNumber.toString();
    return location;
}

export function jumpToLocation(uri: Uri, range: Range) : void
{
    const options: TextDocumentShowOptions = {selection: range};
    window.showTextDocument(uri, options);
}

export function setContext<T>(name: string, value: T) : void
{
    commands.executeCommand("setContext", name, value);
}

export function showContribution(name: string) : void
{
    setContext(name + ".visible", true);
}

export function hideContribution(name: string) : void
{
    setContext(name + ".visible", false);
}

export function showReferences(uri: Uri, position: Position, locations: Location[]) : void
{
    commands.executeCommand("editor.action.showReferences", uri, position, locations);
}

export function parseJson(input: string) : any
{
    let jsonObj: any = undefined;
    try
    {
        jsonObj = JSON.parse(input);
    }
    catch (_err)
    {
    }
    return jsonObj;
}

export function safeSpawn(command: string, args: ReadonlyArray<string>, options: SpawnOptions) :
    Nullable<ChildProcess>
{
    let process: Nullable<ChildProcess> = null;
    try
    {
        process = spawn(command, args, options);
    }
    catch (_err)
    {
    }
    return process;
}

function safeExecFile(file: string,
                      args: ReadonlyArray<string>,
                      options: ExecFileOptionsWithStringEncoding,
                      callback: (error: Nullable<Error>, stdout: string, stderr: string) => void) :
    Nullable<ChildProcess>
{
    let process: Nullable<ChildProcess> = null;
    try
    {
        process = execFile(file, args, options, callback);
    }
    catch (_err)
    {
    }
    return process;
}

export function getRcExecutable() : string
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

            const rcExe = getRcExecutable();
            const rcArgs = args.concat(localArgs);

            let rc = safeExecFile(rcExe, rcArgs, options, exitCallback);

            if (rc)
            {
                for (const file of unsavedFiles)
                {
                    rc.stdin.write(file.getText());
                }
                if (unsavedFiles.length !== 0)
                {
                    rc.stdin.end();
                }
            }
            else
            {
                window.showErrorMessage("[RTags] Command failed: " + rcExe + ' ' + rcArgs.join(' '));

                resolve();
            }
        };

    return new Promise<T>(executorCallback);
}

export function getSymbolInfo(uri: Uri, position: Position, includeTargets: boolean = false, timeout: number = 0) :
    Promise<Optional<SymbolInfo>>
{
    const location = toRtagsLocation(uri, position);

    let args =
    [
        "--symbol-info",
        location,
        "--absolute-path",
        "--no-context",
        "--json"
    ];

    if (includeTargets)
    {
        args.push("--symbol-info-include-targets");
    }

    if (timeout > 0)
    {
        args.push("--timeout", timeout.toString());
    }

    const processCallback =
        (output: string) : Optional<SymbolInfo> =>
        {
            const jsonObj = parseJson(output);
            if (!jsonObj)
            {
                return undefined;
            }

            let symbolInfo: SymbolInfo =
            {
                location: jsonObj.location,
                name: jsonObj.symbolName,
                length: jsonObj.symbolLength,
                kind: jsonObj.kind,
                type: jsonObj.type,
                isDefinition: jsonObj.definition,
                isVirtual: jsonObj.virtual
            };

            const targets = jsonObj.targets;
            if (targets && (targets.length !== 0) && ((targets.length !== 1) || (targets[0] !== null)))
            {
                symbolInfo.targets = [];
                for (const target of targets)
                {
                    const targetInfo: SymbolInfoBase =
                    {
                        location: target.location,
                        name: target.symbolName ? target.symbolName : "",
                        length: target.symbolLength ? target.symbolLength : 0,
                        kind: target.kind ? target.kind : "",
                        type: target.type,
                        isDefinition: target.definition,
                        isVirtual: target.virtual
                    };
                    symbolInfo.targets.push(targetInfo);
                }
            }

            return symbolInfo;
        };

    return runRc(args, processCallback);
}
