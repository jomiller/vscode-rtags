/*
 * This file is part of RTags Client for Visual Studio Code.
 *
 * Copyright (c) yorver
 * Copyright (c) 2018 Jonathan Miller
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

'use strict';

import { languages, workspace, CancellationToken, CompletionItemKind, CompletionItem, CompletionItemProvider,
         CompletionList, Disposable, ParameterInformation, Position, ProviderResult, Range, SignatureHelp,
         SignatureHelpProvider, SignatureInformation, TextDocument } from 'vscode';

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
        const completionEnabled = config.get<boolean>("completion.enabled", true);
        if (!completionEnabled)
        {
            return;
        }

        this.disposables.push(
            languages.registerCompletionItemProvider(SourceFileSelector, this, '.', ':', '>'),
            languages.registerSignatureHelpProvider(SourceFileSelector, this, '(', ','));
    }

    public dispose() : void
    {
        this.disposables.forEach((d) => { d.dispose(); });
    }

    public provideCompletionItems(document: TextDocument, position: Position, _token: CancellationToken) :
        ProviderResult<CompletionItem[] | CompletionList>
    {
        if (!this.rtagsMgr.isInProject(document.uri))
        {
            return [];
        }

        const config = workspace.getConfiguration("rtags", document.uri);
        const maxCompletionResults = config.get<number>("completion.maxResults", 20);
        const location = toRtagsLocation(document.uri, position);

        let args =
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

                let maxPriority = 0;
                for (const c of jsonObj.completions)
                {
                    if (c.priority > maxPriority)
                    {
                        maxPriority = c.priority;
                    }
                }
                const numPriorityDigits = maxPriority.toString().length;

                for (const c of jsonObj.completions)
                {
                    try
                    {
                        const item: CompletionItem =
                        {
                            label: c.completion,
                            kind: toCompletionItemKind(c.kind),
                            detail: c.signature,
                            sortText: c.priority.toString().padStart(numPriorityDigits, "0"),
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
        const maxCompletionResults = config.get<number>("completion.maxResults", 20);
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

        interface ParenthesizedRange
        {
            start: number;
            end: number;
        }

        // Find the number of active parameters in the signature being completed that are not part of nested signatures

        const text = document.getText(new Range(new Position(0, 0), position));
        let commaPositions: number[] = [];
        let closeParenPositions: number[] = [];
        let parenRanges: ParenthesizedRange[] = [];
        for (let pos: number = text.length - 1; pos >= 0; --pos)
        {
            if (text.charAt(pos) === ',')
            {
                commaPositions.push(pos);
            }
            else if (text.charAt(pos) === ')')
            {
                closeParenPositions.push(pos);
            }
            else if (text.charAt(pos) === '(')
            {
                const closeParenPos = closeParenPositions.pop();
                if (closeParenPos)
                {
                    // Add a parenthesized range for a nested signature
                    parenRanges.push({start: pos, end: closeParenPos });
                }
                else
                {
                    // This is the opening parenthesis for the signature being completed
                    break;
                }
            }
        }

        // Filter out the commas that are part of nested signatures
        commaPositions = commaPositions.filter(
            (pos) => { return !parenRanges.some((r) => { return ((pos > r.start) && (pos < r.end)); }); });

        const activeParamCount = commaPositions.length + 1;

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
