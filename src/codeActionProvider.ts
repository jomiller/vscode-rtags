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

import { languages, CancellationToken, CodeActionContext, CodeActionKind, CodeActionProvider, Disposable,
         ProviderResult, Range, TextDocument, WorkspaceEdit, CodeAction } from 'vscode';

import { RtagsManager, runRc } from './rtagsManager';

import { SourceFileSelector, fromRtagsPosition } from './rtagsUtil';

export class RtagsCodeActionProvider implements
    CodeActionProvider,
    Disposable
{
    constructor(rtagsMgr: RtagsManager)
    {
        this.rtagsMgr = rtagsMgr;

        this.disposables.push(languages.registerCodeActionsProvider(SourceFileSelector, this));
    }

    public dispose() : void
    {
        this.disposables.forEach((d) => { d.dispose(); });
    }

    public provideCodeActions(document: TextDocument,
                              range: Range,
                              context: CodeActionContext,
                              _token: CancellationToken) :
        ProviderResult<CodeAction[]>
    {
        if (!this.rtagsMgr.isInProject(document.uri))
        {
            return [];
        }

        if ((context.only !== undefined) && (context.only.value !== CodeActionKind.QuickFix.value))
        {
            return [];
        }

        const timeoutMs = 5000;

        const args =
        [
            "--fixits",
            document.uri.fsPath,
            "--timeout",
            timeoutMs.toString()
        ];

        const processCallback =
            (output: string) : CodeAction[] =>
            {
                let codeActions: CodeAction[] = [];

                for (const l of output.split('\n'))
                {
                    if (l.trim().length === 0)
                    {
                        continue;
                    }
                    const [pos, length, newText] = l.split(' ');
                    const [line, col] = pos.split(':');
                    const start = fromRtagsPosition(line, col);
                    if (range.start.line !== start.line)
                    {
                        continue;
                    }
                    const end = start.translate(0, parseInt(length));
                    const currentRange = new Range(start, end);
                    const currentText = document.getText(currentRange);

                    let title = "";
                    if ((currentText.length !== 0) && (newText.length !== 0))
                    {
                        title = "Replace " + currentText + " with " + newText;
                    }
                    else if (currentText.length !== 0)
                    {
                        title = "Remove " + currentText;
                    }
                    else if (newText.length !== 0)
                    {
                        title = "Add " + newText;
                    }
                    else
                    {
                        continue;
                    }

                    let edit = new WorkspaceEdit();
                    edit.replace(document.uri, currentRange, newText);

                    let action = new CodeAction("[RTags] " + title, CodeActionKind.QuickFix);
                    action.edit = edit;

                    codeActions.push(action);
                }

                return codeActions;
            };

        return runRc(args, processCallback);
    }

    private rtagsMgr: RtagsManager;
    private disposables: Disposable[] = [];
}
