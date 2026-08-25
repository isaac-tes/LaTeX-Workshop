import * as vscode from 'vscode'
import * as path from 'path'
import type { ChildProcess } from 'child_process'
import { lw } from '../../lw'
import type { LaTeXLinter } from '../../types'
import { getWorkingFolder } from '../../utils/utils'

const logger = lw.log('Linter', 'Badness')

const getName = () => 'Badness'

export type BadnessLogEntry = {
    file: string,
    line: number,
    column: number,
    length: number,
    severity: vscode.DiagnosticSeverity,
    code: string,
    text: string
}

export type BadnessParseOptions = {
    baseDir?: string,
    filePath?: string
}

export const badness: LaTeXLinter = {
    linterDiagnostics: vscode.languages.createDiagnosticCollection(getName()),
    getName,
    lintFile,
    lintRootFile,
    parseLog
}

let linterProcess: ChildProcess | undefined

async function lintRootFile(rootPath: string) {
    const result = await lint('root', rootPath)
    if (result === undefined) {
        return
    }

    publishResult(result, undefined, getWorkingFolder(rootPath))
}

async function lintFile(document: vscode.TextDocument) {
    const filePath = document.fileName
    const result = await lint('active', filePath, document.getText())
    if (result === undefined) {
        return
    }

    publishResult(result, filePath, getWorkingFolder(filePath))
}

async function lint(linterId: string, filePath: string, content?: string): Promise<BadnessProcessResult | undefined> {
    const configuration = vscode.workspace.getConfiguration('latex-workshop', lw.file.toUri(filePath))
    const command = configuration.get('linting.badness.exec.path', 'badness') as string
    const configuredArgs = configuration.get('linting.badness.exec.args', []) as string[]
    const args = ['lint', ...configuredArgs, ...(content === undefined ? [filePath] : ['--stdin-filepath', filePath, '-'])]

    linterProcess?.kill()
    logger.logCommand(`Linter for ${getName()} command`, command, args)

    let proc: ChildProcess
    try {
        proc = lw.external.spawn(command, args, { cwd: getWorkingFolder(filePath) })
    } catch (err: any) {
        logger.log(`Linter for ${getName()} failed to spawn command: ${err.message}`)
        return
    }
    linterProcess = proc

    const result = await processWrapper(linterId, proc, content)
    if (linterProcess === proc) {
        linterProcess = undefined
    }
    return result
}

function parseLog(log: string, filePath?: string): Promise<void> {
    const baseDir = getWorkingFolder(filePath || lw.root.file.path || lw.root.dir.path || '.')
    publishLogs([log], filePath, baseDir)
    return Promise.resolve()
}

function publishResult(result: BadnessProcessResult, filePath: string | undefined, baseDir: string) {
    const entries = [
        ...parseBadnessLog(result.stdout, { baseDir, filePath }),
        ...parseBadnessLog(result.stderr, { baseDir, filePath })
    ]

    if (result.exitCode !== 0 && entries.length === 0) {
        logger.log(`Linter for ${getName()} failed with exit code ${result.exitCode}.`)
        if (result.stderr !== '') {
            logger.log(result.stderr)
        }
        return
    }

    publishEntries(entries, filePath)
}

function publishLogs(logs: string[], filePath: string | undefined, baseDir: string) {
    const entries = logs.flatMap(log => parseBadnessLog(log, { baseDir, filePath }))
    publishEntries(entries, filePath)
}

function publishEntries(entries: BadnessLogEntry[], singleFileOriginalPath?: string) {
    logger.log(`Logged ${entries.length} messages.`)

    if (singleFileOriginalPath === undefined) {
        badness.linterDiagnostics.clear()
    } else if (entries.length === 0) {
        badness.linterDiagnostics.set(lw.file.toUri(singleFileOriginalPath), [])
    }

    const diagnostics = Object.create(null) as { [file: string]: vscode.Diagnostic[] }
    for (const entry of entries) {
        const range = new vscode.Range(
            new vscode.Position(entry.line - 1, entry.column - 1),
            new vscode.Position(entry.line - 1, entry.column - 1 + entry.length)
        )
        const diagnostic = new vscode.Diagnostic(range, entry.text, entry.severity)
        diagnostic.code = entry.code
        diagnostic.source = getName()
        if (diagnostics[entry.file] === undefined) {
            diagnostics[entry.file] = []
        }
        diagnostics[entry.file].push(diagnostic)
    }

    for (const file of Object.keys(diagnostics)) {
        badness.linterDiagnostics.set(lw.file.toUri(file), diagnostics[file])
    }
}

