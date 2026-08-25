import * as vscode from 'vscode'
import * as path from 'path'
import * as sinon from 'sinon'
import { assert, mock, set } from '../utils'
import { lw } from '../../../src/lw'
import { dupLabelDetector } from '../../../src/lint/duplicate-label'

describe(path.basename(__filename).split('.')[0] + ':', () => {
    before(() => {
        mock.init(lw, 'lint')
    })

    after(() => {
        sinon.restore()
    })

    beforeEach(() => {
        set.config('check.duplicatedLabels.enabled', true)
        dupLabelDetector.reset()
    })

    function reference(label: string, range?: vscode.Range | { inserting: vscode.Range }) {
        return { label, range }
    }

    function setCache(entries: Record<string, unknown>): void {
        ;(lw.cache.getIncludedTeX as sinon.SinonStub).returns(Object.keys(entries))
        ;(lw.cache.get as sinon.SinonStub).callsFake((file: string) => entries[file])
    }

    function diagnostics(file: string): vscode.Diagnostic[] {
        return vscode.languages.getDiagnostics(vscode.Uri.file(file)).filter(diag => diag.source === 'DuplicateLabels')
    }

    it('should do nothing when duplicate-label checking is disabled', () => {
        set.config('check.duplicatedLabels.enabled', false)
        const includedStub = lw.cache.getIncludedTeX as sinon.SinonStub
        includedStub.resetHistory()

        dupLabelDetector.check()

        assert.strictEqual(includedStub.callCount, 0)
    })

    it('should clear diagnostics when there are no duplicate labels', () => {
        const file = '/tmp/no-duplicates.tex'
        setCache({
            [file]: { elements: { reference: [reference('unique', new vscode.Range(0, 0, 0, 1))] } },
            '/tmp/without-cache.tex': undefined,
            '/tmp/without-range.tex': { elements: { reference: [reference('ignored')] } }
        })
        dupLabelDetector.check()

        assert.deepStrictEqual(diagnostics(file), [])
    })

    it('should report every occurrence of a duplicate label on TeX files', () => {
        const texFile = '/tmp/main.tex'
        const nonTexFile = '/tmp/style.sty'
        const firstRange = new vscode.Range(1, 2, 1, 8)
        const secondRange = new vscode.Range(2, 4, 2, 10)
        setCache({
            [texFile]: {
                elements: {
                    reference: [
                        reference('dup', firstRange),
                        reference('dup', { inserting: secondRange }),
                        reference('unique', new vscode.Range(3, 0, 3, 1)),
                        reference('ignored')
                    ]
                }
            },
            [nonTexFile]: { elements: { reference: [reference('dup', new vscode.Range(4, 0, 4, 1))] } },
            '/tmp/without-cache.tex': undefined
        })

        dupLabelDetector.check()

        const diags = diagnostics(texFile)
        assert.strictEqual(diags.length, 2)
        assert.strictEqual(diags[0].message, 'Duplicate label dup')
        assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Warning)
        assert.strictEqual(diags[0].range.start.line, firstRange.start.line)
        assert.strictEqual(diags[1].range.start.line, secondRange.start.line)
        assert.deepStrictEqual(diagnostics(nonTexFile), [])
    })

    it('should reset the duplicate-label diagnostic collection', () => {
        const file = '/tmp/reset.tex'
        setCache({
            [file]: { elements: { reference: [reference('dup', new vscode.Range(0, 0, 0, 1)), reference('dup', new vscode.Range(1, 0, 1, 1))] } }
        })
        dupLabelDetector.check()
        assert.strictEqual(diagnostics(file).length, 2)

        dupLabelDetector.reset()

        assert.deepStrictEqual(diagnostics(file), [])
    })
})
