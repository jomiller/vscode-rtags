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

export const ExtensionId     = "jomiller.rtags-client";
export const ConfigurationId = "rtags";

export enum VsCodeCommands
{
    Open               = "vscode.open",
    ReloadWindow       = "workbench.action.reloadWindow",
    GoToImplementation = "editor.action.goToImplementation",
    ShowReferences     = "editor.action.showReferences",
    SetContext         = "setContext"
}

export enum Views
{
    CallHierarchy        = "rtags.callHierarchy",
    InheritanceHierarchy = "rtags.inheritanceHierarchy"
}

export enum Commands
{
    ReindexActiveFolder       = "rtags.reindexActiveFolder",
    ReindexWorkspace          = "rtags.reindexWorkspace",
    ShowCallers               = "rtags.showCallers",
    ShowVariables             = "rtags.showVariables",
    ShowBase                  = "rtags.showBase",
    ShowDerivedVirtuals       = "rtags.showDerivedVirtuals",
    CallHierarchy             = "rtags.callHierarchy",
    CloseCallHierarchy        = "rtags.closeCallHierarchy",
    InheritanceHierarchy      = "rtags.inheritanceHierarchy",
    CloseInheritanceHierarchy = "rtags.closeInheritanceHierarchy",
    GoToLocation              = "rtags.goToLocation"
}

export enum WindowConfiguration
{
    RcExecutable             = "rc.executable",
    RdmAutoLaunch            = "rdm.autoLaunch",
    RdmExecutable            = "rdm.executable",
    RdmArguments             = "rdm.arguments",
    DiagnosticsEnabled       = "diagnostics.enabled",
    DiagnosticsOpenFilesOnly = "diagnostics.openFilesOnly",
    CodeActionsEnabled       = "codeActions.enabled",
    CompletionEnabled        = "completion.enabled",
    HighlightingEnabled      = "highlighting.enabled"
}

export enum ResourceConfiguration
{
    CompletionMaxResults             = "completion.maxResults",
    MiscCompilationDatabaseDirectory = "misc.compilationDatabaseDirectory",
    MiscMaxWorkspaceSearchResults    = "misc.maxWorkspaceSearchResults"
}

export function makeConfigurationId(name: string) : string
{
    return (ConfigurationId + '.' + name);
}
