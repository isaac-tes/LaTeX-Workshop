import * as vscode from 'vscode'

export interface FakeTextDocumentOptions {
    languageId?: string,
    isDirty?: boolean,
    isClosed?: boolean,
    scheme?: string
}

export interface FakeTextEditorOptions extends FakeTextDocumentOptions {
    viewColumn?: vscode.ViewColumn
}

/**
 * Lightweight `TextDocument` implementation for unit tests that need a real
 * document shape without opening a VS Code editor.
 *
 * Only the document behavior currently required by the unit suite is modeled;
 * unsupported VS Code operations deliberately throw `Not implemented.`.
 */
export class TextDocument implements vscode.TextDocument {
    content: string
    lines: string[]
    uri: vscode.Uri
    fileName: string
    isUntitled: boolean = false
    languageId: string
    version: number = 0
    isDirty: boolean
    isClosed: boolean
    eol: vscode.EndOfLine = vscode.EndOfLine.LF
    lineCount: number
    encoding: string = 'utf8'

    /**
     * Creates a fake document with the supplied path, content, and document metadata.
     * Use it when a unit under test accepts `vscode.TextDocument` directly.
     */
    constructor(filePath: string, content: string, { languageId = 'latex', isDirty = false, isClosed = false, scheme = 'file' }: FakeTextDocumentOptions) {
        this.content = content
        this.lines = content.split('\n')
        this.uri = scheme === 'file' ? vscode.Uri.file(filePath) : vscode.Uri.from({ scheme, path: filePath })
        this.fileName = filePath
        this.languageId = languageId
        this.isDirty = isDirty
        this.isClosed = isClosed
        this.lineCount = this.lines.length
    }

    /**
     * Replaces the fake document content and refreshes its line metadata.
     * Use when a test needs to simulate an in-memory document update.
     */
    setContent(content: string): void {
        this.content = content
        this.lines = content.split('\n')
        this.lineCount = this.lines.length
    }

    /**
     * Changes the language identifier reported by the fake document.
     * Use when one document fixture is reused across language-specific tests.
     */
    setLanguage(languageId: string): void {
        this.languageId = languageId
    }

    /**
     * Returns metadata for one document line.
     * Use this when the code under test reads line text or whitespace information.
     */
    lineAt(lineOrPos: number | vscode.Position): vscode.TextLine {
        const lineNumber = lineOrPos instanceof vscode.Position ? lineOrPos.line : lineOrPos
        const text = this.content.split('\n')[lineNumber]
        return {
            lineNumber,
            text,
            range: new vscode.Range(new vscode.Position(lineNumber, 0), new vscode.Position(lineNumber, text.length)),
            rangeIncludingLineBreak: new vscode.Range(new vscode.Position(lineNumber, 0), new vscode.Position(lineNumber, text.length + 1)),
            firstNonWhitespaceCharacterIndex: text.length - text.trimStart().length,
            isEmptyOrWhitespace: text.trim() === ''
        }
    }

    /**
     * Converts a document position to a content offset using the fake
     * document's newline-separated content.
     * Use this when applying or inspecting range-based edits in a fake document.
     */
    offsetAt(position: vscode.Position): number {
        return this.lines.slice(0, position.line).reduce((offset, line) => offset + line.length + 1, 0) + position.character
    }

    /**
     * Converts a content offset to a document position using the fake
     * document's newline-separated content.
     * Use this when translating a workspace edit into content positions.
     */
    positionAt(offset: number): vscode.Position {
        const before = this.content.slice(0, offset).split('\n')
        return new vscode.Position(before.length - 1, before.at(-1)?.length ?? 0)
    }

    /**
     * Returns either the complete document text or the text covered by a range.
     * Use this when code under test reads a workspace edit's source range.
     */
    getText(range?: vscode.Range): string {
        return range ? this.content.slice(this.offsetAt(range.start), this.offsetAt(range.end)) : this.content
    }

    /**
     * Document operations not needed by the current unit suite are intentionally unsupported;
     * these stubs remain to satisfy the `vscode.TextDocument` interface.
     */
    save(): Thenable<boolean> { throw new Error('Not implemented.') }
    getWordRangeAtPosition(_p: vscode.Position, _r?: RegExp): vscode.Range | undefined { throw new Error('Not implemented.') }
    validateRange(_: vscode.Range): vscode.Range { throw new Error('Not implemented.') }
    validatePosition(_: vscode.Position): vscode.Position { throw new Error('Not implemented.') }
}

/**
 * Lightweight `TextEditor` implementation for tests that exercise active-editor
 * state or selections without opening a VS Code editor.
 */
export class TextEditor implements vscode.TextEditor {
    document: TextDocument
    selection: vscode.Selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0))
    selections: vscode.Selection[] = [ this.selection ]
    visibleRanges: vscode.Range[] = [ new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)) ]
    options: vscode.TextEditorOptions = {}
    viewColumn: vscode.ViewColumn | undefined = vscode.ViewColumn.Active

    /**
     * Creates a fake editor containing a fake document.
     * Use it when the unit under test reads the active editor or its selections.
     */
    constructor(filePath: string, content: string, { languageId = 'latex', isDirty = false, isClosed = false, scheme = 'file', viewColumn = undefined }: FakeTextEditorOptions) {
        this.document = new TextDocument(filePath, content, { languageId, isDirty, isClosed, scheme })
        if (viewColumn !== undefined) {
            this.viewColumn = viewColumn
        }
    }

    /**
     * Replaces the editor's current selection set.
     * Use when a test needs to simulate one or more selected ranges.
     */
    setSelections(selections: vscode.Selection[]): void {
        this.selection = selections[0]
        this.selections = selections
    }

    /**
     * Editing and view operations are not needed by the current unit suite.
     */
    edit(_: (_: vscode.TextEditorEdit) => void): Thenable<boolean> { throw new Error('Not implemented.') }
    insertSnippet(_: vscode.SnippetString): Thenable<boolean> { throw new Error('Not implemented.') }
    setDecorations(_d: vscode.TextEditorDecorationType, _r: vscode.Range[] | vscode.DecorationOptions[]): void { throw new Error('Not implemented.') }
    revealRange(_: vscode.Range): void { throw new Error('Not implemented.') }
    show(): void { throw new Error('Not implemented.') }
    hide(): void { throw new Error('Not implemented.') }
}
