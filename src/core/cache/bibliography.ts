import * as path from 'path'

import { lw } from '../../lw'
import type { FileCache } from '../../types'

const logger = lw.log('Cacher')

/** Instance-bound reads needed while bibliography discovery still applies side effects. */
export type BibliographyContext = {
    getCache: (filePath: string) => FileCache | undefined,
    isExcluded: (filePath: string) => boolean
}

/**
 * Discovers classic BibTeX resources before glossary resources. Both scans are
 * awaited serially because Set insertion, logging, watcher events, and failure
 * propagation are observable in source order.
 */
export async function updateBibliography(fileCache: FileCache, context: BibliographyContext): Promise<void> {
    await updateBibFiles(fileCache, context)
    await updateGlossaryBibFiles(fileCache, context)
}

/** Scans `\bibliography`, `\addbibresource`, and bracket-form `\putbib` macros. */
async function updateBibFiles(fileCache: FileCache, context: BibliographyContext): Promise<void> {
    const bibReg =
        /(?:\\(?:bibliography|addbibresource)(?:\[[^[\]{}]*\])?){(?:\\subfix{)?([\s\S]+?)(?:\})?}|(?:\\putbib)\[(?:\\subfix{)?([\s\S]+?)(?:\})?\]/gm

    let result: RegExpExecArray | null
    while ((result = bibReg.exec(fileCache.contentTrimmed)) !== null) {
        const bibs = (result[1] ? result[1] : result[2]).split(',').map(bib => bib.trim())

        for (const bib of bibs) {
            const bibPaths = await lw.file.getBibPath(bib, path.dirname(fileCache.filePath))
            for (const bibPath of bibPaths) {
                if (context.isExcluded(bibPath)) {
                    continue
                }
                // Store before registering the watcher because Watcher.add may
                // synchronously notify create handlers that read the cache.
                fileCache.bibfiles.add(bibPath)
                logger.log(`Bib ${bibPath} from ${fileCache.filePath} .`)
                const bibUri = lw.file.toUri(bibPath)
                if (!lw.watcher.bib.has(bibUri)) {
                    lw.watcher.bib.add(bibUri)
                }
            }
        }
    }
}

/** Scans `\GlsXtrLoadResources` and `\glsbibdata` glossary resource macros. */
async function updateGlossaryBibFiles(fileCache: FileCache, context: BibliographyContext): Promise<void> {
    const glossaryReg = /(?:\\GlsXtrLoadResources\s*\[.*?src=\{([^}]+)\}.*?\])|(?:\\glsbibdata(?:\[[^\]]*\])?\{([^}]*)\})/gs

    let result: RegExpExecArray | null
    while ((result = glossaryReg.exec(fileCache.contentTrimmed)) !== null) {
        const bibs = (result[1] ? result[1] : result[2]).split(',').map(bib => bib.trim())

        for (const bib of bibs) {
            const bibPaths = await lw.file.getBibPath(bib, path.dirname(fileCache.filePath))
            for (const bibPath of bibPaths) {
                if (!bibPath || context.isExcluded(bibPath)) {
                    continue
                }
                // Glossary resources have a separate owner Set and watcher from
                // classic BibTeX resources, even when both resolve to one file.
                fileCache.glossarybibfiles.add(bibPath)
                logger.log(`Glossary bib ${bibPath} from ${fileCache.filePath} .`)
                const bibUri = lw.file.toUri(bibPath)
                if (!lw.watcher.glossary.has(bibUri)) {
                    lw.watcher.glossary.add(bibUri)
                }
            }
        }
    }
}

/** Returns bibliography resources from the cached TeX graph in first-encounter order. */
export function getIncludedBib(filePath: string | undefined, context: BibliographyContext): string[] {
    return getIncludedBibGeneric('bibtex', filePath, context)
}

/** Returns glossary resources from the cached TeX graph in first-encounter order. */
export function getIncludedGlossaryBib(filePath: string | undefined, context: BibliographyContext): string[] {
    return getIncludedBibGeneric('glossary', filePath, context)
}

/**
 * Traverses only TeX child edges in depth-first order; XR external edges belong
 * to separate roots. checkedTeX prevents cycles, while final Set conversion
 * de-duplicates resources without changing their first encounter order.
 */
function getIncludedBibGeneric(
    bibType: 'bibtex' | 'glossary',
    filePath: string | undefined,
    context: BibliographyContext,
    includedBib: string[] = [],
    checkedTeX: string[] = []
): string[] {
    if (filePath === undefined) {
        return []
    }
    const fileCache = context.getCache(filePath)
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
        getIncludedBibGeneric(bibType, child.filePath, context, includedBib, checkedTeX)
    }
    return Array.from(new Set(includedBib))
}
