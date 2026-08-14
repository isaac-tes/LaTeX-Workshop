import * as vscode from 'vscode'
import * as path from 'path'

import { lw } from '../../lw'
import type { FileCache } from '../../types'
import { InputFileRegExp } from '../../utils/inputfilepath'
import * as utils from '../../utils/utils'

const logger = lw.log('Cacher')

/** Instance-bound operations needed while dependency discovery still applies side effects. */
export type DependencyContext = {
    getCache: (filePath: string) => FileCache | undefined,
    watchSource: (filePath: string) => void,
    refreshSource: (filePath: string, rootPath: string) => void
}

/**
 * Discovers the dependency forms owned by the cache: TeX input/include-like
 * references and noweb child references recognized by `InputFileRegExp`, plus
 * XR references declared with `\externaldocument`. During the structural
 * migration this function also preserves watcher registration and non-blocking
 * recursive refresh side effects through the owning Cache context.
 */
export async function updateDependencies(fileCache: FileCache, rootPath: string, context: DependencyContext): Promise<void> {
    // Input and XR scans intentionally run in sequence. InputFileRegExp and the
    // global XR expression both carry per-scan lastIndex state and must not be
    // shared between concurrent cache refreshes.
    await updateInputDependencies(fileCache, rootPath, context)
    await updateExternalDependencies(fileCache, rootPath, context)
    logger.log(`Updated inputs of ${fileCache.filePath} .`)
}

async function updateInputDependencies(fileCache: FileCache, rootPath: string, context: DependencyContext): Promise<void> {
    const inputFileRegExp = new InputFileRegExp()
    while (true) {
        const result = await inputFileRegExp.exec(fileCache.contentTrimmed, fileCache.filePath, rootPath)
        if (!result) {
            break
        }

        if (!(await lw.file.exists(result.path)) || path.relative(result.path, rootPath) === '') {
            continue
        }

        if (fileCache.children.some(child => child.filePath === result.path)) {
            continue
        }

        fileCache.children.push({
            index: result.match.index,
            filePath: result.path
        })
        logger.log(`Input ${result.path} from ${fileCache.filePath} .`)

        if (lw.watcher.src.has(lw.file.toUri(result.path))) {
            continue
        }
        context.watchSource(result.path)
        // Parents do not await recursive child refreshes because circular input
        // graphs would otherwise create wait cycles.
        context.refreshSource(result.path, rootPath)
    }
}

async function updateExternalDependencies(fileCache: FileCache, rootPath: string, context: DependencyContext): Promise<void> {
    const externalDocRegExp = /\\externaldocument(?:\[(.*?)\])?\{(.*?)\}/g
    while (true) {
        const result = externalDocRegExp.exec(fileCache.contentTrimmed)
        if (!result) {
            break
        }

        const texDirs = vscode.workspace.getConfiguration('latex-workshop').get('latex.texDirs') as string[]
        const externalPath = await utils.resolveFile([path.dirname(fileCache.filePath), path.dirname(rootPath), ...texDirs], result[2])
        if (!externalPath || !(await lw.file.exists(externalPath)) || path.relative(externalPath, rootPath) === '') {
            logger.log(
                `Failed resolving external ${result[2]} . Tried ${externalPath} ` +
                    (externalPath && path.relative(externalPath, rootPath) === '' ? ', which is root.' : '.')
            )
            continue
        }

        // XR metadata belongs to the root document even when the declaration
        // appears in a child. A missing root cache does not suppress watching
        // and refreshing the external document.
        const rootCache = context.getCache(rootPath)
        if (rootCache !== undefined) {
            rootCache.external[externalPath] = result[1] || ''
            logger.log(`External document ${externalPath} from ${fileCache.filePath} .` + (result[1] ? ` Prefix is ${result[1]}` : ''))
        }

        if (lw.watcher.src.has(lw.file.toUri(externalPath))) {
            continue
        }
        context.watchSource(externalPath)
        // External documents are separate roots, unlike input children which
        // inherit the root of the document that discovered them.
        context.refreshSource(externalPath, externalPath)
    }
}

/**
 * Traverses cached TeX dependencies depth first. The caller-provided Set is the
 * cycle guard, preserves insertion order, and is returned unchanged for current
 * API compatibility.
 */
export function getIncludedTeX(filePath: string | undefined, context: DependencyContext, includedTeX = new Set<string>()): Set<string> {
    if (filePath === undefined) {
        return includedTeX
    }
    const fileCache = context.getCache(filePath)
    if (fileCache === undefined) {
        return includedTeX
    }
    includedTeX.add(filePath)
    for (const child of fileCache.children) {
        if (includedTeX.has(child.filePath)) {
            continue
        }
        getIncludedTeX(child.filePath, context, includedTeX)
    }
    return includedTeX
}
