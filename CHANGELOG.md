# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/).

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
- Renamed all configuration settings using dot separators.

### Removed
- Information message shown when a project was enqueued for loading/reindexing.

### Fixed
- [Issue #6](https://github.com/jomiller/vscode-rtags/issues/6): Diagnostic child process tries to connect to rdm before rdm is ready.
- Remaining entries in the project indexing queue were not processed if the current entry failed to be loaded/reindexed.
- Files were potentially identified as belonging to the wrong project when multiple project directory names started with the same string.
- When folders were removed from the workspace, the corresponding projects were not removed from the indexing queue.

## [0.2.0] - 2018-08-03

### Added
- `Reindex Workspace` command to reindex all workspace folders.

### Changed
- Renamed `Freshen Index` command to `Reindex Active Workspace Folder`.
- Workspace symbol provider searches all workspace folders instead of only the active folder.

### Fixed
- Exception was thrown from hover provider when `rc --follow-location` returned no results.
- `Show Callers` results were truncated when any caller had no containing function.
- `Show Callers` returned results for symbols that were not functions.

## 0.1.0 - 2018-07-18

Initial release

[0.3.1]: https://github.com/jomiller/vscode-rtags/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/jomiller/vscode-rtags/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jomiller/vscode-rtags/compare/v0.1.0...v0.2.0
