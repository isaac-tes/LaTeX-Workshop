import * as vscode from 'vscode'
import * as path from 'path'

import { lw } from '../../lw'
import type { FileCache } from '../../types'
import { InputFileRegExp } from '../../utils/inputfilepath'
import * as utils from '../../utils/utils'

const logger = lw.log('Cacher')

export type CacheLookup = (filePath: string) => FileCache | undefined

export type DependencyDiscovery =
    | { kind: 'input', filePath: string, index: number, rootPath: string }
    | { kind: 'external', filePath: string, prefix: string, ownerPath: string, rootPath: string }

type DependencySource = {
    readonly filePath: string,
    readonly contentTrimmed: string,
    readonly childPaths: readonly string[]
}

/**
 * Discovers the dependency forms owned by the cache: TeX input/include-like
 * references and noweb child references recognized by `InputFileRegExp`, plus
 * XR references declared with `\externaldocument`. Results are yielded in scan
 * order so Cache can apply each discovery before a later resolution may fail.
 */
export async function* discoverDependencies(source: DependencySource, rootPath: string): AsyncGenerator<DependencyDiscovery> {
    // Input and XR scans intentionally run in sequence. InputFileRegExp and the
    // global XR expression both carry per-scan lastIndex state and must not be
    // shared between concurrent cache refreshes.
    yield* discoverInputDependencies(source, rootPath)
    yield* discoverExternalDependencies(source, rootPath)
    logger.log(`Updated inputs of ${source.filePath} .`)
}

async function* discoverInputDependencies(source: DependencySource, rootPath: string): AsyncGenerator<DependencyDiscovery> {
    const inputFileRegExp = new InputFileRegExp()
    const childPaths = new Set(source.childPaths)
    while (true) {
        const result = await inputFileRegExp.exec(source.contentTrimmed, source.filePath, rootPath)
        if (!result) {
            break
        }

        if (!(await lw.file.exists(result.path)) || path.relative(result.path, rootPath) === '') {
            continue
        }

        if (childPaths.has(result.path)) {
            continue
        }

        childPaths.add(result.path)
        yield {
            kind: 'input',
            index: result.match.index,
            filePath: result.path,
            rootPath
        }
    }
}

async function* discoverExternalDependencies(source: DependencySource, rootPath: string): AsyncGenerator<DependencyDiscovery> {
    const externalDocRegExp = /\\externaldocument(?:\[(.*?)\])?\{(.*?)\}/g
    while (true) {
        const result = externalDocRegExp.exec(source.contentTrimmed)
        if (!result) {
            break
        }

        const texDirs = vscode.workspace.getConfiguration('latex-workshop').get('latex.texDirs') as string[]
        const externalPath = await utils.resolveFile([path.dirname(source.filePath), path.dirname(rootPath), ...texDirs], result[2])
        if (!externalPath || !(await lw.file.exists(externalPath)) || path.relative(externalPath, rootPath) === '') {
            logger.log(
                `Failed resolving external ${result[2]} . Tried ${externalPath} ` +
                    (externalPath && path.relative(externalPath, rootPath) === '' ? ', which is root.' : '.')
            )
            continue
        }

        yield {
            kind: 'external',
            filePath: externalPath,
            prefix: result[1] || '',
            ownerPath: rootPath,
            // External documents are separate roots, unlike input children.
            rootPath: externalPath
        }
    }
}

/**
 * Traverses cached TeX dependencies depth first. The caller-provided Set is the
 * cycle guard, preserves insertion order, and is returned unchanged for current
 * API compatibility.
 */
export function getIncludedTeX(filePath: string | undefined, getCache: CacheLookup, includedTeX = new Set<string>()): Set<string> {
    if (filePath === undefined) {
        return includedTeX
    }
    const fileCache = getCache(filePath)
    if (fileCache === undefined) {
        return includedTeX
    }
    includedTeX.add(filePath)
    for (const child of fileCache.children) {
        if (includedTeX.has(child.filePath)) {
            continue
        }
        getIncludedTeX(child.filePath, getCache, includedTeX)
    }
    return includedTeX
}
