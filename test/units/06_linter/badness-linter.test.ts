import * as vscode from 'vscode'
import * as path from 'path'
import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import * as sinon from 'sinon'
import { assert, mock, set, TextDocument } from '../utils'
import { lw } from '../../../src/lw'
import { badness, parseBadnessLog } from '../../../src/lint/latex-linter/badness'

describe(path.basename(__filename).split('.')[0] + ':', () => {
    before(() => {
        mock.init(lw, 'lint')
    })

    after(() => {
        sinon.restore()
    })

    let spawnStub: sinon.SinonStub

    beforeEach(() => {
        set.config('linting.badness.exec.path', 'badness')
        set.config('linting.badness.exec.args', [])
        set.config('latex.build.fromFolder', '')
        lw.root.file.path = '/tmp/main.tex'
        lw.root.dir.path = '/tmp'
        badness.linterDiagnostics.clear()
        spawnStub = sinon.stub(lw.external, 'spawn')
    })

    afterEach(() => {
        spawnStub.restore()
    })

    const warningLog = [
        'warning: deprecated-command',
        ' --> /tmp/main.tex:1:2',
        '  |',
        '1 | {\\bf important}',
        '  |  ^^^ `\\bf` is deprecated; use `\\bfseries`'
    ].join('\n')

    function makeFakeProcess(stdout: string, stderr = '', exitCode = 0): ChildProcess & { stdinWrites: string[], trigger: () => void } {
        const proc = new EventEmitter() as ChildProcess & { stdinWrites: string[], trigger: () => void }
        const stdoutEmitter = new EventEmitter()
        const stderrEmitter = new EventEmitter()
        const stdinWrites: string[] = []
        let resultEmitted = false
        const emitResult = () => {
            if (resultEmitted) {
                return
            }
            resultEmitted = true
            stdoutEmitter.emit('data', stdout)
            stderrEmitter.emit('data', stderr)
            proc.emit('exit', exitCode)
        }

        proc.trigger = emitResult
        proc.stdout = Object.assign(stdoutEmitter, { setEncoding: sinon.stub() }) as unknown as NonNullable<ChildProcess['stdout']>
        proc.stderr = Object.assign(stderrEmitter, { setEncoding: sinon.stub() }) as unknown as NonNullable<ChildProcess['stderr']>
        proc.stdin = {
            write: (chunk: string) => stdinWrites.push(chunk),
            end: emitResult
        } as unknown as NonNullable<ChildProcess['stdin']>
        proc.stdinWrites = stdinWrites
        proc.kill = sinon.stub()
        return proc
    }

    it('should parse diagnostic code, location, severity and message', () => {
        const entries = parseBadnessLog(warningLog)

        assert.strictEqual(entries.length, 1)
        assert.strictEqual(entries[0].file, '/tmp/main.tex')
        assert.strictEqual(entries[0].line, 1)
        assert.strictEqual(entries[0].column, 2)
        assert.strictEqual(entries[0].length, 3)
        assert.strictEqual(entries[0].code, 'deprecated-command')
        assert.strictEqual(entries[0].severity, vscode.DiagnosticSeverity.Warning)
        assert.match(entries[0].text, /deprecated/)
    })

    it('should parse relative paths, help diagnostics and multiple findings', () => {
        const log = [
            'help: redundant-script-braces',
            ' --> sub/main.tex:2:4',
            '  |',
            '2 | $x^{2}$',
            '  |    ^^^ redundant braces',
            'error: parse',
            ' --> sub/main.tex:4:1',
            '  |',
            '4 | \\begin{itemize}',
            '  | ^ unclosed environment'
        ].join('\n')

        const entries = parseBadnessLog(log, { baseDir: '/tmp/project' })

        assert.strictEqual(entries.length, 2)
        assert.strictEqual(entries[0].file, path.resolve('/tmp/project', 'sub/main.tex'))
        assert.strictEqual(entries[0].severity, vscode.DiagnosticSeverity.Hint)
        assert.strictEqual(entries[0].length, 3)
        assert.strictEqual(entries[1].severity, vscode.DiagnosticSeverity.Error)
        assert.strictEqual(entries[1].code, 'parse')
    })

    it('should parse ANSI-colored output', () => {
        const entries = parseBadnessLog(`\u001b[31m${warningLog}\u001b[0m`)

        assert.strictEqual(entries.length, 1)
        assert.strictEqual(entries[0].code, 'deprecated-command')
    })

    it('should publish diagnostics for the current document through stdin', async () => {
        const document = new TextDocument('/tmp/main.tex', '\\bf important', {})
        const proc = makeFakeProcess(warningLog)
        spawnStub.returns(proc)
        set.config('linting.badness.exec.args', ['--select', 'deprecated-command'])

        await badness.lintFile(document)

        assert.strictEqual(spawnStub.callCount, 1)
        assert.deepStrictEqual(spawnStub.firstCall.args[0], 'badness')
        assert.deepStrictEqual(spawnStub.firstCall.args[1], [
            'lint',
            '--select',
            'deprecated-command',
            '--stdin-filepath',
            '/tmp/main.tex',
            '-'
        ])
        assert.deepStrictEqual(spawnStub.firstCall.args[2], { cwd: '/tmp' })
        assert.deepStrictEqual(proc.stdinWrites, ['\\bf important'])

        const diagnostics = badness.linterDiagnostics.get(vscode.Uri.file('/tmp/main.tex'))
        assert.strictEqual(diagnostics?.length, 1)
        assert.strictEqual(diagnostics?.[0].source, 'Badness')
        assert.strictEqual(diagnostics?.[0].code, 'deprecated-command')
        assert.strictEqual(diagnostics?.[0].range.start.line, 0)
        assert.strictEqual(diagnostics?.[0].range.start.character, 1)
    })

    it('should lint the root file without stdin and clear stale diagnostics', async () => {
        badness.linterDiagnostics.set(vscode.Uri.file('/tmp/old.tex'), [
            new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), 'old', vscode.DiagnosticSeverity.Warning)
        ])
        const proc = makeFakeProcess(warningLog)
        spawnStub.callsFake(() => {
            setImmediate(proc.trigger)
            return proc
        })

        await badness.lintRootFile('/tmp/main.tex')

        assert.deepStrictEqual(spawnStub.firstCall.args[1], ['lint', '/tmp/main.tex'])
        assert.strictEqual(badness.linterDiagnostics.get(vscode.Uri.file('/tmp/old.tex'))?.length, 0)
        assert.strictEqual(badness.linterDiagnostics.get(vscode.Uri.file('/tmp/main.tex'))?.length, 1)
    })

    it('should publish findings from stderr when badness exits non-zero', async () => {
        const proc = makeFakeProcess('', warningLog, 1)
        spawnStub.callsFake(() => {
            setImmediate(proc.trigger)
            return proc
        })

        await badness.lintRootFile('/tmp/main.tex')

        assert.strictEqual(badness.linterDiagnostics.get(vscode.Uri.file('/tmp/main.tex'))?.length, 1)
    })

    it('should clear active diagnostics when lint succeeds with no findings', async () => {
        const uri = vscode.Uri.file('/tmp/main.tex')
        badness.linterDiagnostics.set(uri, [
            new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), 'old', vscode.DiagnosticSeverity.Warning)
        ])
        const proc = makeFakeProcess('')
        spawnStub.returns(proc)

        await badness.lintFile(new TextDocument('/tmp/main.tex', 'clean', {}))

        assert.strictEqual(badness.linterDiagnostics.get(uri)?.length, 0)
    })

    it('should keep previous diagnostics when badness fails without parseable output', async () => {
        const uri = vscode.Uri.file('/tmp/main.tex')
        badness.linterDiagnostics.set(uri, [
            new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), 'old', vscode.DiagnosticSeverity.Warning)
        ])
        const proc = makeFakeProcess('', 'badness.toml: invalid configuration', 2)
        spawnStub.returns(proc)

        await badness.lintFile(new TextDocument('/tmp/main.tex', 'broken', {}))

        assert.strictEqual(badness.linterDiagnostics.get(uri)?.length, 1)
        assert.strictEqual(badness.linterDiagnostics.get(uri)?.[0].message, 'old')
    })
})
