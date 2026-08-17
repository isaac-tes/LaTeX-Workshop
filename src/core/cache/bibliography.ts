import * as path from 'path'

import { lw } from '../../lw'
import type { FileCache } from '../../types'
import { CacheStore } from './store'

export type CacheLookup = (filePath: string) => FileCache | undefined

export type BibliographyDiscovery = {
    kind: 'bibtex' | 'glossary',
    filePath: string
}

type BibliographySource = {
    readonly filePath: string,
    readonly contentTrimmed: string
}

/**
 * Discovers classic BibTeX resources before glossary resources. Results are
 * yielded serially so Cache preserves application order and partial progress if
 * a later path resolution fails.
 */
export async function* discoverBibliography(source: BibliographySource, rootDir: string): AsyncGenerator<BibliographyDiscovery> {
    yield* discoverBibFiles(source, rootDir)
    yield* discoverGlossaryBibFiles(source, rootDir)
}

/** Scans `\bibliography`, `\addbibresource`, and bracket-form `\putbib` macros. */
async function* discoverBibFiles(source: BibliographySource, rootDir: string): AsyncGenerator<BibliographyDiscovery> {
    const bibReg =
        /(?:\\(?:bibliography|addbibresource)(?:\[[^[\]{}]*\])?){(?:\\subfix{)?([\s\S]+?)(?:\})?}|(?:\\putbib)\[(?:\\subfix{)?([\s\S]+?)(?:\})?\]/gm

    let result: RegExpExecArray | null
    while ((result = bibReg.exec(source.contentTrimmed)) !== null) {
        const bibs = (result[1] ? result[1] : result[2]).split(',').map(bib => bib.trim())

        for (const bib of bibs) {
            const bibPaths = await lw.file.getBibPath(bib, rootDir, path.dirname(source.filePath))
            for (const bibPath of bibPaths) {
                yield {kind: 'bibtex', filePath: bibPath}
            }
        }
    }
}

/** Scans `\GlsXtrLoadResources` and `\glsbibdata` glossary resource macros. */
async function* discoverGlossaryBibFiles(source: BibliographySource, rootDir: string): AsyncGenerator<BibliographyDiscovery> {
    const glossaryReg = /(?:\\GlsXtrLoadResources\s*\[.*?src=\{([^}]+)\}.*?\])|(?:\\glsbibdata(?:\[[^\]]*\])?\{([^}]*)\})/gs

    let result: RegExpExecArray | null
    while ((result = glossaryReg.exec(source.contentTrimmed)) !== null) {
        const bibs = (result[1] ? result[1] : result[2]).split(',').map(bib => bib.trim())

        for (const bib of bibs) {
            const bibPaths = await lw.file.getBibPath(bib, rootDir, path.dirname(source.filePath))
            for (const bibPath of bibPaths) {
                yield {kind: 'glossary', filePath: bibPath}
            }
        }
    }
}

/** Returns bibliography resources from the cached TeX graph in first-encounter order. */
export function getIncludedBib(filePath: string | undefined, getCache: CacheLookup): string[] {
    return getIncludedBibGeneric('bibtex', filePath, getCache)
}

/** Returns glossary resources from the cached TeX graph in first-encounter order. */
export function getIncludedGlossaryBib(filePath: string | undefined, getCache: CacheLookup): string[] {
    return getIncludedBibGeneric('glossary', filePath, getCache)
}

/**
 * Traverses only TeX child edges in depth-first order; XR external edges belong
 * to separate roots. Normalized identity prevents equivalent TeX paths from
 * cycling and de-duplicates resources without changing their first encounter.
 */
function getIncludedBibGeneric(
    bibType: 'bibtex' | 'glossary',
    filePath: string | undefined,
    getCache: CacheLookup
): string[] {
    if (filePath === undefined) {
        return []
    }
    const includedBib: string[] = []
    const checkedTeX = new Set<string>()
    const checkedBib = new Set<string>()

    function visit(currentPath: string): void {
        const cacheKey = CacheStore.normalizePath(currentPath)
        if (checkedTeX.has(cacheKey)) {
            return
        }
        const fileCache = getCache(currentPath)
        if (fileCache === undefined) {
            return
        }
        checkedTeX.add(cacheKey)
        const bibfiles = bibType === 'bibtex' ? fileCache.bibfiles : fileCache.glossarybibfiles
        for (const bibPath of bibfiles) {
            const bibKey = CacheStore.normalizePath(bibPath)
            if (!checkedBib.has(bibKey)) {
                checkedBib.add(bibKey)
                includedBib.push(bibPath)
            }
        }
        for (const child of fileCache.children) {
            visit(child.filePath)
        }
    }

    visit(filePath)
    return includedBib
}
