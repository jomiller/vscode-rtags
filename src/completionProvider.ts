'use strict';

import { languages, workspace, CancellationToken, CompletionItemKind, CompletionItem, CompletionItemProvider,
         CompletionList, Disposable, ParameterInformation, Position, ProviderResult, Range, SignatureHelp,
         SignatureHelpProvider, SignatureInformation, SnippetString, TextDocument } from 'vscode';

import { RtagsManager, runRc } from './rtagsManager';

import { Optional, SourceFileSelector, toRtagsLocation, parseJson } from './rtagsUtil';

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
    constructor(rtagsMgr: RtagsManager)
    {
        this.rtagsMgr = rtagsMgr;

        const config = workspace.getConfiguration("rtags");
        const enableCodeCompletion = config.get<boolean>("enableCodeCompletion", false);
        if (!enableCodeCompletion)
        {
            return;
        }

        this.disposables.push(
            languages.registerCompletionItemProvider(SourceFileSelector, this, '.', ':', '>'),
            languages.registerSignatureHelpProvider(SourceFileSelector, this, '(', ','));
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
        if (!this.rtagsMgr.isInProject(document.uri))
        {
            return [];
        }

        const config = workspace.getConfiguration("rtags", document.uri);
        const maxCompletionResults = config.get<number>("maxCodeCompletionResults", 20);
        const location = toRtagsLocation(document.uri, position);

        const args =
        [
            "--json",
            "--synchronous-completions",
            "--max",
            maxCompletionResults.toString(),
            "--code-complete-at",
            location
        ];

        const wordRange = document.getWordRangeAtPosition(position);
        if (wordRange)
        {
            const range = new Range(wordRange.start, position);
            const prefix = document.getText(range);
            args.push("--code-complete-prefix", prefix);
        }

        const processCallback =
            (output: string) : Optional<CompletionList> =>
            {
                const jsonObj = parseJson(output);
                if (!jsonObj || !jsonObj.completions)
                {
                    return undefined;
                }

                let completionItems: CompletionItem[] = [];

                for (const c of jsonObj.completions)
                {
                    try
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
                    }
                    catch (_err)
                    {
                    }

                    if (completionItems.length === maxCompletionResults)
                    {
                        break;
                    }
                }

                return new CompletionList(completionItems, completionItems.length >= maxCompletionResults);
            };

        return runRc(args, processCallback, [document]);
    }

    public provideSignatureHelp(document: TextDocument, position: Position, _token: CancellationToken) :
        ProviderResult<SignatureHelp>
    {
        if (!this.rtagsMgr.isInProject(document.uri))
        {
            return undefined;
        }

        const config = workspace.getConfiguration("rtags", document.uri);
        const maxCompletionResults = config.get<number>("maxCodeCompletionResults", 20);
        const location = toRtagsLocation(document.uri, position);

        const args =
        [
            "--json",
            "--synchronous-completions",
            "--max",
            maxCompletionResults.toString(),
            "--code-complete-at",
            location
        ];

        const wordRange = document.getWordRangeAtPosition(position, /\b\w+\(.*/);
        let incompleteSignature = "";
        if (wordRange)
        {
            const range = new Range(wordRange.start, position);
            incompleteSignature = document.getText(range);
        }

        let activeParamCount = 1;
        if (incompleteSignature)
        {
            activeParamCount = incompleteSignature.trim().split(',').length;
        }

        const processCallback =
            (output: string) : Optional<SignatureHelp> =>
            {
                const jsonObj = parseJson(output);
                if (!jsonObj || !jsonObj.completions)
                {
                    return undefined;
                }

                let signatures: SignatureInformation[] = [];
                let activeSigIndex = -1;

                for (const c of jsonObj.completions)
                {
                    try
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

                        if (signatureInfo.parameters.length >= activeParamCount)
                        {
                            signatures.push(signatureInfo);

                            // Select the signature with the fewest parameters
                            if ((activeSigIndex === -1) ||
                                (signatureInfo.parameters.length < signatures[activeSigIndex].parameters.length))
                            {
                                activeSigIndex = signatures.length - 1;
                            }
                        }
                    }
                    catch (_err)
                    {
                    }

                    if (signatures.length === maxCompletionResults)
                    {
                        break;
                    }
                }

                const signatureHelp: SignatureHelp =
                {
                    signatures: signatures,
                    activeSignature: Math.max(activeSigIndex, 0),
                    activeParameter: activeParamCount - 1
                };

                return signatureHelp;
            };

        return runRc(args, processCallback, [document]);
    }

    private rtagsMgr: RtagsManager;
    private disposables: Disposable[] = [];
}
