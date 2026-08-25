import * as vscode from 'vscode'
import * as path from 'path'
import * as sinon from 'sinon'
import { assert, mock, TextDocument } from '../utils'
import { lw } from '../../../src/lw'
import { action, provider } from '../../../src/lint/latex-code-actions'

describe(path.basename(__filename).split('.')[0] + ':', () => {
    before(() => {
        mock.init(lw, 'lint', 'parser')
    })

    after(() => {
        sinon.restore()
    })

    function document(content: string): TextDocument {
        return new TextDocument('/tmp/action.tex', content, {})
    }

    function range(start: number, end: number): vscode.Range {
        return new vscode.Range(0, start, 0, end)
    }

    function captureEdits() {
        const edits: vscode.TextEdit[] = []
        const applyEditStub = sinon.stub(vscode.workspace, 'applyEdit').callsFake(edit => {
            edits.push(...edit.entries().flatMap(([, entries]) => entries))
            return Promise.resolve(true)
        })
        return { edits, applyEditStub }
    }

    describe('provider', () => {
        it('should expose actions for known ChkTeX diagnostics and ignore unsupported diagnostics', () => {
            const doc = document('text')
            const diagnostics = [
                new vscode.Diagnostic(range(0, 1), 'space', vscode.DiagnosticSeverity.Warning),
                new vscode.Diagnostic(range(0, 1), 'quote', vscode.DiagnosticSeverity.Warning),
                new vscode.Diagnostic(range(0, 1), 'unknown', vscode.DiagnosticSeverity.Warning),
                new vscode.Diagnostic(range(0, 1), 'other source', vscode.DiagnosticSeverity.Warning)
            ]
            diagnostics[0].source = 'ChkTeX'
            diagnostics[0].code = { value: '2', target: vscode.Uri.parse('https://example.test') }
            diagnostics[1].source = 'ChkTeX'
            diagnostics[1].code = '18'
            diagnostics[2].source = 'ChkTeX'
            diagnostics[2].code = 999
            diagnostics[3].source = 'Other'
            diagnostics[3].code = 2

            const context = {
                diagnostics,
                triggerKind: vscode.CodeActionTriggerKind.Invoke,
                only: undefined
            } satisfies vscode.CodeActionContext
            const actions = provider.provideCodeActions(doc, range(0, 1), context, new vscode.CancellationTokenSource().token)

            assert.strictEqual(actions.length, 2)
            assert.strictEqual(actions[0].title, 'Convert to non-breaking space (~)')
            assert.strictEqual(actions[1].title, "Replace with ` or '")
            assert.deepStrictEqual(actions[0].arguments?.slice(2), [diagnostics[0].code, diagnostics[0].message])
        })

        it('should ignore a diagnostic without a code', () => {
            const diagnostic = new vscode.Diagnostic(range(0, 1), 'missing code', vscode.DiagnosticSeverity.Warning)
            diagnostic.source = 'ChkTeX'

            assert.deepStrictEqual(provider.provideCodeActions(
                document('text'),
                range(0, 1),
                {
                    diagnostics: [diagnostic],
                    triggerKind: vscode.CodeActionTriggerKind.Invoke,
                    only: undefined
                } satisfies vscode.CodeActionContext,
                new vscode.CancellationTokenSource().token
            ), [])
        })
    })

    describe('action', () => {
        it('should remove whitespace for all whitespace-only ChkTeX fixes', () => {
            for (const code of [24, 26, 39, 42]) {
                const { edits } = captureEdits()
                action(document('word   '), range(0, 6), code, '')
                assert.strictEqual(edits[0].newText, '')
                sinon.restore()
            }
        })

        it('should remove the highlighted range for italic-correction fixes', () => {
            for (const code of [4, 5, 28]) {
                const { edits } = captureEdits()
                action(document('word\\/'), range(4, 6), code, '')
                assert.strictEqual(edits[0].newText, '')
                sinon.restore()
            }
        })

        it('should replace spaces with command-specific fixes', () => {
            let captured = captureEdits()
            action(document('word '), range(0, 5), 1, '')
            assert.strictEqual(captured.edits[0].newText, '{}')
            sinon.restore()

            captured = captureEdits()
            action(document('word '), range(0, 5), 2, '')
            assert.strictEqual(captured.edits[0].newText, '~')
            sinon.restore()

            captured = captureEdits()
            action(document('word '), range(0, 5), 6, '')
            assert.strictEqual(captured.edits[0].newText, '\\/')
            sinon.restore()

            captured = captureEdits()
            action(document('word '), range(0, 5), 13, '')
            assert.strictEqual(captured.edits[0].newText, '\\@')
            sinon.restore()
        })

        it('should handle ellipsis and interword-space fixes with and without a matching command', () => {
            let captured = captureEdits()
            action(document('...'), range(0, 3), 11, 'Use \\dots here')
            assert.strictEqual(captured.edits[0].newText, '\\dots ')
            sinon.restore()

            captured = captureEdits()
            action(document('...'), range(0, 3), 11, 'no replacement')
            assert.strictEqual(captured.edits.length, 0)
            sinon.restore()

            captured = captureEdits()
            action(document(' '), range(0, 1), 12, '')
            assert.strictEqual(captured.edits[0].newText, '\\ ')
            sinon.restore()
        })

        it('should choose opening and closing quote replacements', () => {
            let captured = captureEdits()
            action(document('"word'), range(0, 1), 18, '')
            assert.strictEqual(captured.edits[0].newText, '``')
            sinon.restore()

            captured = captureEdits()
            action(document('word"'), range(4, 5), 18, '')
            assert.strictEqual(captured.edits[0].newText, "''")
            sinon.restore()

            captured = captureEdits()
            action(document('"'), range(0, 1), 32, '')
            assert.strictEqual(captured.edits[0].newText, '`')
            sinon.restore()

            captured = captureEdits()
            action(document('"'), range(0, 1), 33, '')
            assert.strictEqual(captured.edits[0].newText, "'")
            sinon.restore()

            captured = captureEdits()
            action(document(' "'), range(1, 2), 34, '')
            assert.strictEqual(captured.edits[0].newText, '`')
            sinon.restore()

            captured = captureEdits()
            action(document('a"'), range(1, 2), 34, '')
            assert.strictEqual(captured.edits[0].newText, "'")
            sinon.restore()
        })

        it('should apply suggested alternatives and ignore malformed suggestions', () => {
            let captured = captureEdits()
            action(document('x'), range(0, 1), 35, "Use `replacement'")
            assert.strictEqual(captured.edits[0].newText, 'replacement')
            sinon.restore()

            captured = captureEdits()
            action(document('x'), range(0, 1), 35, 'no suggestion')
            assert.strictEqual(captured.edits.length, 0)
            sinon.restore()
        })

        it('should replace inline and display math delimiters', () => {
            let captured = captureEdits()
            action(document('$$x$$'), new vscode.Range(0, 0, 0, 5), 45, '')
            assert.strictEqual(captured.edits.length, 2)
            assert.ok(captured.edits.some(edit => edit.newText === '\\['))
            assert.ok(captured.edits.some(edit => edit.newText === '\\]'))
            sinon.restore()

            captured = captureEdits()
            action(document('$x$'), new vscode.Range(0, 0, 0, 3), 46, '')
            assert.strictEqual(captured.edits.length, 2)
            assert.ok(captured.edits.some(edit => edit.newText === '\\('))
            assert.ok(captured.edits.some(edit => edit.newText === '\\)'))
            sinon.restore()
        })

        it('should find a display-math closing delimiter on a later line', () => {
            const endPairStub = sinon.stub(lw.parser.find, 'endPair').returns(new vscode.Position(1, 2))
            const { edits } = captureEdits()
            action(document('$$x\n$$ '), new vscode.Range(0, 0, 1, 3), 45, '')
            assert.strictEqual(endPairStub.callCount, 1)
            assert.strictEqual(edits.length, 2)
            sinon.restore()
        })

        it('should leave a single-dollar range unchanged when its closing delimiter is not in the range', () => {
            const { edits } = captureEdits()
            action(document('$x\n$ '), new vscode.Range(0, 0, 1, 3), 46, '')
            assert.strictEqual(edits.length, 0)
            sinon.restore()
        })

        it('should leave malformed display math unchanged when no pair is found', () => {
            const endPairStub = sinon.stub(lw.parser.find, 'endPair').returns(undefined)
            const { edits } = captureEdits()
            action(document('$$x\n$$ '), new vscode.Range(0, 0, 1, 3), 45, '')
            assert.strictEqual(endPairStub.callCount, 1)
            assert.strictEqual(edits.length, 0)
            sinon.restore()
        })

        it('should ignore unknown action codes', () => {
            const { edits } = captureEdits()
            action(document('text'), range(0, 1), 999, '')
            assert.strictEqual(edits.length, 0)
            sinon.restore()
        })

        it('should tolerate an unavailable whitespace match', () => {
            // The test intentionally replaces the unbound prototype method.
            // eslint-disable-next-line @typescript-eslint/unbound-method
            const originalExec = RegExp.prototype.exec
            const execStub = sinon.stub(RegExp.prototype, 'exec').callsFake(function (this: RegExp, text: string) {
                if (this.source === '\\s*$') {
                    return null
                }
                return originalExec.call(this, text)
            })
            const applyEditStub = sinon.stub(vscode.workspace, 'applyEdit').resolves(true)

            action(document('text'), range(0, 1), 24, '')

            assert.strictEqual(applyEditStub.callCount, 1)
            assert.strictEqual(applyEditStub.firstCall.args[0].entries().length, 0)
            execStub.restore()
            applyEditStub.restore()
        })
    })
})
