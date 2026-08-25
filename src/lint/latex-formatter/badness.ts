import * as vscode from 'vscode'
import * as path from 'path'
import { lw } from '../../lw'
import { LaTeXFormatter } from '../../types'
import { replaceArgumentPlaceholders } from '../../utils/utils'

const logger = lw.log('Format', 'badness')

export const badness: LaTeXFormatter = {
    formatDocument
}

async function formatDocument(document: vscode.TextDocument, range?: vscode.Range): Promise<vscode.TextEdit | undefined> {
    const configuration = vscode.workspace.getConfiguration('latex-workshop', document.uri)
    const program = configuration.get('formatting.badness.path', 'badness') as string
    const rootFile = lw.root.file.path || document.fileName
    const configuredArgs = (configuration.get('formatting.badness.args') as string[] | undefined) ?? []
    const args = [
        'format',
        ...configuredArgs.map(arg => replaceArgumentPlaceholders(rootFile, lw.file.tmpDirPath)(arg)),
        '--stdin-filepath',
        document.fileName,
        '-'
    ]
    logger.logCommand('Formatting LaTeX.', program, args)
    const process = lw.external.spawn(program, args, { cwd: path.dirname(document.uri.fsPath) })

    let stdout: Buffer = Buffer.alloc(0)
    process.stdout?.on('data', (msg: Buffer | string) => {
        stdout = Buffer.concat([stdout, Buffer.isBuffer(msg) ? msg : Buffer.from(msg)])
    })

    let stderr: Buffer = Buffer.alloc(0)
    process.stderr?.on('data', (msg: Buffer | string) => {
        stderr = Buffer.concat([stderr, Buffer.isBuffer(msg) ? msg : Buffer.from(msg)])
    })

    const promise = new Promise<vscode.TextEdit | undefined>(resolve => {
        process.on('error', err => {
            logger.logError(`Failed to run ${program}`, err)
            void logger.showErrorMessage(`Failed to run ${program}. See extension log for more information.`)
            resolve(undefined)
        })

        process.on('exit', code => {
            if (code !== 0) {
                logger.log(`${program} returned ${code} .`)
                if (stderr.length > 0) {
                    logger.log(stderr.toString())
                }
                if (stdout.length > 0) {
                    logger.log(stdout.toString())
                }
                void logger.showErrorMessage(`${program} returned ${code} . Be cautious on the edits.`)
                resolve(undefined)
                return
            }
            logger.log(`Formatted using ${program} ${document.fileName}.`)
            resolve(vscode.TextEdit.replace(range ?? document.validateRange(new vscode.Range(0, 0, Number.MAX_VALUE, Number.MAX_VALUE)), stdout.toString()))
        })
    })

    process.stdin?.write(document.getText(range))
    process.stdin?.end()
    return promise
}
