# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.4.1] - 2018-12-02

### Changed
- `Go to Implementation` command (`Ctrl+F12`) shows derived classes when invoked for base classes, and virtual method definitions when invoked for virtual methods.
- Rename `Show Virtuals` command to `Show Derived/Virtuals`, and make it invoke the `Go to Implementation` command.
- Include the declaration and definition in the results for the `Find All References` and `List All References` commands.
- Support renaming symbols in workspace folders with unsaved files.
- Clarify the title text for fix-it hints.
- Reduce the debouncing timeout to 500 ms for reindexing changed files.

### Fixed
- Issue #19: event-stream NPM package security issue.
- Issue #15: Unsaved changes to other files are lost when re-saving a file that has no unsaved changes.
- Improve the fix for issue #21.
- Fix-it hints could be displayed in contexts intended only for code actions other than quick fix actions.
- Code completion was triggered on `>` and `:` even when those characters were not part of complete operators.

## [0.4.0] - 2018-11-16

### Added
- `rtags.diagnostics.openFilesOnly` configuration setting for reporting diagnostics only for open files.

### Changed
- Enable code completion by default (`rtags.completion.enabled` setting is set to `true`).
- Report diagnostics only for open files by default (`rtags.diagnostics.openFilesOnly` setting is set to `true`).
- Improve the results for `Go to Type Definition`, `Show Variables` and `Show Callers` commands.
- Include file symbols in workspace symbol search results.

### Removed
- `Show Variables` command from the context menu for C source files.

### Fixed
- Issue #1: Signature help did not work when function arguments contained nested signatures.
- Issue #21: Saving a file may trigger false positive diagnostic messages in other unsaved files.
- Workspace symbol search only matched the pattern against the beginning of symbol names.
- Symbol searches did not return results for class/function templates or type aliases.
- Warning and information diagnostic messages were treated as errors.
- Diagnostic messages were lost from the Problems panel if the diagnostic process was terminated unexpectedly.
- Other VS Code tasks could become blocked while the connection between `rc` and `rdm` was being tested, if `rdm` was slow to respond.
- When multiple source files were edited in quick succession without being saved, then only the last edited file was reindexed.

## [0.3.2] - 2018-10-21

### Added
- Support for C source files to `Call Hierarchy`, `Show Variables` and `Show Callers` commands.

### Changed
- If `--job-count` is not present in the `rdm.arguments` setting, then set it to half the number of logical CPUs available.

### Fixed
- Show an error message if the auto-launched `rdm` process exited immediately due to an error.

## [0.3.1] - 2018-08-14

### Fixed
- GNU GPL v3.0 licensing information.
- `Show Callers`, `Show Base`, `Show Variables` and `Show Virtuals` commands did not provide user feedback in certain cases when they returned no results.
- Incomplete hover information when the context field in the results of the `rc --follow-location` command contained tabs.
- Incorrect/missing hover information, inheritance hierarchy and symbol search results when the results of `rc` commands contained multiple tabs between fields.

## [0.3.0] - 2018-08-11

### Added
- `rtags.misc.compilationDatabaseDirectory` configuration setting for specifying the compilation database directory to use instead of the workspace root.
- Load the new compilation database when the `rtags.misc.compilationDatabaseDirectory` setting changes and the window is reloaded to apply the new configuration.

### Changed
- Rename all configuration settings using dot separators.

### Removed
- Information message shown when a project was enqueued for loading/reindexing.

### Fixed
- Issue #6: Diagnostic child process tries to connect to rdm before rdm is ready.
- Remaining entries in the project indexing queue were not processed if the current entry failed to be loaded/reindexed.
- Files were potentially identified as belonging to the wrong project when multiple project directory names started with the same string.
- When folders were removed from the workspace, the corresponding projects were not removed from the indexing queue.

## [0.2.0] - 2018-08-03

### Added
- `Reindex Workspace` command to reindex all workspace folders.

### Changed
- Rename `Freshen Index` command to `Reindex Active Workspace Folder`.
- Workspace symbol provider searches all workspace folders instead of only the active folder.

### Fixed
- Exception was thrown from hover provider when `rc --follow-location` returned no results.
- `Show Callers` results were truncated when any caller had no containing function.
- `Show Callers` returned results for symbols that were not functions.

## 0.1.0 - 2018-07-18

Initial release

[0.4.1]: https://github.com/jomiller/vscode-rtags/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/jomiller/vscode-rtags/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/jomiller/vscode-rtags/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/jomiller/vscode-rtags/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/jomiller/vscode-rtags/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jomiller/vscode-rtags/compare/v0.1.0...v0.2.0
