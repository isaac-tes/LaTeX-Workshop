import os from 'os'
import * as path from 'path'
import * as sinon from 'sinon'
import * as vscode from 'vscode'
import {
    autoBuild,
    initializeBuild,
    isFileExcludedFromBuildOnSave,
    manualBuild,
    preventAutoBuild,
    terminate
} from '../../../src/compile/build'
import { compile } from '../../../src/compile'
import { executor } from '../../../src/compile/executor'
import { lw } from '../../../src/lw'
import { assert, get, mock, set } from '../utils'

describe(path.basename(__filename).split('.')[0] + ':', () => {
    let run: sinon.SinonStub
    let terminateExecutor: sinon.SinonStub

    before(() => {
        mock.init(lw)
        run = sinon.stub(executor, 'run')
        terminateExecutor = sinon.stub(executor, 'terminate')
    })

    beforeEach(() => {
        run.reset()
        run.resolves()
        terminateExecutor.reset()
        ;(lw.event.fire as sinon.SinonStub).reset()
        set.config('latex.autoBuild.interval', 0)
        set.config('latex.autoBuild.onSave.files.ignore', [])
    })

    after(() => {
        sinon.restore()
    })

    describe('initializeBuild', () => {
        it('registers source and bibliography handlers only once', () => {
            const sourceHandlers = lw.watcher.src['onChangeHandlers'] as Set<(uri: vscode.Uri) => void>
            const bibliographyHandlers = lw.watcher.bib['onChangeHandlers'] as Set<(uri: vscode.Uri) => void>
            const sourceCount = sourceHandlers.size
            const bibliographyCount = bibliographyHandlers.size

            initializeBuild()
            initializeBuild()

            assert.ok(sourceCount > 0)
            assert.ok(bibliographyCount > 0)
            assert.strictEqual(sourceHandlers.size, sourceCount)
            assert.strictEqual(bibliographyHandlers.size, bibliographyCount)
        })

        it('maps source and bibliography changes to auto-build requests', async () => {
            set.config('latex.autoBuild.run', 'onFileChange')
            const file = vscode.Uri.file(get.path('main.tex'))
            const sourceHandler = [...lw.watcher.src['onChangeHandlers']]
                .find(handler => handler.toString().includes('autoBuild'))
            const bibliographyHandler = [...lw.watcher.bib['onChangeHandlers']]
                .find(handler => handler.toString().includes('autoBuild'))
            assert.ok(sourceHandler)
            assert.ok(bibliographyHandler)

            sourceHandler(file)
            await Promise.resolve()
            assert.ok(run.calledWithExactly({isAuto: true, isBibChanged: false}))

            run.resetHistory()
            bibliographyHandler(file)
            await Promise.resolve()
            assert.ok(run.calledWithExactly({isAuto: true, isBibChanged: true}))
        })
    })

    describe('manualBuild', () => {
        it('maps a named manual request to the Executor', async () => {
            await manualBuild('named')

            assert.ok(run.calledOnceWithExactly({
                recipeName: 'named',
                isAuto: false,
                isBibChanged: false
            }))
        })

        it('maps an unnamed manual request to the Executor', async () => {
            await manualBuild()

            assert.ok(run.calledOnceWithExactly({
                recipeName: undefined,
                isAuto: false,
                isBibChanged: false
            }))
        })
    })

    describe('autoBuild', () => {
        it('returns before logging or firing when the event type does not match', () => {
            set.config('latex.autoBuild.run', 'onFileChange')

            const result = autoBuild(get.path('main.tex'), 'onSave')

            assert.strictEqual(result, undefined)
            assert.ok(run.notCalled)
            assert.ok((lw.event.fire as sinon.SinonStub).notCalled)
            assert.notHasLog('Auto build started')
        })

        it('uses the changed file as the event configuration scope', () => {
            const file = get.path('main.tex')
            set.config('latex.autoBuild.run', 'onSave')
            const getConfiguration = vscode.workspace.getConfiguration as sinon.SinonStub
            getConfiguration.resetHistory()

            void autoBuild(file, 'onSave')

            assert.strictEqual(getConfiguration.firstCall.args[0], 'latex-workshop')
            assert.strictEqual((getConfiguration.firstCall.args[1] as vscode.Uri).fsPath, file)
        })

        it('logs and fires AutoBuildInitiated before applying the throttle', () => {
            const file = get.path('main.tex')
            set.config('latex.autoBuild.run', 'onSave')
            set.config('latex.autoBuild.interval', 10000)
            preventAutoBuild()

            const result = autoBuild(file, 'onSave')

            assert.strictEqual(result, undefined)
            assert.hasLog(`Auto build started on saving file: ${file} .`)
            assert.hasLog('Autobuild temporarily disabled.')
            assert.ok((lw.event.fire as sinon.SinonStub).calledOnceWithExactly(
                lw.event.AutoBuildInitiated,
                {type: 'onSave', file}
            ))
            assert.ok(run.notCalled)
        })

        it('maps bibliography changes to the Executor', async () => {
            set.config('latex.autoBuild.run', 'onFileChange')

            await autoBuild(get.path('main.bib'), 'onFileChange', true)

            assert.ok(run.calledOnceWithExactly({isAuto: true, isBibChanged: true}))
        })

        it('uses an undefined interval scope when no root is known', async () => {
            set.config('latex.autoBuild.run', 'onFileChange')
            const getConfiguration = vscode.workspace.getConfiguration as sinon.SinonStub
            getConfiguration.resetHistory()

            await autoBuild(get.path('main.tex'), 'onFileChange')

            assert.ok(getConfiguration.calledWithExactly('latex-workshop', undefined))
        })

        it('uses the root file as the interval configuration scope', async () => {
            const rootFile = set.root('main.tex')
            set.config('latex.autoBuild.run', 'onFileChange')
            const getConfiguration = vscode.workspace.getConfiguration as sinon.SinonStub
            getConfiguration.resetHistory()

            await autoBuild(get.path('main.tex'), 'onFileChange')

            assert.ok(getConfiguration.getCalls().some(call =>
                call.args[0] === 'latex-workshop'
                && (call.args[1] as vscode.Uri | undefined)?.fsPath === rootFile
            ))
        })

        it('updates the throttle timestamp after an accepted request', async () => {
            set.config('latex.autoBuild.run', 'onFileChange')
            set.config('latex.autoBuild.interval', 0)

            await autoBuild(get.path('main.tex'), 'onFileChange')
            set.config('latex.autoBuild.interval', 10000)
            const result = autoBuild(get.path('main.tex'), 'onFileChange')

            assert.strictEqual(result, undefined)
            assert.ok(run.calledOnce)
        })
    })

    describe('preventAutoBuild', () => {
        it('prevents an immediate auto-build without exposing the timestamp', () => {
            set.config('latex.autoBuild.run', 'onSave')
            set.config('latex.autoBuild.interval', 10000)

            preventAutoBuild()
            const result = autoBuild(get.path('main.tex'), 'onSave')

            assert.strictEqual(result, undefined)
            assert.ok(run.notCalled)
        })
    })

    describe('isFileExcludedFromBuildOnSave', () => {
        it('matches configured ignore globs', () => {
            set.config('latex.autoBuild.onSave.files.ignore', ['**/generated/*.tex'])

            assert.ok(isFileExcludedFromBuildOnSave(get.path('generated', 'main.tex')))
            assert.ok(!isFileExcludedFromBuildOnSave(get.path('source', 'main.tex')))
        })

        it('normalizes Windows path separators before matching', () => {
            const platform = sinon.stub(os, 'platform').returns('win32')
            set.config('latex.autoBuild.onSave.files.ignore', ['**/generated/*.tex'])

            const ignored = isFileExcludedFromBuildOnSave('C:\\project\\generated\\main.tex')
            platform.restore()

            assert.ok(ignored)
        })
    })

    describe('terminate', () => {
        it('forwards and returns the Executor result', () => {
            const error = new Error('kill failed')
            terminateExecutor.returns(error)

            assert.strictEqual(terminate(), error)
            assert.ok(terminateExecutor.calledOnceWithExactly())
        })
    })

    describe('public compile state', () => {
        it('exposes read-only state without exposing the Executor singleton', () => {
            const backend = sinon.stub(executor, 'backend').get(() => 'xetex')
            const pdfPath = sinon.stub(executor, 'compiledPDFPath').get(() => get.path('main.pdf'))
            const writing = sinon.stub(executor, 'compiledPDFWriting').get(() => 1)

            try {
                assert.strictEqual('executor' in compile, false)
                assert.ok(Object.getOwnPropertyDescriptor(compile, 'backend'))
                assert.strictEqual(Object.getOwnPropertyDescriptor(compile, 'backend')?.writable, undefined)
                assert.strictEqual(compile.backend, 'xetex')
                assert.pathStrictEqual(compile.compiledPDFPath, get.path('main.pdf'))
                assert.strictEqual(compile.compiledPDFWriting, 1)
            } finally {
                backend.restore()
                pdfPath.restore()
                writing.restore()
            }
        })
    })
})
