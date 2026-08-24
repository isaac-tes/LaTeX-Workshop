import * as path from 'path'
import * as vscode from 'vscode'
import { assert, TextDocument } from '../utils'

describe(path.basename(__filename).split('.')[0] + ':', () => {
    function document(content: string): TextDocument {
        return new TextDocument('/tmp/main.tex', content, {})
    }

    describe('TextEditor.getText', () => {
        it('should return the complete document text', () => {
            const testDocument = document('first\nsecond')

            assert.strictEqual(testDocument.getText(), 'first\nsecond')
        })

        it('should return text covered by a range', () => {
            const testDocument = document('first\nsecond')

            assert.strictEqual(
                testDocument.getText(new vscode.Range(0, 2, 1, 3)),
                'rst\nsec'
            )
        })
    })

    describe('TextEditor.offsetAt and positionAt', () => {
        it('should convert positions and offsets in both directions', () => {
            const testDocument = document('first\nsecond')

            assert.strictEqual(testDocument.offsetAt(new vscode.Position(1, 2)), 8)
            assert.deepStrictEqual(testDocument.positionAt(8), new vscode.Position(1, 2))
            assert.deepStrictEqual(testDocument.positionAt(6), new vscode.Position(1, 0))
        })

        it('should rebuild line offsets after content changes', () => {
            const testDocument = document('first')

            testDocument.setContent('a\nbb')

            assert.strictEqual(testDocument.lineCount, 2)
            assert.strictEqual(testDocument.offsetAt(new vscode.Position(1, 1)), 3)
            assert.deepStrictEqual(testDocument.positionAt(3), new vscode.Position(1, 1))
        })
    })
})
