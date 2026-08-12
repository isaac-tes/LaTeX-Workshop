import type { ChildProcess, SpawnOptions, SpawnSyncReturns } from 'child_process'
import path from 'path'
import * as vscode from 'vscode'
import { lw } from '../lw'
import {
    BIB_MAGIC_PROGRAM_NAME,
    MAGIC_PROGRAM_ARGS_SUFFIX,
    MAX_PRINT_LINE,
    TEX_MAGIC_PROGRAM_NAME
} from './constants'
import type { StepResult, Tool } from './types'

const logger = lw.log('Build', 'Step')

export class Step {
    readonly name: string
    readonly command: string
    readonly args?: string[]
    readonly env?: Record<string, string | undefined>
    readonly cwd: string
    readonly rootFile?: string
    readonly recipeName: string
    readonly index: number
    readonly total: number
    readonly isExternal: boolean

    isRetry = false
    isSkipped = false
    process?: ChildProcess

    private constructor(
        tool: Tool,
        context: {
            rootFile?: string,
            cwd: string,
            recipeName: string,
            index: number,
            total: number,
            isExternal: boolean
        }
    ) {
        this.name = tool.name
        this.command = tool.command
        this.args = tool.args?.slice()
        this.env = tool.env ? {...tool.env} : undefined
        this.cwd = context.cwd
        this.rootFile = context.rootFile
        this.recipeName = context.recipeName
        this.index = context.index
        this.total = context.total
        this.isExternal = context.isExternal
    }

    static create(
        tool: Tool,
        context: {
            rootFile?: string,
            cwd: string,
            recipeName: string,
            index: number,
            total: number,
            isExternal: boolean
        }
    ): Step {
        return new Step(tool, context)
    }

    async run(): Promise<StepResult> {
        this.prepareLogging()
        const env = this.createProcessEnvironment()
        const invocation = this.resolveProcessInvocation(env)
        try {
            const process = this.spawnProcess(invocation)
            return await this.monitorProcess(process, env)
        } catch (error) {
            const processError = this.toError(error)
            this.reportProcessError(processError, env, '', undefined)
            return {
                status: 'failed',
                code: null,
                signal: null,
                stdout: '',
                stderr: '',
                error: processError,
                skipped: false,
                backend: 'unknown'
            }
        }
    }

    /**
     * Terminates the active process and its children when present.
     * Child processes are killed with the platform tool on Unix and Windows,
     * then the direct process kill is always attempted; the first error wins.
     */
    terminate(): Error | undefined {
        if (this.process === undefined) {
            logger.log('LaTeX build process to kill is not found.')
            return
        }

        const childProcess = this.process
        const pid = childProcess.pid
        let firstError: Error | undefined

        try {
            logger.log(`Kill child processes of the current process with PID ${pid}.`)
            if (process.platform === 'linux' || process.platform === 'darwin') {
                const result = lw.external.sync('pkill', ['-P', `${pid}`], {timeout: 1000, encoding: 'utf8'})
                this.validateTreeKill(result, 'pkill')
            } else if (process.platform === 'win32') {
                const result = lw.external.sync('taskkill', ['/F', '/T', '/PID', `${pid}`], {timeout: 1000, encoding: 'utf8'})
                this.validateTreeKill(result, 'taskkill')
            }
        } catch (error) {
            firstError = this.toError(error)
            logger.logError('Failed killing child processes of the current process.', error)
        }

        try {
            childProcess.kill()
            logger.log(`Killed the current process with PID ${pid}`)
        } catch (error) {
            const processError = this.toError(error)
            firstError ??= processError
            logger.logError('Failed killing the current process.', error)
        }
        return firstError
    }

    private validateTreeKill(result: SpawnSyncReturns<string | Buffer>, command: 'pkill' | 'taskkill') {
        if (result.error) {
            throw result.error
        }
        if (result.status !== 0) {
            throw new Error(result.stderr.toString() || result.stdout.toString() || `${command} failed.`)
        }
    }

    private prepareLogging() {
        const scope = this.rootFile ? lw.file.toUri(this.rootFile) : undefined
        const configuration = vscode.workspace.getConfiguration('latex-workshop', scope)
        if (this.index === 0 || configuration.get('latex.build.clearLog.everyRecipeStep.enabled') as boolean) {
            logger.clearCompilerMessage()
        }
        logger.logCommand(`Recipe step ${this.index + 1}`, this.command, this.args)
        logger.log(`env: ${JSON.stringify(this.env)}`)
        logger.log(`root: ${this.rootFile}`)
        logger.log(`cwd: ${this.cwd}`)
    }

    private createProcessEnvironment(): NodeJS.ProcessEnv {
        if (this.isExternal) {
            return {...process.env}
        }
        return {...process.env, ...this.env, max_print_line: MAX_PRINT_LINE}
    }

    /**
     * Resolves the command, arguments, and spawn options for this Step.
     * Magic-comment options use a flattened shell command; otherwise BibTeX
     * arguments are normalized, and only internal Steps receive the built env.
     */
    private resolveProcessInvocation(env: NodeJS.ProcessEnv): {
        command: string,
        args: string[],
        options: SpawnOptions
    } {
        const args = this.args ?? []
        const isMagic = !this.isExternal && (
            this.name.startsWith(TEX_MAGIC_PROGRAM_NAME) ||
            this.name.startsWith(BIB_MAGIC_PROGRAM_NAME)
        )
        // All optional arguments are given as a unique string (% !TeX options)
        // if any, so we use {shell: true}
        const hasMagicOptions = isMagic && this.args !== undefined && !this.name.endsWith(MAGIC_PROGRAM_ARGS_SUFFIX)

        if (this.command === 'bibtex' && args.length > 0 && !hasMagicOptions) {
            args[args.length - 1] = this.normalizeBibtexArgument(args[args.length - 1])
        }

        const options: SpawnOptions = {cwd: this.cwd, shell: hasMagicOptions}
        if (!this.isExternal) {
            options.env = env
        }
        if (hasMagicOptions) {
            return {command: `${this.command} ${args[0]}`, args: [], options}
        }
        return {command: this.command, args, options}
    }

