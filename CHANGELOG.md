# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/).

## [0.2.0] - 2018-08-03

### Added
- "Reindex Workspace" command to reindex all workspace folders.

### Changed
- Renamed "Freshen Index" command to "Reindex Active Workspace Folder".

### Fixed
- Exception thrown from hover provider when "rc --follow-location" returned no results.
- "Show Callers" results truncated when any caller had no containing function.
- "Show Callers" returning results for symbols that were not functions.

## 0.1.0 - 2018-07-18

Initial release

[0.2.0]: https://github.com/jomiller/vscode-rtags/compare/v0.1.0...v0.2.0
