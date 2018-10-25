# RTags Client for Visual Studio Code

[RTags](https://github.com/Andersbakken/rtags) is a client/server application that indexes C/C++ code and keeps a persistent file-based database of references, declarations, definitions, symbol names, etc.

This extension allows the RTags client to be used from within Visual Studio Code.

This extension was originally forked from https://github.com/yorver/rtags-vscode.

## Features

* Go to Definition/Declaration
* Find References
* Call Hierarchy, Inheritance Hierarchy
* Hover Information
* Diagnostics (Error Squiggles)
* Code Actions (Fix-It Hints)
* Code Completion
* Signature Help
* Symbol Searching
* Symbol Renaming

## Usage

The extension will become active when you open a folder or workspace that contains a compilation database file called `compile_commands.json`. The compilation database will be loaded into RTags, if it is not already loaded.

Multi-root workspaces are supported.

The commands are available through both the editor context menu and the command palette (Ctrl+Shift+P).

### Configuration Settings

`rtags.rc.executable`: Path to the `rc` executable (default assumes the executable is in the `PATH`).

`rtags.rdm.autoLaunch`: If true, `rdm` will be launched automatically, if it is not already running.

`rtags.rdm.executable`: Path to the `rdm` executable (default assumes the executable is in the `PATH`).

`rtags.rdm.arguments`: Array containing arguments to pass to the `rdm` executable, if it is launched automatically. If `-j`/`--job-count` is not present in the array, then `--job-count=max(1, logicalCpuCount / 2)` will be added by default.

`rtags.diagnostics.enabled`: If true, diagnostics and fix-it hints will be enabled.

`rtags.completion.enabled`: If true, code completion will be enabled.

`rtags.completion.maxResults`: Maximum number of code completion results to report.

`rtags.misc.compilationDatabaseDirectory`: If not empty, the compilation database directory to use instead of the workspace root.

`rtags.misc.maxWorkspaceSearchResults`: Maximum number of global search (i.e., Ctrl+T + #foo) results to report.

## Requirements

To use this extension you need to install [RTags](https://github.com/Andersbakken/rtags).

You may optionally start the RTags server:

    rdm --daemon
