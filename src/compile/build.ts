import micromatch from 'micromatch'
import os from 'os'
import * as vscode from 'vscode'
import { lw } from '../lw'
import { executor } from './executor'

const logger = lw.log('Build')

let initialized = false
let lastAutoBuildTime = 0

export function initializeBuild() {
    if (initialized) {
        return
    }
    initialized = true
    lw.watcher.src.onChange(filePath => void autoBuild(filePath.fsPath, 'onFileChange'))
    lw.watcher.bib.onChange(filePath => void autoBuild(filePath.fsPath, 'onFileChange', true))
}

export function manualBuild(recipeName?: string): Promise<void> {
    return executor.run({recipeName, isAuto: false, isBibChanged: false})
}

export function autoBuild(
    file: string,
    type: 'onFileChange' | 'onSave',
    isBibChanged: boolean = false
): Promise<void> | undefined {
    const configuration = vscode.workspace.getConfiguration('latex-workshop', lw.file.toUri(file))
    if (configuration.get('latex.autoBuild.run') as string !== type) {
        return
    }

    logger.log('Auto build started '
        + (type === 'onFileChange' ? 'detecting the change of a file' : 'on saving file')
        + `: ${file} .`)
    lw.event.fire(lw.event.AutoBuildInitiated, {type, file})
    if (!canAutoBuild()) {
        logger.log('Autobuild temporarily disabled.')
        return
    }

    lastAutoBuildTime = Date.now()
    return executor.run({isAuto: true, isBibChanged})
}

export function terminate(): Error | undefined {
    return executor.terminate()
}

export function preventAutoBuild() {
    lastAutoBuildTime = Date.now()
}

export function isFileExcludedFromBuildOnSave(filePath: string): boolean {
    const configuration = vscode.workspace.getConfiguration('latex-workshop', lw.file.toUri(filePath))
    const globsToIgnore = configuration.get('latex.autoBuild.onSave.files.ignore') as string[]
    const format = (str: string): string => os.platform() === 'win32' ? str.replace(/\\/g, '/') : str
    return micromatch.some(filePath, globsToIgnore, {format})
}

function canAutoBuild(): boolean {
    const scope = lw.root.file.path ? lw.file.toUri(lw.root.file.path) : undefined
    const configuration = vscode.workspace.getConfiguration('latex-workshop', scope)
    return Date.now() - lastAutoBuildTime >= configuration.get('latex.autoBuild.interval', 1000)
}
