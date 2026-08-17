import * as vscode from 'vscode'
import * as path from 'path'

import { lw } from '../../lw'
import type { FileCache } from '../../types'
import { InputFileRegExp } from '../../utils/inputfilepath'
import * as utils from '../../utils/utils'
import { CacheStore } from './store'

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
    const childPaths = new Set(source.childPaths.map(childPath => CacheStore.normalizePath(childPath)))
    const rootKey = CacheStore.normalizePath(rootPath)
    while (true) {
        const result = await inputFileRegExp.exec(source.contentTrimmed, source.filePath, rootPath)
        if (!result) {
            break
        }

        const resultKey = CacheStore.normalizePath(result.path)
        if (!(await lw.file.exists(result.path)) || resultKey === rootKey) {
            continue
        }

        if (childPaths.has(resultKey)) {
            continue
        }

        childPaths.add(resultKey)
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
    const rootKey = CacheStore.normalizePath(rootPath)
    while (true) {
        const result = externalDocRegExp.exec(source.contentTrimmed)
        if (!result) {
            break
        }

        const texDirs = vscode.workspace.getConfiguration('latex-workshop').get('latex.texDirs') as string[]
        const externalPath = await utils.resolveFile([path.dirname(source.filePath), path.dirname(rootPath), ...texDirs], result[2])
        if (!externalPath || !(await lw.file.exists(externalPath)) || CacheStore.normalizePath(externalPath) === rootKey) {
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
 * Traverses cached TeX dependencies depth first. The private result Set also
 * guards cycles by normalized identity while preserving first-seen source paths
 * and depth-first insertion order for callers.
 */
export function getIncludedTeX(filePath: string | undefined, getCache: CacheLookup): Set<string> {
    const includedTeX = new Set<string>()
    if (filePath === undefined) {
        return includedTeX
    }
    const checked = new Set<string>()

    function visit(currentPath: string): void {
        const fileCache = getCache(currentPath)
        if (fileCache === undefined) {
            return
        }
        const cacheKey = CacheStore.normalizePath(currentPath)
        if (checked.has(cacheKey)) {
            return
        }
        checked.add(cacheKey)
        includedTeX.add(currentPath)
        for (const child of fileCache.children) {
            visit(child.filePath)
        }
    }

    visit(filePath)
    return includedTeX
}
