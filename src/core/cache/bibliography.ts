import * as path from 'path'

import { lw } from '../../lw'
import type { FileCache } from '../../types'

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
 * to separate roots. checkedTeX prevents cycles, while final Set conversion
 * de-duplicates resources without changing their first encounter order.
 */
function getIncludedBibGeneric(
    bibType: 'bibtex' | 'glossary',
    filePath: string | undefined,
    getCache: CacheLookup,
    includedBib: string[] = [],
    checkedTeX: string[] = []
): string[] {
    if (filePath === undefined) {
        return []
    }
    const fileCache = getCache(filePath)
    if (fileCache === undefined) {
        return []
    }
    checkedTeX.push(filePath)
    if (bibType === 'bibtex') {
        includedBib.push(...fileCache.bibfiles)
    } else if (bibType === 'glossary') {
        includedBib.push(...fileCache.glossarybibfiles)
    }
    for (const child of fileCache.children) {
        if (checkedTeX.includes(child.filePath)) {
            continue
        }
        getIncludedBibGeneric(bibType, child.filePath, getCache, includedBib, checkedTeX)
    }
    return Array.from(new Set(includedBib))
}
