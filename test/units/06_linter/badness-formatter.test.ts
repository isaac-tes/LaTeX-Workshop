import * as vscode from 'vscode'
import * as path from 'path'
import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import * as sinon from 'sinon'
import { assert, mock, set, TextDocument } from '../utils'
import { lw } from '../../../src/lw'
import { badness } from '../../../src/lint/latex-formatter/badness'

describe(path.basename(__filename).split('.')[0] + ':', () => {
    before(() => {
        mock.init(lw, 'lint')
    })

    after(() => {
        sinon.restore()
    })

    let spawnStub: sinon.SinonStub

    interface FakeProcess extends ChildProcess {
        stdinWrite: sinon.SinonStub,
        stdinEnd: sinon.SinonStub
    }

    function makeFakeProcess(stdout: string, exitCode: number = 0, stderr: string = '', error?: Error): FakeProcess {
        const emitter = new EventEmitter()
        const stdoutEmitter = new EventEmitter()
        const stderrEmitter = new EventEmitter()
        const stdinWrite = sinon.stub()
        const stdinEnd = sinon.stub().callsFake(() => {
            setImmediate(() => {
                if (error) {
                    emitter.emit('error', error)
                    return
                }
                if (stdout !== '') {
                    stdoutEmitter.emit('data', stdout)
                }
                if (stderr !== '') {
                    stderrEmitter.emit('data', stderr)
                }
                emitter.emit('exit', exitCode)
            })
        })

        return Object.assign(emitter, {
            stdout: stdoutEmitter,
            stderr: stderrEmitter,
            stdin: { write: stdinWrite, end: stdinEnd },
            kill: sinon.stub(),
            stdinWrite,
            stdinEnd
        }) as unknown as FakeProcess
    }

    function makeDocument(filePath: string, content: string): TextDocument {
        const document = new TextDocument(filePath, content, {})
        sinon.stub(document, 'validateRange').callsFake(range => range)
        return document
    }

    beforeEach(() => {
        set.config('formatting.badness.path', 'badness')
        set.config('formatting.badness.args', [])
        lw.root.file.path = '/tmp/root.tex'
        lw.file.tmpDirPath = '/tmp'
        spawnStub = sinon.stub(lw.external, 'spawn')
    })

    afterEach(() => {
        spawnStub.restore()
    })

    it('should format stdin with the document path and working directory', async () => {
        const document = makeDocument('/tmp/project with spaces/main.tex', '\\documentclass{article}')
        const process = makeFakeProcess('formatted\n')
        spawnStub.returns(process)
        set.config('formatting.badness.path', 'custom-badness')
        set.config('formatting.badness.args', ['--line-width', '100'])

        const edit = await badness.formatDocument(document)

        assert.strictEqual(spawnStub.firstCall.args[0], 'custom-badness')
        assert.deepStrictEqual(spawnStub.firstCall.args[1], [
            'format',
            '--line-width',
            '100',
            '--stdin-filepath',
            document.fileName,
            '-'
        ])
        assert.deepStrictEqual(spawnStub.firstCall.args[2], { cwd: path.dirname(document.uri.fsPath) })
        assert.strictEqual(process.stdinWrite.firstCall.args[0], document.getText())
        assert.ok(process.stdinEnd.calledOnce)
        assert.strictEqual(edit?.newText, 'formatted\n')
    })

    it('should format only the selected range', async () => {
        const document = makeDocument('/tmp/main.tex', 'first\nsecond\n')
        const range = new vscode.Range(1, 0, 1, 6)
        const process = makeFakeProcess('formatted second')
        spawnStub.returns(process)

        const edit = await badness.formatDocument(document, range)

        assert.strictEqual(process.stdinWrite.firstCall.args[0], document.getText(range))
        assert.deepStrictEqual(edit?.range, range)
        assert.strictEqual(edit?.newText, 'formatted second')
    })

    it('should return no edit when badness exits with an error', async () => {
        const document = makeDocument('/tmp/main.tex', '\\badcommand')
        const process = makeFakeProcess('', 2, 'parse error')
        spawnStub.returns(process)

        assert.strictEqual(await badness.formatDocument(document), undefined)
    })

    it('should return no edit when badness cannot be started', async () => {
        const document = makeDocument('/tmp/main.tex', '\\documentclass{article}')
        const process = makeFakeProcess('', 0, '', new Error('command not found'))
        spawnStub.returns(process)

        assert.strictEqual(await badness.formatDocument(document), undefined)
    })
})
