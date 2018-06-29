'use strict';

import { languages, window, workspace, CancellationToken, Definition, DefinitionProvider, Disposable, Hover, HoverProvider, Location,
         Position, ProviderResult, ReferenceContext, TextDocument, TypeDefinitionProvider, ImplementationProvider,
         Range, ReferenceProvider, RenameProvider, WorkspaceEdit } from 'vscode';

import { Nullable, RtagsSelector, fromRtagsLocation, toRtagsLocation, runRc } from './rtagsUtil';

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

    let args = ["--absolute-path", "--no-context"];

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

    const processCallback =
        (output: string) : Location[] =>
        {
            let locations: Location[] = [];
            try
            {
                for (const loc of output.split("\n"))
                {
                    if (!loc)
                    {
                        continue;
                    }
                    locations.push(fromRtagsLocation(loc));
                }
            }
            catch (_err)
            {
            }
            return locations;
        };

    return runRc(args, processCallback, document);
}

export class RtagsDefinitionProvider implements
    DefinitionProvider,
    TypeDefinitionProvider,
    ImplementationProvider,
    ReferenceProvider,
    RenameProvider,
    HoverProvider,
    Disposable
{
    constructor()
    {
        this.disposables.push(
            languages.registerDefinitionProvider(RtagsSelector, this),
            languages.registerTypeDefinitionProvider(RtagsSelector, this),
            languages.registerImplementationProvider(RtagsSelector, this),
            languages.registerReferenceProvider(RtagsSelector, this),
            languages.registerRenameProvider(RtagsSelector, this),
            languages.registerHoverProvider(RtagsSelector, this));
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
        for (const doc of workspace.textDocuments)
        {
            if (((doc.languageId === "cpp") || (doc.languageId === "c")) && doc.isDirty)
            {
                window.showInformationMessage("Save all source files first before renaming");
                return null;
            }
        }

        const wr = document.getWordRangeAtPosition(position);
        const diff = wr ? (wr.end.character - wr.start.character) : undefined;

        let edits: WorkspaceEdit = new WorkspaceEdit;

        const resolveCallback =
            (locations: Location[]) : WorkspaceEdit =>
            {
                for (const l of locations)
                {
                    const end = l.range.end.translate(0, diff);
                    edits.replace(l.uri, new Range(l.range.start, end), newName);
                }
                return edits;
            };

        return getDefinitions(document, position, ReferenceType.Rename).then(resolveCallback);
    }

    provideHover(document: TextDocument, position: Position, _token: CancellationToken) : ProviderResult<Hover>
    {
        const location = toRtagsLocation(document.uri, position);

        const args =
        [
            "--absolute-path",
            "--follow-location",
            location
        ];

        const processCallback =
            (output: string) : string =>
            {
                let definition: string = "";
                try
                {
                    let _unused: string = "";
                    [_unused, definition] = output.split("\t", 2).map((token) => { return token.trim(); });
                }
                catch (_err)
                {
                }
                return definition;
            };

            const resolveCallback =
                (definition: string) : Nullable<Hover> =>
                {
                    // Hover text is not formatted properly unless a tab or 4 spaces are prepended
                    return ((definition.length !== 0) ? new Hover('\t' + definition) : null);
                };

        return runRc(args, processCallback, document).then(resolveCallback);
    }

    private disposables: Disposable[] = [];
}
