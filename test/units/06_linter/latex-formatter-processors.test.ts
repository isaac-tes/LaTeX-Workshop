import * as path from 'path'
import * as vscode from 'vscode'
import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import * as sinon from 'sinon'
import { assert, mock, set, TextDocument, TextEditor } from '../utils'
import { lw } from '../../../src/lw'
import { texfmt } from '../../../src/lint/latex-formatter/tex-fmt'

type Latexindent = typeof import('../../../src/lint/latex-formatter/latexindent').latexindent
type FakeFs = {
    __esModule: true,
    writeFileSync: sinon.SinonStub,
    unlinkSync: sinon.SinonStub,
    chmodSync: sinon.SinonStub,
    existsSync: sinon.SinonStub
}

function loadLatexindent(fakeFs: FakeFs, platform = 'darwin'): Latexindent {
    const nodeModule = require('module') as {
        _load: (request: string, parent: NodeModule, isMain: boolean) => unknown
    }
    const originalLoad = nodeModule._load
    const modulePath = require.resolve('../../../src/lint/latex-formatter/latexindent')
    const cachedModule = require.cache[modulePath]
    delete require.cache[modulePath]
    nodeModule._load = (request, parent, isMain) => {
        if (request === 'fs') {
            return fakeFs
        }
        if (request === 'os') {
            return { __esModule: true, platform: () => platform }
        }
        return originalLoad(request, parent, isMain)
    }
    try {
        return (require(modulePath) as { latexindent: Latexindent }).latexindent
    } finally {
        nodeModule._load = originalLoad
        delete require.cache[modulePath]
        if (cachedModule) {
            require.cache[modulePath] = cachedModule
        }
    }
}