    private spawnProcess(invocation: {command: string, args: string[], options: SpawnOptions}): ChildProcess {
        const process = lw.external.spawn(invocation.command, invocation.args, invocation.options)
        this.process = process
        logger.log(`LaTeX build process spawned with PID ${process.pid}.`)
        return process
    }

    private monitorProcess(process: ChildProcess, env: NodeJS.ProcessEnv): Promise<StepResult> {
        let stdout = ''
        let stderr = ''
        let settled = false

        process.stdout?.on('data', (message: Buffer | string) => {
            stdout += message
            logger.logCompiler(message.toString())
        })
        process.stderr?.on('data', (message: Buffer | string) => {
            stderr += message
            logger.logCompiler(message.toString())
        })

        return new Promise(resolve => {
            const finish = (result: StepResult) => {
                settled = true
                this.process = undefined
                resolve(result)
            }
            const handleError = (error: Error) => {
                if (settled) {
                    return
                }
                const result: StepResult = {
                    status: 'failed',
                    code: null,
                    signal: null,
                    stdout,
                    stderr,
                    error,
                    skipped: false,
                    backend: stdout.match(/l3backend-(.*?)\.def/)?.[1] ?? 'unknown'
                }
                this.reportProcessError(error, env, stderr, process.pid)
                finish(result)
            }
            const handleOutcome = (code: number | null, signal: NodeJS.Signals | null) => {
                if (settled) {
                    return
                }
                const parsed = this.parseLatexLogs(stdout, stderr)
                const status = signal === 'SIGTERM' ? 'terminated' : code === 0 ? 'succeeded' : 'failed'
                const result: StepResult = {
                    status,
                    code,
                    signal,
                    stdout,
                    stderr,
                    skipped: parsed.skipped,
                    backend: parsed.backend
                }
                this.reportProcessOutcome(result, env, process.pid)
                finish(result)
            }

            process.on('error', handleError)
            process.on('exit', handleOutcome)
            process.on('close', handleOutcome)
        })
    }

    private parseLatexLogs(stdout: string, stderr: string): {skipped: boolean, backend: string} {
        let skipped = false
        // #4838 LaTeX writes messages to stdout, while dvipdfmx writes messages
        // to stderr, so both output streams need to be parsed. Both stdout and
        // stderr are parsed every time, but only when they contain
        // non-whitespace content.
        if (stderr.trim().length > 0) {
            skipped = lw.parser.parse.log(stderr, this.rootFile) || skipped
        }
        if (stdout.trim().length > 0) {
            skipped = lw.parser.parse.log(stdout, this.rootFile) || skipped
        }
        if (this.isExternal) {
            skipped = false
        } else {
            this.isSkipped = skipped
        }
        return {
            skipped,
            backend: stdout.match(/l3backend-(.*?)\.def/)?.[1] ?? 'unknown'
        }
    }

    private reportProcessError(error: Error, env: NodeJS.ProcessEnv, stderr: string, pid: number | undefined) {
        logger.logError(`LaTeX fatal error on PID ${pid}.`, error)
        logger.log(`Does the executable exist? $PATH: ${env['PATH']}, $Path: ${env['Path']}, $SHELL: ${process.env.SHELL}`)
        logger.log(stderr)
        logger.refreshStatus('x', 'errorForeground', undefined, 'error')
        void logger.showErrorMessageWithExtensionLogButton(`Recipe terminated with fatal error: ${error.message}.`)
    }

    private reportProcessOutcome(result: StepResult, env: NodeJS.ProcessEnv, pid: number | undefined) {
        if (result.status === 'succeeded') {
            if (this.isExternal) {
                logger.log(`Successfully built document with PID ${pid}.`)
                logger.refreshStatus('check', 'statusBar.foreground', 'Build succeeded.')
            } else {
                logger.log(`Finished a step in recipe with PID ${pid}.`)
            }
            return
        }
        if (!this.isExternal) {
            logger.log(`Recipe returns with error code ${result.code}/${result.signal} on PID ${pid}.`)
            logger.log(`Does the executable exist? $PATH: ${env['PATH']}, $Path: ${env['Path']}, $SHELL: ${process.env.SHELL}`)
            if (result.stdout.trim().length > 0) {
                logger.log(result.stdout)
            }
            if (result.stderr.trim().length > 0) {
                logger.log(result.stderr)
            }
        }
    }

    private normalizeBibtexArgument(argument: string): string {
        if (!argument) {
            return argument
        }
        let absolutePath: string
        try {
            absolutePath = path.isAbsolute(argument) ? path.normalize(argument) : path.resolve(this.cwd, argument)
        } catch {
            logger.log(`Cannot resolve path for arg: ${argument} please check if it is a valid path.`)
            return argument
        }

        // #4714 Use a relative path inside cwd to satisfy TeX distribution
        // output-path restrictions.
        const relativePath = path.relative(this.cwd, absolutePath)
        const isInsideCwd = relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
        if (!isInsideCwd) {
            logger.log(`Argument path not under root dir, you can wiki how to set openout_any=a if you want to keep as-is: ${argument}`)
            return argument
        }
        const normalized = relativePath.split(path.sep).join('/')
        logger.log(`Argument path converted to relative: ${argument} -> ${normalized}`)
        return normalized
    }

    private toError(error: unknown): Error {
        return error instanceof Error ? error : new Error(String(error))
    }
}
