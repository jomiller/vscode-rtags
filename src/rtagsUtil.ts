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

import { commands, languages, window, workspace, DocumentFilter, Location, Position, Range, TextDocument,
         TextDocumentShowOptions, Uri } from 'vscode';

export type Nullable<T> = T | null;
export type Optional<T> = T | undefined;

export interface Locatable
{
    location: Location;
}

export enum SymbolCategory
{
    Macro,
    Namespace,
    TypeDecl,
    TypeRef,
    TypeDeclRef,
    TypeFunc,
    Type,
    Function,
    Variable
}

export const SourceFileSelector: DocumentFilter[] =
[
    { language: "c",   scheme: "file" },
    { language: "cpp", scheme: "file" }
];

const RtagsMacroKinds = new Set(
[
    "macrodefinition",
    "macro definition",
    "macroexpansion",
    "macro expansion"
]);

const RtagsNamespaceKinds = new Set(
[
    "Namespace",
    "NamespaceAlias",
    "NamespaceRef"
]);

const RtagsTypeDeclKinds = new Set(
[
    "ClassDecl",
    "ClassTemplate",
    "ClassTemplatePartialSpecialization",
    "StructDecl",
    "UnionDecl",
    "EnumDecl",
    "TypedefDecl",
    "TypeAliasDecl",
    "TypeAliasTemplateDecl",
    "TemplateTypeParameter",
    "TemplateTemplateParameter"
]);

const RtagsTypeRefKinds = new Set(
[
    "UsingDeclaration",
    "TypeRef",
    "TemplateRef"
]);

const RtagsTypeDeclRefKinds = new Set(
[
    ...RtagsTypeDeclKinds,
    ...RtagsTypeRefKinds
]);

const RtagsTypeFuncKinds = new Set(
[
    "CXXConstructor",
    "CXXDestructor",
    "CallExpr"
]);

const RtagsTypeKinds = new Set(
[
    ...RtagsTypeDeclKinds,
    ...RtagsTypeRefKinds,
    ...RtagsTypeFuncKinds
]);

const RtagsFunctionKinds = new Set(
[
    ...RtagsTypeFuncKinds,
    "CXXConversion",
    "CXXMethod",
    "FunctionDecl",
    "FunctionTemplate",
    "MemberRefExpr",
    "DeclRefExpr"
]);

const RtagsVariableKinds = new Set(
[
    "FieldDecl",
    "ParmDecl",
    "VarDecl",
    "EnumConstantDecl",
    "NonTypeTemplateParameter",
    "MemberRef",
    "VariableRef",
    "MemberRefExpr",
    "DeclRefExpr"
]);

const RtagsSymbolKinds = new Set(
[
    ...RtagsMacroKinds,
    ...RtagsNamespaceKinds,
    ...RtagsTypeKinds,
    ...RtagsFunctionKinds,
    ...RtagsVariableKinds
]);

export function isSourceFile(file: TextDocument) : boolean
{
    return (languages.match(SourceFileSelector, file) > 0);
}

export function isUnsavedSourceFile(file: TextDocument) : boolean
{
    if (!file.isDirty)
    {
        return false;
    }
    return isSourceFile(file);
}

export function isOpenSourceFile(uri: Uri) : boolean
{
    const file = workspace.textDocuments.find((file) => { return (file.uri.fsPath === uri.fsPath); });
    if (!file)
    {
        return false;
    }
    return isSourceFile(file);
}

export function getRtagsSymbolKinds(category?: SymbolCategory) : Set<string>
{
    let symbolKinds: Set<string>;

    switch (category)
    {
        case SymbolCategory.Macro:
            symbolKinds = RtagsMacroKinds;
            break;

        case SymbolCategory.Namespace:
            symbolKinds = RtagsNamespaceKinds;
            break;

        case SymbolCategory.TypeDecl:
            symbolKinds = RtagsTypeDeclKinds;
            break;

        case SymbolCategory.TypeRef:
            symbolKinds = RtagsTypeRefKinds;
            break;

        case SymbolCategory.TypeDeclRef:
            symbolKinds = RtagsTypeDeclRefKinds;
            break;

        case SymbolCategory.TypeFunc:
            symbolKinds = RtagsTypeFuncKinds;
            break;

        case SymbolCategory.Type:
            symbolKinds = RtagsTypeKinds;
            break;

        case SymbolCategory.Function:
            symbolKinds = RtagsFunctionKinds;
            break;

        case SymbolCategory.Variable:
            symbolKinds = RtagsVariableKinds;
            break;

        default:
            symbolKinds = RtagsSymbolKinds;
            break;
    }

    return symbolKinds;
}

export function isRtagsSymbolKind(symbolKind: string, category?: SymbolCategory) : boolean
{
    return getRtagsSymbolKinds(category).has(symbolKind);
}

export function fromRtagsPosition(line: string, column: string) : Position
{
    return new Position(parseInt(line) - 1, parseInt(column) - 1);
}

export function fromRtagsLocation(location: string) : Location
{
    const [file, line, col] = location.split(':');
    const position = fromRtagsPosition(line, col);
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

export function setContext<T>(name: string, value: T) : void
{
    commands.executeCommand("setContext", name, value);
}

export function showReferences(uri: Uri, position: Position, locations: Location[]) : void
{
    commands.executeCommand("editor.action.showReferences", uri, position, locations);
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