describe(path.basename(__filename).split('.')[0] + ':', () => {
    before(() => {
        mock.init(lw, 'lint')
    })

    after(() => {
        sinon.restore()
    })

    interface FakeProcess extends ChildProcess {
        stdoutEmitter: EventEmitter,
        stderrEmitter: EventEmitter,
        stdinWrite: sinon.SinonStub,
        stdinEnd: sinon.SinonStub,
        kill: sinon.SinonStub
    }

    function makeProcess(withStdin = true): FakeProcess {
        const process = new EventEmitter() as FakeProcess
        process.stdoutEmitter = new EventEmitter()
        process.stderrEmitter = new EventEmitter()
        process.stdout = Object.assign(process.stdoutEmitter, { setEncoding: sinon.stub() }) as unknown as NonNullable<ChildProcess['stdout']>
        process.stderr = Object.assign(process.stderrEmitter, { setEncoding: sinon.stub() }) as unknown as NonNullable<ChildProcess['stderr']>
        process.stdinWrite = sinon.stub()
        process.stdinEnd = sinon.stub()
        process.kill = sinon.stub()
        process.stdin = withStdin
            ? { write: process.stdinWrite, end: process.stdinEnd } as unknown as NonNullable<ChildProcess['stdin']>
            : null
        return process
    }

    function makeDocument(fileName: string, content: string): TextDocument {
        const document = new TextDocument(fileName, content, {})
        sinon.stub(document, 'validateRange').callsFake(range => range)
        return document
    }

    function tick(): Promise<void> {
        return new Promise(resolve => setImmediate(resolve))
    }

    describe('latexindent', () => {
        let spawnStub: sinon.SinonStub | undefined
        let writeStub: sinon.SinonStub
        let unlinkStub: sinon.SinonStub
        let chmodStub: sinon.SinonStub
        let existsStub: sinon.SinonStub
        let latexindent: Latexindent
        let activeStubs: sinon.SinonStub[] = []

        beforeEach(() => {
            const fakeFs: FakeFs = {
                __esModule: true,
                writeFileSync: sinon.stub(),
                unlinkSync: sinon.stub(),
                chmodSync: sinon.stub(),
                existsSync: sinon.stub().returns(false)
            }
            latexindent = loadLatexindent(fakeFs)
            set.config('formatting.latexindent.path', 'latexindent')
            set.config('formatting.latexindent.args', [])
            set.config('docker.enabled', false)
            lw.extensionRoot = '/tmp/latex-workshop'
            lw.root.file.path = '/tmp/root.tex'
            lw.file.tmpDirPath = '/tmp'
            spawnStub = sinon.stub(lw.external, 'spawn')
            writeStub = fakeFs.writeFileSync
            unlinkStub = fakeFs.unlinkSync
            chmodStub = fakeFs.chmodSync
            existsStub = fakeFs.existsSync
            activeStubs = []
        })

        afterEach(() => {
            spawnStub?.restore()
            activeStubs.forEach(stub => stub.restore())
        })

        it('should use Docker latexindent and substitute temporary-file and indent placeholders', async () => {
            set.config('docker.enabled', true)
            set.config('formatting.latexindent.args', ['--file=%TMPFILE%', '--indent=%INDENT%', '--root=%TEX%'])
            const document = makeDocument('/tmp/project/main.tex', '  first\nsecond')
            const editorStub = mock.activeTextEditor('/tmp/project/main.tex', document.content)
            activeStubs.push(editorStub)
            ;(vscode.window.activeTextEditor as TextEditor).options = { insertSpaces: true, tabSize: 2 }
            const worker = makeProcess()
            spawnStub?.returns(worker)

            const pending = latexindent.formatDocument(document)
            await tick()
            worker.stdoutEmitter.emit('data', Buffer.from('formatted'))
            worker.stderrEmitter.emit('data', 'diagnostic')
            worker.emit('close', 0)
            const edit = await pending

            assert.strictEqual(chmodStub.callCount, globalThis.process.platform === 'win32' ? 0 : 1)
            assert.strictEqual(writeStub.firstCall.args[1], document.content)
            assert.ok((spawnStub!.firstCall.args[1] as string[]).some(arg => arg.includes('__latexindent_temp_main.tex')))
            assert.ok((spawnStub!.firstCall.args[1] as string[]).some(arg => arg.includes('  ')))
            assert.ok(!(spawnStub!.firstCall.args[1] as string[]).some(arg => arg.includes('%TMPFILE%')))
            assert.strictEqual(edit?.newText, 'formatted')
            assert.ok(vscode.window.activeTextEditor)
        })

        it('should use the Windows Docker launcher without chmod', async () => {
            const processStub = makeProcess()
            const platformStub = sinon.stub(process, 'platform').value('win32')
            activeStubs.push(platformStub)
            set.config('docker.enabled', true)
            spawnStub?.returns(processStub)
            const activeStub = mock.activeTextEditor('/tmp/main.tex', 'content')
            activeStubs.push(activeStub)

            const pending = latexindent.formatDocument(makeDocument('/tmp/main.tex', 'content'))
            await tick()
            processStub.stdoutEmitter.emit('data', 'formatted')
            processStub.emit('close', 0)

            assert.strictEqual((await pending)?.newText, 'formatted')
            assert.strictEqual(chmodStub.callCount, 0)
            assert.ok(spawnStub!.firstCall.args[0].endsWith('latexindent.bat'))
        })

        it('should retry latexindent with the platform extension after the first path check fails', async () => {
            const checker = makeProcess(false)
            const retryChecker = makeProcess(false)
            const worker = makeProcess()
            spawnStub?.onFirstCall().returns(checker)
            spawnStub?.onSecondCall().returns(retryChecker)
            spawnStub?.onThirdCall().returns(worker)
            const document = makeDocument('/tmp/main.tex', 'content')
            const activeStub = mock.activeTextEditor('/tmp/main.tex', 'content')
            activeStubs.push(activeStub)
            ;(vscode.window.activeTextEditor as TextEditor).options = { insertSpaces: false, tabSize: 4 }

            const pending = latexindent.formatDocument(document)
            await tick()
            checker.stderrEmitter.emit('data', 'not found')
            checker.stdoutEmitter.emit('data', 'which output')
            checker.emit('close', 1)
            retryChecker.stdoutEmitter.emit('data', 'found')
            retryChecker.emit('close', 0)
            await tick()
            worker.stdoutEmitter.emit('data', 'formatted')
            worker.emit('close', 0)
            const edit = await pending

            assert.strictEqual(spawnStub?.firstCall.args[0], 'which')
            assert.strictEqual(spawnStub?.secondCall.args[1][0], 'latexindent.pl')
            assert.strictEqual(edit?.newText, 'formatted')
        })

        it('should return no edit when both latexindent path checks fail', async () => {
            const checker = makeProcess(false)
            const retryChecker = makeProcess(false)
            spawnStub?.onFirstCall().returns(checker)
            spawnStub?.onSecondCall().returns(retryChecker)
            const pending = latexindent.formatDocument(makeDocument('/tmp/main.tex', 'content'))
            await tick()
            checker.emit('close', 1)
            retryChecker.stderrEmitter.emit('data', 'still missing')
            retryChecker.emit('close', 2)

            assert.strictEqual(await pending, undefined)
            assert.strictEqual(spawnStub?.callCount, 2)
        })

        it('should accept an existing absolute latexindent path', async () => {
            set.config('formatting.latexindent.path', '/tmp/bin/latexindent')
            existsStub.returns(true)
            const process = makeProcess()
            spawnStub?.returns(process)
            const document = makeDocument('/tmp/main.tex', 'content')
            const activeStub = mock.activeTextEditor('/tmp/main.tex', 'content')
            activeStubs.push(activeStub)

            const pending = latexindent.formatDocument(document)
            await tick()
            process.stdoutEmitter.emit('data', 'formatted')
            process.emit('close', 0)

            assert.strictEqual((await pending)?.newText, 'formatted')
            assert.strictEqual(spawnStub?.firstCall.args[0], '/tmp/bin/latexindent')
        })

        it('should reject an absolute latexindent path that does not exist', async () => {
            set.config('formatting.latexindent.path', '/tmp/bin/missing-latexindent')

            assert.strictEqual(await latexindent.formatDocument(makeDocument('/tmp/main.tex', 'content')), undefined)
            assert.strictEqual(spawnStub?.callCount, 0)
        })

        it('should return a formatted edit from a range and substitute the root fallback', async () => {
            set.config('docker.enabled', false)
            set.config('formatting.latexindent.path', '/tmp/bin/latexindent')
            existsStub.returns(true)
            set.config('formatting.latexindent.args', ['%TMPFILE%', '%INDENT%'])
            lw.root.file.path = undefined
            const process = makeProcess()
            spawnStub?.returns(process)
            const document = makeDocument('/tmp/main.tex', 'first\nsecond')
            const range = new vscode.Range(1, 0, 1, 6)
            const activeStub = mock.activeTextEditor('/tmp/main.tex', document.content)
            activeStubs.push(activeStub)
            ;(vscode.window.activeTextEditor as TextEditor).options = { insertSpaces: true, tabSize: 0 }

            const pending = latexindent.formatDocument(document, range)
            await tick()
            process.stdoutEmitter.emit('data', 'range formatted')
            process.emit('close', 0)
            const edit = await pending

            assert.deepStrictEqual(edit?.range, range)
            assert.strictEqual(edit?.newText, 'range formatted')
            assert.ok((spawnStub!.firstCall.args[1] as string[]).some(arg => arg === '    '))
            assert.strictEqual(writeStub.firstCall.args[1], 'second')
        })

        it('should log formatter errors, nonzero exits, and empty output while cleaning temporary files', async () => {
            set.config('formatting.latexindent.path', '/tmp/bin/latexindent')
            existsStub.returns(true)
            const activeStub = mock.activeTextEditor('/tmp/main.tex', 'content')
            activeStubs.push(activeStub)
            const errorProcess = makeProcess()
            spawnStub?.returns(errorProcess)
            const errorPending = latexindent.formatDocument(makeDocument('/tmp/main.tex', 'content'))
            await tick()
            errorProcess.stderrEmitter.emit('data', Buffer.from('error output'))
            errorProcess.emit('error', new Error('spawn failed'))
            assert.strictEqual(await errorPending, undefined)

            const exitProcess = makeProcess()
            spawnStub?.returns(exitProcess)
            const exitPending = latexindent.formatDocument(makeDocument('/tmp/main.tex', 'content'))
            await tick()
            exitProcess.stdoutEmitter.emit('data', 'partial output')
            exitProcess.stderrEmitter.emit('data', 'exit error')
            exitProcess.emit('close', 1)
            assert.strictEqual(await exitPending, undefined)

            const emptyProcess = makeProcess()
            spawnStub?.returns(emptyProcess)
            const emptyPending = latexindent.formatDocument(makeDocument('/tmp/main.tex', 'content'))
            await tick()
            emptyProcess.emit('close', 0)
            assert.strictEqual(await emptyPending, undefined)
            assert.ok(unlinkStub.callCount >= 3)
        })

        it('should log when a temporary file cannot be removed', async () => {
            set.config('formatting.latexindent.path', '/tmp/bin/latexindent')
            existsStub.returns(true)
            const activeStub = mock.activeTextEditor('/tmp/main.tex', 'content')
            activeStubs.push(activeStub)
            unlinkStub.throws(new Error('cannot remove'))
            const process = makeProcess()
            spawnStub?.returns(process)
            const pending = latexindent.formatDocument(makeDocument('/tmp/main.tex', 'content'))
            await tick()
            process.emit('close', 0)

            assert.strictEqual(await pending, undefined)
            assert.hasLog('Error when removing temporary file')
        })

        it('should log when a second formatting request arrives while the first is running', async () => {
            set.config('formatting.latexindent.path', '/tmp/bin/latexindent')
            existsStub.returns(true)
            const firstProcess = makeProcess()
            const secondProcess = makeProcess()
            spawnStub?.onFirstCall().returns(firstProcess)
            spawnStub?.onSecondCall().returns(secondProcess)
            const activeStub = mock.activeTextEditor('/tmp/main.tex', 'content')
            activeStubs.push(activeStub)
            const firstPending = latexindent.formatDocument(makeDocument('/tmp/main.tex', 'content'))
            await tick()
            const secondPending = latexindent.formatDocument(makeDocument('/tmp/main.tex', 'content'))
            firstProcess.stdoutEmitter.emit('data', 'first')
            firstProcess.emit('close', 0)
            secondProcess.stdoutEmitter.emit('data', 'second')
            secondProcess.emit('close', 0)

            assert.strictEqual((await firstPending)?.newText, 'first')
            assert.strictEqual((await secondPending)?.newText, 'second')
            assert.hasLog('Formatting in progress. Aborted.')
        })

        it('should return an unresolved formatting request when there is no active editor', async () => {
            set.config('formatting.latexindent.path', '/tmp/bin/latexindent')
            existsStub.returns(true)
            const activeStub = sinon.stub(vscode.window, 'activeTextEditor').value(undefined)
            activeStubs.push(activeStub)
            const pending = latexindent.formatDocument(makeDocument('/tmp/main.tex', 'content'))
            await tick()

            assert.hasLog('Exit formatting. The active textEditor is undefined.')
            void pending
        })

        it('should stop when the current platform has no latexindent metadata', async () => {
            const unknownPlatformLatexindent = loadLatexindent({
                __esModule: true,
                writeFileSync: sinon.stub(),
                unlinkSync: sinon.stub(),
                chmodSync: sinon.stub(),
                existsSync: sinon.stub().returns(false)
            }, 'freebsd')
            set.config('docker.enabled', false)
            set.config('formatting.latexindent.path', 'latexindent')

            assert.strictEqual(await unknownPlatformLatexindent.formatDocument(makeDocument('/tmp/main.tex', 'content')), undefined)
            assert.strictEqual(spawnStub?.callCount, 0)
        })
    })

    describe('tex-fmt', () => {
        let spawnStub: sinon.SinonStub

        beforeEach(() => {
            set.config('formatting.tex-fmt.path', 'tex-fmt')
            set.config('formatting.tex-fmt.args', ['--config', '%ROOTDIR%'])
            lw.root.file.path = '/tmp/root.tex'
            lw.file.tmpDirPath = '/tmp'
            spawnStub = sinon.stub(lw.external, 'spawn')
        })

        afterEach(() => {
            spawnStub.restore()
        })

        it('should format stdin, trim the extra output newline, and replace the full document', async () => {
            const process = makeProcess()
            spawnStub.returns(process)
            const document = makeDocument('/tmp/main.tex', 'content')
            const pending = texfmt.formatDocument(document)
            assert.deepStrictEqual(process.stdinWrite.firstCall.args, ['content\n'])
            assert.strictEqual(process.stdinEnd.callCount, 1)
            process.stdoutEmitter.emit('data', Buffer.from('formatted\n'))
            process.stdoutEmitter.emit('data', '\n')
            process.stderrEmitter.emit('data', 'diagnostic')
            process.emit('exit', 0)

            const edit = await pending

            assert.strictEqual(spawnStub.firstCall.args[0], 'tex-fmt')
            assert.deepStrictEqual(spawnStub.firstCall.args[1], ['--config', '%ROOTDIR%', '--stdin'])
            assert.strictEqual(edit?.newText, 'formatted')
            assert.deepStrictEqual(edit?.range, new vscode.Range(0, 0, Number.MAX_VALUE, Number.MAX_VALUE))
        })

        it('should preserve the final newline for input that already has one and format a range', async () => {
            const process = makeProcess()
            spawnStub.returns(process)
            const document = makeDocument('/tmp/main.tex', 'first\nsecond\n')
            const selected = new vscode.Range(1, 0, 2, 0)
            const pending = texfmt.formatDocument(document, selected)
            assert.deepStrictEqual(process.stdinWrite.firstCall.args, ['second\n'])
            process.stdoutEmitter.emit('data', 'formatted\n\n')
            process.emit('exit', 0)

            const edit = await pending

            assert.deepStrictEqual(edit?.range, selected)
            assert.strictEqual(edit?.newText, 'formatted\n')
        })

        it('should return no edit for a formatter error or nonzero exit', async () => {
            const errorProcess = makeProcess()
            spawnStub.returns(errorProcess)
            const errorPending = texfmt.formatDocument(makeDocument('/tmp/main.tex', 'content'))
            errorProcess.emit('error', new Error('not found'))
            assert.strictEqual(await errorPending, undefined)

            const exitProcess = makeProcess()
            spawnStub.returns(exitProcess)
            const exitPending = texfmt.formatDocument(makeDocument('/tmp/main.tex', 'content\n'))
            exitProcess.stdoutEmitter.emit('data', 'partial')
            exitProcess.stderrEmitter.emit('data', Buffer.from('failure'))
            exitProcess.emit('exit', 2)
            assert.strictEqual(await exitPending, undefined)
        })

        it('should tolerate a formatter process without stdin', async () => {
            const process = makeProcess(false)
            spawnStub.returns(process)
            const pending = texfmt.formatDocument(makeDocument('/tmp/main.tex', 'content\n'))
            process.emit('exit', 0)

            assert.strictEqual((await pending)?.newText, '')
        })

        it('should use the document as root fallback and tolerate missing stderr', async () => {
            lw.root.file.path = undefined
            const process = makeProcess()
            process.stderr = null
            spawnStub.returns(process)
            const pending = texfmt.formatDocument(makeDocument('/tmp/main.tex', 'content'))
            process.stdoutEmitter.emit('data', 'formatted')
            process.emit('exit', 0)

            assert.strictEqual((await pending)?.newText, 'formatted')
            assert.deepStrictEqual(spawnStub.firstCall.args[1], ['--config', '%ROOTDIR%', '--stdin'])
        })
    })
})
