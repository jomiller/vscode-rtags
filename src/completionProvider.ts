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

import { languages, workspace, CancellationToken, CompletionContext, CompletionItemKind, CompletionItem,
         CompletionItemProvider, CompletionList, Disposable, ParameterInformation, Position, ProviderResult, Range,
         SignatureHelp, SignatureHelpContext, SignatureHelpProvider, SignatureInformation, TextDocument } from 'vscode';

import { RtagsManager } from './rtagsManager';

import { Optional, SourceFileSelector, toRtagsLocation, parseJson, runRc } from './rtagsUtil';

function toCompletionItemKind(kind: string) : CompletionItemKind
{
    switch (kind)
    {
        case "Namespace":
        case "NamespaceAlias":
            return CompletionItemKind.Module;

        case "ClassDecl":
        case "ClassTemplate":
        case "ClassTemplatePartialSpecialization":
        case "StructDecl":
        case "UnionDecl":
        case "TypedefDecl":
        case "TypeAliasDecl":
        case "TypeAliasTemplateDecl":
            return CompletionItemKind.Class;

        case "EnumDecl":
            return CompletionItemKind.Enum;

        case "EnumConstantDecl":
            return CompletionItemKind.EnumMember;

        case "TemplateTypeParameter":
        case "TemplateTemplateParameter":
            return CompletionItemKind.TypeParameter;

        case "CXXConstructor":
        case "CXXDestructor":
            return CompletionItemKind.Constructor;

        case "CXXMethod":
        case "CXXConversion":
            return CompletionItemKind.Method;

        case "FunctionDecl":
        case "FunctionTemplate":
        case "macro definition":
            return CompletionItemKind.Function;

        case "FieldDecl":
            return CompletionItemKind.Field;

        case "ParmDecl":
        case "VarDecl":
        case "NonTypeTemplateParameter":
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
            languages.registerCompletionItemProvider(SourceFileSelector, this, '.', '>', ':'),
            languages.registerSignatureHelpProvider(SourceFileSelector, this, '(', ','));
    }

    public dispose() : void
    {
        this.disposables.forEach((d) => { d.dispose(); });
    }

    public provideCompletionItems(document: TextDocument,
                                  position: Position,
                                  _token: CancellationToken,
                                  context: CompletionContext) :
        ProviderResult<CompletionItem[] | CompletionList>
    {
        const projectPath = this.rtagsMgr.getProjectPath(document.uri);
        if (!projectPath)
        {
            return undefined;
        }

        // Verify that the trigger character is part of a complete operator
        if ((context.triggerCharacter === '>') || (context.triggerCharacter === ':'))
        {
            if (position.character < 2)
            {
                return undefined;
            }
            const prevCharRange = new Range(position.translate(0, -2), position.translate(0, -1));
            const prevChar = document.getText(prevCharRange);
            if (((context.triggerCharacter === '>') && (prevChar !== '-')) ||
                ((context.triggerCharacter === ':') && (prevChar !== ':')))
            {
                return undefined;
            }
        }

        const config = workspace.getConfiguration("rtags", document.uri);
        const maxCompletionResults = config.get<number>("completion.maxResults", 20);
        const location = toRtagsLocation(document.uri, position);

        let args =
        [
            "--code-complete-at",
            location,
            "--synchronous-completions",
            "--max",
            maxCompletionResults.toString(),
            "--json"
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

        return runRc(args, processCallback, this.rtagsMgr.getUnsavedSourceFiles(projectPath));
    }

    public provideSignatureHelp(document: TextDocument,
                                position: Position,
                                _token: CancellationToken,
                                _context: SignatureHelpContext) :
        ProviderResult<SignatureHelp>
    {
        const projectPath = this.rtagsMgr.getProjectPath(document.uri);
        if (!projectPath)
        {
            return undefined;
        }

        const config = workspace.getConfiguration("rtags", document.uri);
        const maxCompletionResults = config.get<number>("completion.maxResults", 20);
        const location = toRtagsLocation(document.uri, position);

        const args =
        [
            "--code-complete-at",
            location,
            "--code-complete-include-macros",
            "--synchronous-completions",
            "--max",
            maxCompletionResults.toString(),
            "--json"
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
        for (let pos = text.length - 1; pos >= 0; --pos)
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
                if (closeParenPos !== undefined)
                {
                    // Add a parenthesized range for a nested signature
                    parenRanges.push({start: pos, end: closeParenPos});
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

        return runRc(args, processCallback, this.rtagsMgr.getUnsavedSourceFiles(projectPath));
    }

    private rtagsMgr: RtagsManager;
    private disposables: Disposable[] = [];
}
