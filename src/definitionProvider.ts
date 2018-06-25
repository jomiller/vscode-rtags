'use strict';

import { languages, window, workspace, CancellationToken, Definition, DefinitionProvider, Disposable, Location,
         Position, ProviderResult, ReferenceContext, TextDocument, TypeDefinitionProvider, ImplementationProvider,
         Range, ReferenceProvider, RenameProvider, WorkspaceEdit } from 'vscode';

import { RtagsSelector, fromRtagsLocation, toRtagsLocation, runRc } from './rtagsUtil';

enum ReferenceType
{
    Definition,
    Virtuals,
    References,
    Rename
}

function getDefinitions(document: TextDocument, position: Position, type: number = ReferenceType.Definition) :
    Thenable<Location[]>
{
    const location = toRtagsLocation(document.uri, position);

    let args = ["--absolute-path"];

    switch (type)
    {
        case ReferenceType.Definition:
            args.push("--follow-location", location);
            break;

        case ReferenceType.Virtuals:
            args.push("--find-virtuals", "--references", location);
            break;

        case ReferenceType.References:
            args.push("--references", location);
            break;

        case ReferenceType.Rename:
            args.push("--rename", "--all-references", "--references", location);
            break;
    }

    let process =
        (output: string) : Location[] =>
        {
            let result: Location[] = [];
            try
            {
                for (let line of output.toString().split("\n"))
                {
                    if (!line)
                    {
                        continue;
                    }
                    let [location] = line.split("\t", 1);
                    result.push(fromRtagsLocation(location));
                }
            }
            catch (_err)
            {
                return result;
            }

            return result;
        };

    return runRc(args, process, document);
}

export class RtagsDefinitionProvider implements
    DefinitionProvider,
    TypeDefinitionProvider,
    ImplementationProvider,
    ReferenceProvider,
    RenameProvider,
    Disposable
{
    constructor()
    {
        this.disposables.push(
            languages.registerDefinitionProvider(RtagsSelector, this),
            languages.registerTypeDefinitionProvider(RtagsSelector, this),
            languages.registerImplementationProvider(RtagsSelector, this),
            languages.registerReferenceProvider(RtagsSelector, this),
            languages.registerRenameProvider(RtagsSelector, this));
    }

    dispose() : void
    {
        for (let d of this.disposables)
        {
            d.dispose();
        }
    }

    provideDefinition(document: TextDocument, position: Position, _token: CancellationToken) :
        ProviderResult<Definition>
    {
        return getDefinitions(document, position);
    }

    provideTypeDefinition(document: TextDocument, position: Position, _token: CancellationToken) :
        ProviderResult<Definition>
    {
        return getDefinitions(document, position, ReferenceType.Virtuals);
    }

    provideImplementation(document: TextDocument, position: Position, _token: CancellationToken) :
        ProviderResult<Definition>
    {
        return getDefinitions(document, position);
    }

    provideReferences(document: TextDocument,
                    position: Position,
                    _context: ReferenceContext,
                    _token: CancellationToken) :
        ProviderResult<Location[]>
    {
        return getDefinitions(document, position, ReferenceType.References);
    }

    provideRenameEdits(document: TextDocument, position: Position, newName: string, _token: CancellationToken) :
        ProviderResult<WorkspaceEdit>
    {
        for (let doc of workspace.textDocuments)
        {
            if (((doc.languageId === "cpp") || (doc.languageId === "c")) && doc.isDirty)
            {
                window.showInformationMessage("Save all source files first before renaming");
                return null;
            }
        }

        let wr = document.getWordRangeAtPosition(position);
        let diff = wr ? (wr.end.character - wr.start.character) : undefined;

        let edits: WorkspaceEdit = new WorkspaceEdit;

        let resolve =
            (results: Location[]) : WorkspaceEdit =>
            {
                for (let r of results)
                {
                    let end = r.range.end.translate(0, diff);
                    edits.replace(r.uri, new Range(r.range.start, end), newName);
                }
                return edits;
            };

        return getDefinitions(document, position, ReferenceType.Rename).then(resolve);
    }

    private disposables: Disposable[] = [];
}