export function parseBadnessLog(log: string, options: BadnessParseOptions = {}): BadnessLogEntry[] {
    const lines = stripAnsi(log).split(/\r?\n/)
    const entries: BadnessLogEntry[] = []
    let header: { severity: vscode.DiagnosticSeverity, code: string } | undefined

    for (let index = 0; index < lines.length; index++) {
        const headerMatch = /^\s*(error|warning|help|note|info):\s*(.*?)\s*$/i.exec(lines[index])
        if (headerMatch) {
            header = {
                severity: severityFor(headerMatch[1]),
                code: headerMatch[2] || 'badness'
            }
            continue
        }

        if (!header) {
            continue
        }

        const locationMatch = /^\s*-->\s+(.+):(\d+):(\d+)\s*$/.exec(lines[index])
        if (!locationMatch) {
            continue
        }

        const line = Number(locationMatch[2])
        const column = Number(locationMatch[3])
        let length = 1
        let text = header.code
        for (let next = index + 1; next < lines.length; next++) {
            if (/^\s*(error|warning|help|note|info):\s*/i.test(lines[next]) || /^\s*-->\s+/.test(lines[next])) {
                break
            }
            const marker = parseMarkerLine(lines[next])
            if (marker) {
                length = marker.length
                text = marker.text || header.code
                break
            }
        }

        const loggedFile = locationMatch[1]
        const file = options.filePath || resolveFile(loggedFile, options.baseDir || '.')
        entries.push({
            file,
            line: Math.max(line, 1),
            column: Math.max(column, 1),
            length,
            severity: header.severity,
            code: header.code,
            text
        })
        header = undefined
    }

    return entries
}

function parseMarkerLine(line: string): { length: number, text: string } | undefined {
    const pipe = line.indexOf('|')
    if (pipe < 0) {
        return
    }
    const marker = /^\s*([_^~|]+)(?:\s+(.*))?$/.exec(line.slice(pipe + 1))
    if (!marker) {
        return
    }
    const length = Math.max(marker[1].replaceAll('|', '').length, 1)
    return {
        length,
        text: marker[2] || ''
    }
}

function resolveFile(file: string, baseDir: string): string {
    if (path.isAbsolute(file)) {
        return file
    }
    return path.resolve(baseDir, file)
}

function severityFor(severity: string): vscode.DiagnosticSeverity {
    switch (severity.toLowerCase()) {
        case 'error':
            return vscode.DiagnosticSeverity.Error
        case 'help':
            return vscode.DiagnosticSeverity.Hint
        case 'note':
        case 'info':
            return vscode.DiagnosticSeverity.Information
        case 'warning':
        default:
            return vscode.DiagnosticSeverity.Warning
    }
}

function stripAnsi(text: string): string {
    const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g')
    return text.replace(ansiEscape, '')
}

type BadnessProcessResult = {
    stdout: string,
    stderr: string,
    exitCode: number
}

function processWrapper(linterId: string, proc: ChildProcess, stdin?: string): Promise<BadnessProcessResult> {
    return new Promise(resolve => {
        let stdout = ''
        let stderr = ''
        let settled = false

        const append = (chunk: Buffer | string): string => Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
        const finish = (exitCode: number) => {
            if (settled) {
                return
            }
            settled = true
            resolve({ stdout, stderr, exitCode })
        }

        proc.stdout?.on('data', (chunk: Buffer | string) => {
            stdout += append(chunk)
        })
        proc.stderr?.on('data', (chunk: Buffer | string) => {
            stderr += append(chunk)
        })
        proc.on('error', err => {
            if (!settled) {
                settled = true
                logger.log(`Linter for ${linterId} failed to spawn command: ${err.message}`)
                resolve({ stdout, stderr, exitCode: -1 })
            }
        })
        proc.on('exit', exitCode => finish(exitCode ?? -1))

        if (stdin !== undefined) {
            if (!proc.stdin) {
                logger.log(`Linter for ${linterId} does not provide a stdin stream.`)
                finish(-1)
                return
            }
            proc.stdin.write(stdin)
            proc.stdin.end()
        }
    })
}
