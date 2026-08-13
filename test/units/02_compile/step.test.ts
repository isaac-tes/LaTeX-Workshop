import type { ChildProcess, SpawnOptions } from 'child_process'
import { EventEmitter } from 'events'
import * as path from 'path'
import * as sinon from 'sinon'
import { lw } from '../../../src/lw'
import {
    BIB_MAGIC_PROGRAM_NAME,
    MAGIC_PROGRAM_ARGS_SUFFIX,
    MAX_PRINT_LINE,
    TEX_MAGIC_PROGRAM_NAME
} from '../../../src/compile/constants'
import { Step } from '../../../src/compile/step'
import type { Tool } from '../../../src/compile/types'
import { assert, get, mock, set } from '../utils'

type FakeProcess = ChildProcess & {
    kill: sinon.SinonStub
}

describe(path.basename(__filename).split('.')[0] + ':', () => {
    let spawnStub: sinon.SinonStub
    let syncStub: sinon.SinonStub
    let parseStub: sinon.SinonStub
    let platform: PropertyDescriptor | undefined

    function createFakeProcess({pid = 123, stdout = true, stderr = true}: {
        pid?: number | undefined,
        stdout?: boolean,
        stderr?: boolean
    } = {}): FakeProcess {
        const childProcess = new EventEmitter() as FakeProcess
        Object.defineProperty(childProcess, 'pid', {value: pid, configurable: true})
        childProcess.stdout = stdout ? new EventEmitter() as NonNullable<ChildProcess['stdout']> : null
        childProcess.stderr = stderr ? new EventEmitter() as NonNullable<ChildProcess['stderr']> : null
        childProcess.kill = sinon.stub().returns(true)
        return childProcess
    }

    function createStep(
        tool: Partial<Tool> = {},
        context: Partial<Parameters<typeof Step.create>[1]> = {}
    ): Step {
        return Step.create(
            {name: 'tool', command: 'pdflatex', args: ['main.tex'], ...tool},
            {
                rootFile: get.path('main.tex'),
                cwd: get.path(),
                recipeName: 'Recipe',
                index: 0,
                total: 1,
                isExternal: false,
                ...context
            }
        )
    }

    function runWithProcess(step: Step, childProcess: FakeProcess = createFakeProcess()) {
        spawnStub.returns(childProcess)
        return {childProcess, result: step.run()}
    }

    function setPlatform(value: NodeJS.Platform) {
        Object.defineProperty(process, 'platform', {value, configurable: true})
    }

    before(() => {
        mock.init(lw)
        spawnStub = sinon.stub(lw.external, 'spawn')
        syncStub = sinon.stub(lw.external, 'sync')
        parseStub = sinon.stub(lw.parser.parse, 'log')
        platform = Object.getOwnPropertyDescriptor(process, 'platform')
    })

    beforeEach(() => {
        spawnStub.reset()
        syncStub.reset()
        parseStub.reset()
        parseStub.returns(false)
    })

    afterEach(() => {
        if (platform) {
            Object.defineProperty(process, 'platform', platform)
        }
    })

    after(() => {
        sinon.restore()
    })

    describe('Step.create', () => {
        it('copies tool data and stores execution context', () => {
            const args = ['main.tex']
            const env = {CUSTOM: 'value'}
            const step = createStep(
                {name: 'latex', command: 'latexmk', args, env},
                {recipeName: 'Latexmk', index: 1, total: 3, isExternal: true, rootFile: undefined, cwd: '/work'}
            )

            args[0] = 'changed.tex'
            env.CUSTOM = 'changed'

            assert.strictEqual(step.name, 'latex')
            assert.strictEqual(step.command, 'latexmk')
            assert.deepStrictEqual(step.args, ['main.tex'])
            assert.deepStrictEqual(step.env, {CUSTOM: 'value'})
            assert.strictEqual(step.recipeName, 'Latexmk')
            assert.strictEqual(step.index, 1)
            assert.strictEqual(step.total, 3)
            assert.strictEqual(step.isExternal, true)
            assert.strictEqual(step.rootFile, undefined)
            assert.strictEqual(step.cwd, '/work')
            assert.strictEqual(step.isRetry, false)
            assert.strictEqual(step.isSkipped, false)
            assert.strictEqual(step.process, undefined)
        })

        it('preserves omitted args and env', () => {
            const step = createStep({args: undefined, env: undefined})

            assert.strictEqual(step.args, undefined)
            assert.strictEqual(step.env, undefined)
        })
    })

    describe('Step.run invocation', () => {
        it('clears compiler output for the first step', async () => {
            lw.log('Test').logCompiler('old output')
            const {childProcess, result} = runWithProcess(createStep())
            childProcess.emit('exit', 0, null)
            await result

            assert.strictEqual(get.compiler.log(), '')
        })

        it('keeps compiler output for later steps when per-step clearing is disabled', async () => {
            set.config('latex.build.clearLog.everyRecipeStep.enabled', false)
            lw.log('Test').logCompiler('old output')
            const {childProcess, result} = runWithProcess(createStep({}, {index: 1, total: 2}))
            childProcess.emit('exit', 0, null)
            await result

            assert.strictEqual(get.compiler.log(), 'old output')
        })

        it('clears compiler output for later steps when configured', async () => {
            set.config('latex.build.clearLog.everyRecipeStep.enabled', true)
            lw.log('Test').logCompiler('old output')
            const {childProcess, result} = runWithProcess(createStep({}, {index: 1, total: 2}))
            childProcess.emit('exit', 0, null)
            await result

            assert.strictEqual(get.compiler.log(), '')
        })

        it('logs command, environment, root, and cwd', async () => {
            const step = createStep({env: {CUSTOM: 'value'}})
            const {childProcess, result} = runWithProcess(step)
            childProcess.emit('exit', 0, null)
            await result

            assert.hasLog('Recipe step 1 The command is pdflatex:["main.tex"].')
            assert.hasLog('env: {"CUSTOM":"value"}')
            assert.hasLog(`root: ${step.rootFile}`)
            assert.hasLog(`cwd: ${step.cwd}`)
        })

        it('spawns an internal tool with merged environment and max_print_line', async () => {
            const step = createStep({env: {CUSTOM: 'value', OMITTED: undefined}})
            const {childProcess, result} = runWithProcess(step)
            const options = spawnStub.firstCall.args[2] as SpawnOptions
            childProcess.emit('exit', 0, null)
            await result

            assert.strictEqual(spawnStub.firstCall.args[0], 'pdflatex')
            assert.deepStrictEqual(spawnStub.firstCall.args[1], ['main.tex'])
            assert.strictEqual(options.cwd, get.path())
            assert.strictEqual(options.shell, false)
            assert.strictEqual(options.env?.CUSTOM, 'value')
            assert.strictEqual(options.env?.OMITTED, undefined)
            assert.strictEqual(options.env?.max_print_line, MAX_PRINT_LINE)
        })

        it('spawns an external tool without internal environment', async () => {
            const step = createStep({env: {CUSTOM: 'value'}}, {isExternal: true, rootFile: undefined})
            const {childProcess, result} = runWithProcess(step)
            const options = spawnStub.firstCall.args[2] as SpawnOptions
            childProcess.emit('exit', 0, null)
            await result

            assert.strictEqual(options.cwd, get.path())
            assert.strictEqual(options.shell, false)
            assert.ok(!('env' in options))
        })

        it('uses shell mode for explicit TeX magic options', async () => {
            const step = createStep({
                name: TEX_MAGIC_PROGRAM_NAME,
                command: 'xelatex',
                args: ['-synctex=1 main.tex']
            })
            const {childProcess, result} = runWithProcess(step)
            childProcess.emit('exit', 0, null)
            await result

            assert.strictEqual(spawnStub.firstCall.args[0], 'xelatex -synctex=1 main.tex')
            assert.deepStrictEqual(spawnStub.firstCall.args[1], [])
            assert.strictEqual((spawnStub.firstCall.args[2] as SpawnOptions).shell, true)
        })

        it('recognizes explicit BIB magic options', async () => {
            const step = createStep({
                name: BIB_MAGIC_PROGRAM_NAME,
                command: 'bibtex',
                args: ['--option main']
            })
            const {childProcess, result} = runWithProcess(step)
            childProcess.emit('exit', 0, null)
            await result

            assert.strictEqual(spawnStub.firstCall.args[0], 'bibtex --option main')
            assert.deepStrictEqual(step.args, ['--option main'])
        })

        it('uses argv mode for default magic arguments', async () => {
            const step = createStep({
                name: TEX_MAGIC_PROGRAM_NAME + MAGIC_PROGRAM_ARGS_SUFFIX,
                command: 'xelatex',
                args: ['-synctex=1', 'main.tex']
            })
            const {childProcess, result} = runWithProcess(step)
            childProcess.emit('exit', 0, null)
            await result

            assert.strictEqual(spawnStub.firstCall.args[0], 'xelatex')
            assert.deepStrictEqual(spawnStub.firstCall.args[1], ['-synctex=1', 'main.tex'])
            assert.strictEqual((spawnStub.firstCall.args[2] as SpawnOptions).shell, false)
        })

        it('normalizes the final BibTeX argument inside cwd', async () => {
            const target = get.path('build', 'main.aux')
            const step = createStep({command: 'bibtex', args: ['-min-crossrefs=2', target]})
            const {childProcess, result} = runWithProcess(step)
            childProcess.emit('exit', 0, null)
            await result

            assert.deepStrictEqual(spawnStub.firstCall.args[1], ['-min-crossrefs=2', 'build/main.aux'])
            assert.deepStrictEqual(step.args, ['-min-crossrefs=2', 'build/main.aux'])
        })

        it('normalizes a relative BibTeX argument inside cwd', async () => {
            const step = createStep({command: 'bibtex', args: ['build/main.aux']})
            const {childProcess, result} = runWithProcess(step)
            childProcess.emit('exit', 0, null)
            await result

            assert.deepStrictEqual(spawnStub.firstCall.args[1], ['build/main.aux'])
        })

        it('normalizes cwd itself to an empty BibTeX argument', async () => {
            const step = createStep({command: 'bibtex', args: [get.path()]})
            const {childProcess, result} = runWithProcess(step)
            childProcess.emit('exit', 0, null)
            await result

            assert.deepStrictEqual(spawnStub.firstCall.args[1], [''])
        })

        it('keeps an empty BibTeX argument unchanged', async () => {
            const step = createStep({command: 'bibtex', args: ['']})
            const {childProcess, result} = runWithProcess(step)
            childProcess.emit('exit', 0, null)
            await result

            assert.deepStrictEqual(spawnStub.firstCall.args[1], [''])
        })

        it('keeps a BibTeX argument outside cwd unchanged', async () => {
            const outside = path.resolve(get.path(), '..', 'outside.aux')
            const step = createStep({command: 'bibtex', args: [outside]})
            const {childProcess, result} = runWithProcess(step)
            childProcess.emit('exit', 0, null)
            await result

            assert.deepStrictEqual(spawnStub.firstCall.args[1], [outside])
            assert.hasLog('Argument path not under root dir')
        })

        it('keeps the original BibTeX argument when path resolution fails', async () => {
            const invalidCwd = undefined as unknown as string
            const step = createStep({command: 'bibtex', args: ['main.aux']}, {cwd: invalidCwd})
            const {childProcess, result} = runWithProcess(step)
            childProcess.emit('exit', 0, null)
            await result

            assert.deepStrictEqual(spawnStub.firstCall.args[1], ['main.aux'])
            assert.hasLog('Cannot resolve path for arg: main.aux')
        })

        it('does not normalize arguments for another command', async () => {
            const step = createStep({command: 'biber', args: ['../main']})
            const {childProcess, result} = runWithProcess(step)
            childProcess.emit('exit', 0, null)
            await result

            assert.deepStrictEqual(spawnStub.firstCall.args[1], ['../main'])
        })

        it('supports a BibTeX invocation without arguments', async () => {
            const step = createStep({command: 'bibtex', args: []})
            const {childProcess, result} = runWithProcess(step)
            childProcess.emit('exit', 0, null)
            await result

            assert.deepStrictEqual(spawnStub.firstCall.args[1], [])
        })

        it('supports a tool with omitted arguments', async () => {
            const step = createStep({args: undefined})
            const {childProcess, result} = runWithProcess(step)
            childProcess.emit('exit', 0, null)
            await result

            assert.deepStrictEqual(spawnStub.firstCall.args[1], [])
        })

        it('returns a structured failure when spawn throws an Error', async () => {
            const error = new Error('spawn failed')
            spawnStub.throws(error)

            const result = await createStep().run()

            assert.strictEqual(result.status, 'failed')
            assert.strictEqual(result.code, null)
            assert.strictEqual(result.signal, null)
            assert.strictEqual(result.stdout, '')
            assert.strictEqual(result.stderr, '')
            assert.strictEqual(result.error, error)
            assert.strictEqual(result.skipped, false)
            assert.strictEqual(result.backend, 'unknown')
            assert.hasLog('LaTeX fatal error on PID undefined.')
        })

        it('normalizes a non-Error spawn throw', async () => {
            spawnStub.callsFake(() => {
                const reason: unknown = 'spawn failed'
                throw reason
            })

            const result = await createStep().run()

            assert.ok(result.error instanceof Error)
            assert.strictEqual(result.error.message, 'spawn failed')
        })
    })

    describe('Step.run process monitoring', () => {
        it('accumulates and logs stdout and stderr chunks', async () => {
            const {childProcess, result} = runWithProcess(createStep())
            childProcess.stdout?.emit('data', Buffer.from('first '))
            childProcess.stdout?.emit('data', 'second')
            childProcess.stderr?.emit('data', 'warning')
            childProcess.emit('exit', 0, null)

            const outcome = await result
            assert.strictEqual(outcome.stdout, 'first second')
            assert.strictEqual(outcome.stderr, 'warning')
            assert.strictEqual(get.compiler.log(), 'first secondwarning')
        })

        it('parses stderr before stdout exactly once', async () => {
            parseStub.onFirstCall().returns(true)
            parseStub.onSecondCall().returns(false)
            const step = createStep()
            const {childProcess, result} = runWithProcess(step)
            childProcess.stdout?.emit('data', 'stdout')
            childProcess.stderr?.emit('data', 'stderr')
            childProcess.emit('exit', 1, null)

            const outcome = await result
            assert.strictEqual(parseStub.callCount, 2)
            assert.strictEqual(parseStub.firstCall.args[0], 'stderr')
            assert.strictEqual(parseStub.secondCall.args[0], 'stdout')
            assert.strictEqual(parseStub.firstCall.args[1], step.rootFile)
            assert.strictEqual(outcome.skipped, true)
            assert.strictEqual(step.isSkipped, true)
        })

        it('does not parse whitespace-only streams', async () => {
            const {childProcess, result} = runWithProcess(createStep())
            childProcess.stdout?.emit('data', '  ')
            childProcess.stderr?.emit('data', '\n')
            childProcess.emit('exit', 1, null)

            const outcome = await result
            assert.ok(parseStub.notCalled)
            assert.strictEqual(outcome.skipped, false)
        })

        it('detects the first l3backend value in stdout', async () => {
            const {childProcess, result} = runWithProcess(createStep())
            childProcess.stdout?.emit('data', 'l3backend-xetex.def l3backend-pdftex.def')
            childProcess.emit('exit', 0, null)

            assert.strictEqual((await result).backend, 'xetex')
        })

        it('uses unknown when stdout has no l3backend value', async () => {
            const {childProcess, result} = runWithProcess(createStep())
            childProcess.emit('exit', 0, null)

            assert.strictEqual((await result).backend, 'unknown')
        })

        it('returns succeeded for an internal zero exit', async () => {
            const step = createStep()
            const {childProcess, result} = runWithProcess(step)
            assert.strictEqual(step.process, childProcess)
            childProcess.emit('exit', 0, null)

            const outcome = await result
            assert.strictEqual(outcome.status, 'succeeded')
            assert.strictEqual(outcome.code, 0)
            assert.strictEqual(outcome.signal, null)
            assert.strictEqual(step.process, undefined)
            assert.hasLog('Finished a step in recipe with PID 123.')
        })

        it('reports successful external completion', async () => {
            const {childProcess, result} = runWithProcess(createStep({}, {isExternal: true}))
            childProcess.emit('exit', 0, null)

            assert.strictEqual((await result).status, 'succeeded')
            assert.hasLog('Successfully built document with PID 123.')
        })

        it('returns failed for a nonzero exit', async () => {
            const {childProcess, result} = runWithProcess(createStep())
            childProcess.stdout?.emit('data', 'stdout failure')
            childProcess.stderr?.emit('data', 'stderr failure')
            childProcess.emit('exit', 2, null)

            const outcome = await result
            assert.strictEqual(outcome.status, 'failed')
            assert.strictEqual(outcome.code, 2)
            assert.hasLog('Recipe returns with error code 2/null on PID 123.')
            assert.hasLog('stdout failure')
            assert.hasLog('stderr failure')
        })

        it('returns terminated for SIGTERM', async () => {
            const {childProcess, result} = runWithProcess(createStep())
            childProcess.emit('exit', null, 'SIGTERM')

            const outcome = await result
            assert.strictEqual(outcome.status, 'terminated')
            assert.strictEqual(outcome.signal, 'SIGTERM')
        })

        it('returns failed for another signal', async () => {
            const {childProcess, result} = runWithProcess(createStep())
            childProcess.emit('exit', null, 'SIGKILL')

            const outcome = await result
            assert.strictEqual(outcome.status, 'failed')
            assert.strictEqual(outcome.signal, 'SIGKILL')
        })

        it('parses external output but never marks it skipped', async () => {
            parseStub.returns(true)
            const step = createStep({}, {isExternal: true})
            const {childProcess, result} = runWithProcess(step)
            childProcess.stdout?.emit('data', 'Latexmk: All targets are up-to-date')
            childProcess.emit('exit', 1, null)

            const outcome = await result
            assert.strictEqual(parseStub.callCount, 1)
            assert.strictEqual(outcome.status, 'failed')
            assert.strictEqual(outcome.skipped, false)
            assert.strictEqual(step.isSkipped, false)
            assert.notHasLog('Recipe returns with error code')
        })

        it('returns a structured child process error', async () => {
            const error = new Error('child failed')
            const {childProcess, result} = runWithProcess(createStep())
            childProcess.stdout?.emit('data', 'l3backend-dvipdfmx.def')
            childProcess.stderr?.emit('data', 'failure details')
            childProcess.emit('error', error)

            const outcome = await result
            assert.strictEqual(outcome.status, 'failed')
            assert.strictEqual(outcome.code, null)
            assert.strictEqual(outcome.signal, null)
            assert.strictEqual(outcome.error, error)
            assert.strictEqual(outcome.stdout, 'l3backend-dvipdfmx.def')
            assert.strictEqual(outcome.stderr, 'failure details')
            assert.strictEqual(outcome.backend, 'dvipdfmx')
            assert.ok(parseStub.notCalled)
            assert.hasLog('LaTeX fatal error on PID 123.')
            assert.hasLog('failure details')
        })

        it('uses unknown backend for a child process error without matching output', async () => {
            const {childProcess, result} = runWithProcess(createStep())
            childProcess.emit('error', new Error('child failed'))

            assert.strictEqual((await result).backend, 'unknown')
        })

        it('settles only once when exit is followed by close and error', async () => {
            const {childProcess, result} = runWithProcess(createStep())
            childProcess.stdout?.emit('data', 'output')
            childProcess.emit('exit', 0, null)
            childProcess.emit('close', 1, null)
            childProcess.emit('error', new Error('late error'))

            const outcome = await result
            assert.strictEqual(outcome.status, 'succeeded')
            assert.strictEqual(parseStub.callCount, 1)
            assert.notHasLog('late error')
        })

        it('settles only once when error is followed by exit and close', async () => {
            const error = new Error('first error')
            const {childProcess, result} = runWithProcess(createStep())
            childProcess.emit('error', error)
            childProcess.emit('exit', 0, null)
            childProcess.emit('close', 0, null)

            const outcome = await result
            assert.strictEqual(outcome.error, error)
            assert.ok(parseStub.notCalled)
            assert.notHasLog('Finished a step in recipe')
        })

        it('supports a process without stdout or stderr streams', async () => {
            const childProcess = createFakeProcess({stdout: false, stderr: false})
            const {result} = runWithProcess(createStep(), childProcess)
            childProcess.emit('close', 0, null)

            assert.strictEqual((await result).status, 'succeeded')
        })
    })

    describe('Step.terminate', () => {
        function attachProcess(step: Step, childProcess = createFakeProcess()) {
            step.process = childProcess
            return childProcess
        }

        function successfulTreeKill() {
            syncStub.returns({status: 0, stdout: '', stderr: '', error: undefined})
        }

        it('returns undefined when no process is active', () => {
            const result = createStep().terminate()

            assert.strictEqual(result, undefined)
            assert.ok(syncStub.notCalled)
            assert.hasLog('LaTeX build process to kill is not found.')
        })

        it('kills the process tree with pkill on Linux', () => {
            setPlatform('linux')
            successfulTreeKill()
            const step = createStep()
            const childProcess = attachProcess(step)

            const result = step.terminate()

            assert.strictEqual(result, undefined)
            assert.deepStrictEqual(syncStub.firstCall.args, [
                'pkill', ['-P', '123'], {timeout: 1000, encoding: 'utf8'}
            ])
            assert.ok(childProcess.kill.calledOnce)
        })

        it('kills the process tree with pkill on macOS', () => {
            setPlatform('darwin')
            successfulTreeKill()
            const step = createStep()
            attachProcess(step)

            step.terminate()

            assert.strictEqual(syncStub.firstCall.args[0], 'pkill')
        })

        it('kills the process tree with taskkill on Windows', () => {
            setPlatform('win32')
            successfulTreeKill()
            const step = createStep()
            attachProcess(step)

            step.terminate()

            assert.deepStrictEqual(syncStub.firstCall.args, [
                'taskkill', ['/F', '/T', '/PID', '123'], {timeout: 1000, encoding: 'utf8'}
            ])
        })

        it('skips tree killing on other platforms', () => {
            setPlatform('freebsd')
            const step = createStep()
            const childProcess = attachProcess(step)

            const result = step.terminate()

            assert.strictEqual(result, undefined)
            assert.ok(syncStub.notCalled)
            assert.ok(childProcess.kill.calledOnce)
        })

        it('returns a tree-kill Error and still kills the process', () => {
            setPlatform('linux')
            const error = new Error('pkill error')
            syncStub.returns({status: 1, stdout: '', stderr: '', error})
            const step = createStep()
            const childProcess = attachProcess(step)

            const result = step.terminate()

            assert.strictEqual(result, error)
            assert.ok(childProcess.kill.calledOnce)
            assert.hasLog('Failed killing child processes of the current process.')
        })

        it('uses stderr when pkill exits unsuccessfully', () => {
            setPlatform('linux')
            syncStub.returns({status: 1, stdout: '', stderr: 'stderr failure', error: undefined})
            const step = createStep()
            attachProcess(step)

            const result = step.terminate()

            assert.strictEqual(result?.message, 'stderr failure')
        })

        it('uses stdout when taskkill exits unsuccessfully without stderr', () => {
            setPlatform('win32')
            syncStub.returns({status: 1, stdout: 'stdout failure', stderr: '', error: undefined})
            const step = createStep()
            attachProcess(step)

            const result = step.terminate()

            assert.strictEqual(result?.message, 'stdout failure')
        })

        it('uses a fallback message when tree-kill has no output', () => {
            setPlatform('win32')
            syncStub.returns({status: 1, stdout: '', stderr: '', error: undefined})
            const step = createStep()
            attachProcess(step)

            const result = step.terminate()

            assert.strictEqual(result?.message, 'taskkill failed.')
        })

        it('normalizes a non-Error tree-kill throw', () => {
            setPlatform('linux')
            syncStub.callsFake(() => {
                const reason: unknown = 'pkill threw'
                throw reason
            })
            const step = createStep()
            attachProcess(step)

            const result = step.terminate()

            assert.ok(result instanceof Error)
            assert.strictEqual(result.message, 'pkill threw')
        })

        it('returns an Error thrown by process.kill', () => {
            setPlatform('freebsd')
            const error = new Error('kill failed')
            const step = createStep()
            const childProcess = attachProcess(step)
            childProcess.kill.throws(error)

            const result = step.terminate()

            assert.strictEqual(result, error)
            assert.hasLog('Failed killing the current process.')
        })

        it('normalizes a non-Error process.kill throw', () => {
            setPlatform('freebsd')
            const step = createStep()
            const childProcess = attachProcess(step)
            childProcess.kill.callsFake(() => {
                const reason: unknown = 'kill threw'
                throw reason
            })

            const result = step.terminate()

            assert.ok(result instanceof Error)
            assert.strictEqual(result.message, 'kill threw')
        })

        it('returns the first Error when tree-kill and process.kill both fail', () => {
            setPlatform('linux')
            const treeError = new Error('tree failed')
            const killError = new Error('kill failed')
            syncStub.returns({status: 1, stdout: '', stderr: '', error: treeError})
            const step = createStep()
            const childProcess = attachProcess(step)
            childProcess.kill.throws(killError)

            const result = step.terminate()

            assert.strictEqual(result, treeError)
            assert.hasLog('tree failed')
            assert.hasLog('kill failed')
        })
    })
})
