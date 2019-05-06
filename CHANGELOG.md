# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.5.2] - 2019-04-11

### Added
- Add `rtags.misc.compilationDatabaseRecursiveSearch` configuration setting for finding all compilation databases, recursively, in the specified compilation database directory.

### Changed
- Update the recommended RTags version to v2.22 or later.

### Fixed
- Fix issue [#28](https://github.com/jomiller/vscode-rtags/issues/28): Support multiple `compile_commands.json` file entries in `rtags.misc.compilationDatabaseDirectory`.
- A message prompting to reload the window was shown when the value of the `rtags.misc.compilationDatabaseDirectory` setting changed but still resolved to the same absolute path (without following symbolic links).

## [0.5.0] - 2019-03-02

### Added
- Add `Go to Declaration` and `Peek Declaration` commands for finding declarations separately from definitions.
- Validate the currently installed RTags version against the minimum version required by the extension.
- Show the recommended RTags version after the extension has been upgraded.
- Validate the associated compilation database when opening a workspace folder.

### Changed
- Update the minimum VS Code version to 1.30.0.
- Allow multiple workspace folders to be loaded or reindexed concurrently.
- When loading a new compilation database for a given workspace folder, prompt the user before deleting the current compilation database.

### Removed
- Remove support for nested project roots (as RTags does not support them well).

### Fixed
- Fix issue [#26](https://github.com/jomiller/vscode-rtags/issues/26): Renaming class name removes '~' in destructor.
- Fix issue [#27](https://github.com/jomiller/vscode-rtags/issues/27): Setting `rtags.misc.compilationDatabaseDirectory` does not support relative paths.
- `rc` always followed symbolic links regardless of whether `rdm` was configured to follow symbolic links (as determined by the `--no-realpath` option).
- A message prompting to reload the window was erroneously shown when a workspace folder was closed.

## [0.4.3] - 2018-12-30

### Changed
- Display `Reindex Active Workspace Folder` command only when the workspace contains multiple folders.
- Reload a project when the corresponding workspace folder is opened, and the project is already known to RTags, but is no longer indexed (because `compile_commands.json` was deleted and later recreated).
- Restart the `rdm` process if it was killed, and initially auto-launched.

### Fixed
- Macro expansions and definitions of variables of constructible types were highlighted incorrectly under certain circumstances.
- When the value of the `rtags.misc.compilationDatabaseDirectory` setting changed, the new compilation database was never loaded if the `Reload Now` button in the `Settings` editor was not clicked.
- The diagnostics child process was not restarted if it was killed via `SIGTERM`.

## [0.4.2] - 2018-12-13

### Added
- Add support for highlighting all occurrences of a symbol within a document.
- Add `rtags.highlighting.enabled` configuration setting for enabling symbol highlighting (default: `false`).
- Add `rtags.codeActions.enabled` configuration setting for enabling code actions (default: `true`).

### Changed
- Improve accuracy and speed of `Go to Type Definition` and `Show Variables` commands when invoked for type symbols.

### Fixed
- Further improve the fix for issue [#21](https://github.com/jomiller/vscode-rtags/issues/21).
- Mitigate issue [#3](https://github.com/jomiller/vscode-rtags/issues/3) by adding timeouts to the most frequently invoked queries.
- Symbol searches did not return results for macro definitions, namespace aliases, or conversion operators.
- `Go to Type Definition` command did not return results for using declarations, enum constants, conversion operators, or template type parameters.

## [0.4.1] - 2018-12-02

### Changed
- `Go to Implementation` command (`Ctrl+F12`) shows derived classes when invoked for base classes, and virtual method definitions when invoked for virtual methods.
- Rename `Show Virtuals` command to `Show Derived/Virtuals`, and make it invoke the `Go to Implementation` command.
- Include the declaration and definition in the results for the `Find All References` command.
- Support renaming symbols in workspace folders with unsaved files.
- Clarify the title text for fix-it hints.
- Reduce the debouncing timeout to 500 ms for reindexing changed files.

### Fixed
- Fix issue [#19](https://github.com/jomiller/vscode-rtags/issues/19): event-stream NPM package security issue.
- Fix issue [#15](https://github.com/jomiller/vscode-rtags/issues/15): Unsaved changes to other files are lost when re-saving a file that has no unsaved changes.
- Make the fix for issue [#21](https://github.com/jomiller/vscode-rtags/issues/21) more robust.
- Fix-it hints could be displayed in contexts intended only for code actions other than quick fix actions.
- Code completion was triggered on `>` and `:` even when those characters were not part of complete operators.

## [0.4.0] - 2018-11-16

### Added
- Add `rtags.diagnostics.openFilesOnly` configuration setting for reporting diagnostics only for open files.

### Changed
- Enable code completion by default (`rtags.completion.enabled` setting is set to `true`).
- Report diagnostics only for open files by default (`rtags.diagnostics.openFilesOnly` setting is set to `true`).
- Improve the results for `Go to Type Definition`, `Show Variables` and `Show Callers` commands.
- Include file symbols in workspace symbol search results.

### Removed
- Remove `Show Variables` command from the context menu for C source files.

### Fixed
- Fix issue [#1](https://github.com/jomiller/vscode-rtags/issues/1): Signature help did not work when function arguments contained nested signatures.
- Fix issue [#21](https://github.com/jomiller/vscode-rtags/issues/21): Saving a file may trigger false positive diagnostic messages in other unsaved files.
- Workspace symbol search only matched the pattern against the beginning of symbol names.
- Symbol searches did not return results for class/function templates or type aliases.
- Warning and information diagnostic messages were treated as errors.
- Diagnostic messages were lost from the `Problems` panel if the diagnostic process was terminated unexpectedly.
- Other VS Code tasks could become blocked while the connection between `rc` and `rdm` was being tested, if `rdm` was slow to respond.
- When multiple source files were edited in quick succession without being saved, then only the last edited file was reindexed.

## [0.3.2] - 2018-10-21

### Added
- Add support for C source files to `Call Hierarchy`, `Show Variables` and `Show Callers` commands.

### Changed
- If `--job-count` is not present in the `rdm.arguments` setting, then set it to 50% of the logical CPU cores.

### Fixed
- Show an error message if the auto-launched `rdm` process exited immediately due to an error.

## [0.3.1] - 2018-08-14

### Fixed
- Fix GNU GPL v3.0 licensing information.
- `Show Callers`, `Show Base`, `Show Variables` and `Show Virtuals` commands did not provide user feedback in certain cases when they returned no results.
- Hover information was incomplete when the context field in the results of the `rc --follow-location` command contained tabs.
- Hover information, inheritance hierarchy and symbol search results were incorrect or missing when the results of `rc` commands contained multiple tabs between fields.

## [0.3.0] - 2018-08-11

### Added
- Add `rtags.misc.compilationDatabaseDirectory` configuration setting for specifying the compilation database directory to use instead of the workspace root.
- Load the new compilation database when the `rtags.misc.compilationDatabaseDirectory` setting changes and the window is reloaded to apply the new configuration.

### Changed
- Rename all configuration settings using dot separators.

### Removed
- Remove information message shown when a project was enqueued for loading/reindexing.

### Fixed
- Fix issue [#6](https://github.com/jomiller/vscode-rtags/issues/6): Diagnostic child process tries to connect to rdm before rdm is ready.
- Remaining entries in the project indexing queue were not processed if the current entry failed to be loaded/reindexed.
- Files were potentially identified as belonging to the wrong project when multiple project directory names started with the same string.
- When folders were removed from the workspace, the corresponding projects were not removed from the indexing queue.

## [0.2.0] - 2018-08-03

### Added
- Add `Reindex Workspace` command to reindex all workspace folders.

### Changed
- Rename `Freshen Index` command to `Reindex Active Workspace Folder`.
- Workspace symbol provider searches all workspace folders instead of only the active folder.

### Fixed
- Exception was thrown from hover provider when `rc --follow-location` returned no results.
- `Show Callers` results were truncated when any caller had no containing function.
- `Show Callers` returned results for symbols that were not functions.

## 0.1.0 - 2018-07-18

Initial release

[0.5.2]: https://github.com/jomiller/vscode-rtags/compare/v0.5.0...v0.5.2
[0.5.0]: https://github.com/jomiller/vscode-rtags/compare/v0.4.3...v0.5.0
[0.4.3]: https://github.com/jomiller/vscode-rtags/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/jomiller/vscode-rtags/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/jomiller/vscode-rtags/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/jomiller/vscode-rtags/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/jomiller/vscode-rtags/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/jomiller/vscode-rtags/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/jomiller/vscode-rtags/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jomiller/vscode-rtags/compare/v0.1.0...v0.2.0
