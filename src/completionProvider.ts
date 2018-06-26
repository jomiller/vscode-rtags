'use strict';

import { languages, CancellationToken, CompletionItemKind, CompletionItem, CompletionItemProvider, CompletionList,
         Disposable, Position, ProviderResult, Range, SignatureHelp, SignatureHelpProvider, SignatureInformation,
         SnippetString, TextDocument } from 'vscode';

import { RtagsSelector, toRtagsLocation, runRc } from './rtagsUtil';

function toCompletionItemKind(kind: string) : CompletionItemKind
{
    switch (kind)
    {
        case "Namespace":
            return CompletionItemKind.Module;

        case "EnumDecl":
            return CompletionItemKind.Enum;

        case "EnumConstantDecl":
            return CompletionItemKind.EnumMember;

        case "ClassDecl":
        case "StructDecl":
            return CompletionItemKind.Class;

        case "CXXConstructor":
            return CompletionItemKind.Constructor;

        case "CXXDestructor":
            return CompletionItemKind.Constructor;

        case "CXXMethod":
            return CompletionItemKind.Method;

        case "FunctionDecl":
            return CompletionItemKind.Function;

        case "FieldDecl":
            return CompletionItemKind.Field;

        case "ParmDecl":
            return CompletionItemKind.Variable;

        case "VarDecl":
            return CompletionItemKind.Variable;
    }

    return CompletionItemKind.Keyword;
}

export class RtagsCompletionProvider implements
    CompletionItemProvider,
    SignatureHelpProvider,
    Disposable
{
    constructor()
    {
        this.disposables.push(
            languages.registerCompletionItemProvider(RtagsSelector, this, '.', ':', '>'),
            languages.registerSignatureHelpProvider(RtagsSelector, this, '(', ','));
    }

    dispose() : void
    {
        for (let d of this.disposables)
        {
            d.dispose();
        }
    }

    provideCompletionItems(document: TextDocument, position: Position, _token: CancellationToken) :
        ProviderResult<CompletionItem[] | CompletionList>
    {
        const wordRange = document.getWordRangeAtPosition(position);
        const range = wordRange ? new Range(wordRange.start, position) : null;
        const maxCompletions = 20;
        const location = toRtagsLocation(document.uri, position);

        let args =
        [
            "--json",
            "--synchronous-completions",
            "--max",
            maxCompletions.toString(),
            "--code-complete-at",
            location
        ];

        if (range)
        {
           const prefix = document.getText(range);
           args.push("--code-complete-prefix", prefix);
        }

        let process =
            (output: string) : CompletionList =>
            {
                const o = JSON.parse(output);
                let result: CompletionItem[] = [];
                for (let c of o.completions)
                {
                    let sortText: string = ("00" + c.priority.toString()).slice(-2);
                    let kind = toCompletionItemKind(c.kind);
                    let insert = new SnippetString();
                    switch (kind)
                    {
                        case CompletionItemKind.Method:
                        case CompletionItemKind.Function:
                            insert = new SnippetString(c.completion + "($1)");
                            break;

                        default:
                            insert = new SnippetString(c.completion);
                            break;
                    }

                    let item: CompletionItem =
                    {
                        label: c.completion,
                        kind: kind,
                        detail:  c.signature,
                        sortText: sortText,
                        insertText: insert
                    };
                    result.push(item);

                    if (result.length === maxCompletions)
                    {
                        break;
                    }
                }
                return new CompletionList(result, result.length >= maxCompletions);
            };

        return runRc(args, process, document);
    }

    provideSignatureHelp(document: TextDocument, position: Position, _token: CancellationToken) :
        ProviderResult<SignatureHelp>
    {
        const maxCompletions = 20;
        const location = toRtagsLocation(document.uri, position);

        let args =
        [
            "--json",
            "--synchronous-completions",
            "--max",
            maxCompletions.toString(),
            "--code-complete-at",
            location
        ];

        let process =
            (output: string) : SignatureHelp =>
            {
                const o = JSON.parse(output);
                let result: SignatureInformation[] = [];

                for (let s of o.signatures)
                {
                    let signatureInfo: SignatureInformation =
                    {
                        label: "test",
                        parameters: s.parameters
                    };
                    result.push(signatureInfo);
                }

                // FIXME: result not used
                let signatureHelp: SignatureHelp =
                {
                    signatures: o.signatures,
                    activeSignature: 0,
                    activeParameter: o.activeParameter
                };
                return signatureHelp;
            };

        return runRc(args, process, document);
    }

    private disposables: Disposable[] = [];
}
