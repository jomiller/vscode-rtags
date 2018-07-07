'use strict';

import { languages, CancellationToken, CompletionItemKind, CompletionItem, CompletionItemProvider, CompletionList,
         Disposable, ParameterInformation, Position, ProviderResult, Range, SignatureHelp, SignatureHelpProvider,
         SignatureInformation, SnippetString, TextDocument } from 'vscode';

import { ProjectManager } from './projectManager';

import { RtagsDocSelector, toRtagsLocation, runRc } from './rtagsUtil';

function toCompletionItemKind(kind: string) : CompletionItemKind
{
    switch (kind)
    {
        case "Namespace":
            return CompletionItemKind.Module;

        case "ClassDecl":
        case "StructDecl":
        case "UnionDecl":
            return CompletionItemKind.Class;

        case "EnumDecl":
            return CompletionItemKind.Enum;

        case "EnumConstantDecl":
            return CompletionItemKind.EnumMember;

        case "TemplateTypeParameter":
            return CompletionItemKind.TypeParameter;

        case "CXXConstructor":
        case "CXXDestructor":
            return CompletionItemKind.Constructor;

        case "CXXMethod":
            return CompletionItemKind.Method;

        case "FunctionDecl":
            return CompletionItemKind.Function;

        case "FieldDecl":
            return CompletionItemKind.Field;

        case "ParmDecl":
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
    constructor(projectMgr: ProjectManager)
    {
        this.projectMgr = projectMgr;

        this.disposables.push(
            languages.registerCompletionItemProvider(RtagsDocSelector, this, '.', ':', '>'),
            languages.registerSignatureHelpProvider(RtagsDocSelector, this, '(', ','));
    }

    public dispose() : void
    {
        for (let d of this.disposables)
        {
            d.dispose();
        }
    }

    public provideCompletionItems(document: TextDocument, position: Position, _token: CancellationToken) :
        ProviderResult<CompletionItem[] | CompletionList>
    {
        if (!this.projectMgr.isInProject(document.uri))
        {
            return [];
        }

        const wordRange = document.getWordRangeAtPosition(position);
        const range = wordRange ? new Range(wordRange.start, position) : null;
        const maxCompletions = 20;
        const location = toRtagsLocation(document.uri, position);

        const args =
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

        const processCallback =
            (output: string) : CompletionList =>
            {
                let completionItems: CompletionItem[] = [];

                try
                {
                    const jsonObj = JSON.parse(output);
                    for (const c of jsonObj.completions)
                    {
                        const sortText: string = ("00" + c.priority.toString()).slice(-2);
                        const kind = toCompletionItemKind(c.kind);
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

                        const item: CompletionItem =
                        {
                            label: c.completion,
                            kind: kind,
                            detail: c.signature,
                            sortText: sortText,
                            insertText: insert
                        };
                        completionItems.push(item);

                        if (completionItems.length === maxCompletions)
                        {
                            break;
                        }
                    }
                }
                catch (_err)
                {
                }

                return new CompletionList(completionItems, completionItems.length >= maxCompletions);
            };

        return runRc(args, processCallback);
    }

    public provideSignatureHelp(document: TextDocument, position: Position, _token: CancellationToken) :
        ProviderResult<SignatureHelp>
    {
        if (!this.projectMgr.isInProject(document.uri))
        {
            return null;
        }

        const maxCompletions = 20;
        const location = toRtagsLocation(document.uri, position);

        const args =
        [
            "--json",
            "--synchronous-completions",
            "--max",
            maxCompletions.toString(),
            "--code-complete-at",
            location
        ];

        const processCallback =
            (output: string) : SignatureHelp =>
            {
                let signatures: SignatureInformation[] = [];

                try
                {
                    const jsonObj = JSON.parse(output);
                    for (const c of jsonObj.completions)
                    {
                        if (c.kind !== "OverloadCandidate")
                        {
                            break;
                        }

                        let parameters: ParameterInformation[] = [];
                        const parameterSignature = (/\((.*)\)$/).exec(c.signature);
                        if (parameterSignature)
                        {
                            parameters = parameterSignature[1].split(',').map(
                                (param) => { return new ParameterInformation(param.trim()); });
                        }

                        const signatureInfo: SignatureInformation =
                        {
                            label: c.signature,
                            parameters: parameters
                        };
                        signatures.push(signatureInfo);

                        if (signatures.length === maxCompletions)
                        {
                            break;
                        }
                    }
                }
                catch (_err)
                {
                }

                const signatureHelp: SignatureHelp =
                {
                    signatures: signatures,
                    activeSignature: 0,
                    activeParameter: 0
                };

                return signatureHelp;
            };

        return runRc(args, processCallback);
    }

    private projectMgr: ProjectManager;
    private disposables: Disposable[] = [];
}
