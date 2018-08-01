'use strict';

import { commands, languages, window, DocumentFilter, Location, Position, Range, TextDocument, TextDocumentShowOptions,
         Uri } from 'vscode';

export type Nullable<T> = T | null;
export type Optional<T> = T | undefined;

export interface Locatable
{
    location: Location;
}

export const SourceFileSelector: DocumentFilter[] =
[
    { language: "cpp", scheme: "file" },
    { language: "c",   scheme: "file" }
];

export function isSourceFile(document: TextDocument) : boolean
{
    return (languages.match(SourceFileSelector, document) > 0);
}

export function isUnsavedSourceFile(document: TextDocument) : boolean
{
    if (!document.isDirty)
    {
        return false;
    }
    return isSourceFile(document);
}

export function setContext(name: any, value: any) : void
{
    commands.executeCommand("setContext", name, value);
}

export function showReferences(uri: Uri, position: Position, locations: Location[]) : void
{
    commands.executeCommand("editor.action.showReferences", uri, position, locations);
}

export function fromRtagsLocation(location: string) : Location
{
    const [file, line, col] = location.split(':');
    const position = new Position(parseInt(line) - 1, parseInt(col) - 1);
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
