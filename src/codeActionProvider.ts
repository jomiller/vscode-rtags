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

import { commands, languages, workspace, CancellationToken, CodeActionContext, CodeActionProvider, Command,
         Disposable, Position, ProviderResult, Range, TextDocument, WorkspaceEdit } from 'vscode';

import { RtagsManager, runRc } from './rtagsManager';

import { SourceFileSelector } from './rtagsUtil';

export class RtagsCodeActionProvider implements
    CodeActionProvider,
    Disposable
{
    constructor(rtagsMgr: RtagsManager)
    {
        this.rtagsMgr = rtagsMgr;

        this.disposables.push(
            languages.registerCodeActionsProvider(SourceFileSelector, this),
            commands.registerCommand(RtagsCodeActionProvider.commandId, this.runCodeAction, this));
    }

    public dispose() : void
    {
        for (let d of this.disposables)
        {
            d.dispose();
        }
    }

    public provideCodeActions(document: TextDocument,
                              _range: Range,
                              _context: CodeActionContext,
                              _token: CancellationToken) :
        ProviderResult<Command[]>
    {
        if (!this.rtagsMgr.isInProject(document.uri))
        {
            return [];
        }

        const processCallback =
            (output: string) : Command[] =>
            {
                let cmds: Command[] = [];
                for (const l of output.split('\n'))
                {
                    if (l.trim().length === 0)
                    {
                        continue;
                    }
                    const [pos, size, replace] = l.split(' ');
                    const [line, col] = pos.split(':');
                    const start = new Position(parseInt(line) - 1, parseInt(col) - 1);
                    const end = start.translate(0, parseInt(size));
                    const range = new Range(start, end);
                    if (_range.start.line !== start.line)
                    {
                        continue;
                    }

                    const command: Command =
                    {
                        command: RtagsCodeActionProvider.commandId,
                        title: "Replace with " + replace,
                        arguments: [document, range, replace]
                    };
                    cmds.push(command);
                }
                return cmds;
            };

        return runRc(["--fixits", document.fileName], processCallback);
    }

    private runCodeAction(document: TextDocument, range: Range, newText: string) : Thenable<boolean>
    {
        let edit = new WorkspaceEdit();
        edit.replace(document.uri, range, newText);
        return workspace.applyEdit(edit);
    }

    private static readonly commandId: string = "rtags.runCodeAction";

    private rtagsMgr: RtagsManager;
    private disposables: Disposable[] = [];
}
