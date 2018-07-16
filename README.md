# RTags Client

[RTags](https://github.com/Andersbakken/rtags) is a client/server application that indexes C/C++ code and keeps a persistent file-based database of references, declarations, definitions, symbol names, etc.

This extension allows the RTags client to be used directly from within Visual Studio Code.

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

The commands are available through both the editor context menu and the command palette (Shift+Ctrl+P).

### Configuration Settings

`rtags.rcExecutable`: Path to the `rc` executable (default assumes the executable is in the `PATH`).

`rtags.autoLaunchRdm`: If true, `rdm` will be launched automatically, if it is not already running.

`rtags.rdmExecutable`: Path to the `rdm` executable (default assumes the executable is in the `PATH`).

`rtags.rdmArguments`: Array containing arguments to pass to the `rdm` executable, if it is launched automatically.

`rtags.enableDiagnostics`: If true, diagnostics and fix-its will be enabled.

`rtags.enableCodeCompletion`: If true, code completion will be enabled.

`rtags.maxCodeCompletionResults`: Maximum number of code completion results to report.

`rtags.maxWorkspaceSearchResults`: Maximum number of global search (i.e., Ctrl+T + #foo) results to report.

## Requirements

To use this extension you need to install [RTags](https://github.com/Andersbakken/rtags).

You may optionally start the RTags server:

    rdm --daemon
