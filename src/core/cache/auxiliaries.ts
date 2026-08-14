import * as path from 'path'

import { lw } from '../../lw'
import type { FileCache } from '../../types'

const logger = lw.log('Cacher')

export type FlsContent = {
    input: string[],
    output: string[]
}

export type AuxContent = {
    bibdata: string[][]
}

/** Instance-bound operations used by auxiliary discovery until Phase 6. */
export type AuxiliaryContext = {
    getCache: (filePath: string) => FileCache | undefined,
    isExcluded: (filePath: string) => boolean,
    watchSource: (filePath: string) => void,
    refreshSource: (filePath: string, rootPath?: string) => Promise<void>
}

/** Parses unique FLS inputs and outputs in their first-encounter order. */
export function parseFlsContent(content: string, rootDir: string): FlsContent {
    const inputFiles = new Set<string>()
    const outputFiles = new Set<string>()
    const regex = /^(?:(INPUT)\s*(.*))|(?:(OUTPUT)\s*(.*))$/gm
    // Groups 1/2 describe INPUT entries and groups 3/4 describe OUTPUT entries.
    while (true) {
        const result = regex.exec(content)
        if (!result) {
            break
        }
        if (result[1]) {
            const inputFilePath = path.resolve(rootDir, result[2])
            if (inputFilePath) {
                inputFiles.add(inputFilePath)
            }
        } else if (result[3]) {
            const outputFilePath = path.resolve(rootDir, result[4])
            if (outputFilePath) {
                outputFiles.add(outputFilePath)
            }
        }
    }

    return {input: Array.from(inputFiles), output: Array.from(outputFiles)}
}

/** Preserves per-command grouping so empty bibdata commands can be reported. */
export function parseAuxContent(content: string): AuxContent {
    const bibdata: string[][] = []
    const regex = /^\\bibdata\{([^}]*)\}/gm
    let result: RegExpExecArray | null
    while ((result = regex.exec(content)) !== null) {
        bibdata.push(result[1]
            .split(',')
            .map(bib => bib.trim())
            .filter(bib => bib.length > 0)
        )
    }
    return {bibdata}
}

/**
 * Maps an AUX output directory back to its mirrored source directory. Mapping
 * is applied only inside the configured AUX root; unrelated outputs retain
 * their own directory instead of being corrupted by a string replacement.
 */
function getAuxSourceDir(outputFile: string, auxDir: string, rootDir: string): string {
    const outputDir = path.dirname(outputFile)
    const auxRoot = path.isAbsolute(auxDir) ? path.normalize(auxDir) : path.resolve(rootDir, auxDir)
    const relativeDir = path.relative(auxRoot, outputDir)
    const isOutsideAuxRoot = relativeDir === '..'
        || relativeDir.startsWith(`..${path.sep}`)
        || path.isAbsolute(relativeDir)
    return isOutsideAuxRoot ? outputDir : path.resolve(rootDir, relativeDir)
}

/**
 * Resolves bibdata commands, resource names, and matched paths serially so
 * insertion, logging, watcher registration, and failures retain source order.
 */
async function loadAuxFile(filePath: string, srcDir: string, ownerPath: string, context: AuxiliaryContext): Promise<void> {
    const content = parseAuxContent((await lw.file.read(filePath)) ?? '')
    for (const bibs of content.bibdata) {
        if (bibs.length === 0) {
            logger.log(`Empty \\bibdata in .aux ${filePath} , skip.`)
            continue
        }
        for (const bib of bibs) {
            const bibPaths = await lw.file.getBibPath(bib, srcDir)
            for (const bibPath of bibPaths) {
                if (context.isExcluded(bibPath)) {
                    continue
                }
                // AUX discoveries belong to the FLS owner captured by the
                // caller, never to mutable global-root state during this scan.
                const ownerCache = context.getCache(ownerPath)
                if (!ownerCache?.bibfiles.has(bibPath)) {
                    ownerCache?.bibfiles.add(bibPath)
                    logger.log(`Found .bib ${bibPath} from .aux ${filePath} .`)
                }
                const bibUri = lw.file.toUri(bibPath)
                if (!lw.watcher.bib.has(bibUri)) {
                    lw.watcher.bib.add(bibUri)
                }
            }
        }
    }
}

/**
 * Applies FLS inputs in source order before parsing AUX outputs. FLS-only TeX
 * children use MAX_VALUE so source-declared children retain precedence. Owner
 * recovery is awaited, while recursive child refresh stays fire-and-forget to
 * avoid cycles in the dependency graph.
 */
export async function loadFlsFile(filePath: string, context: AuxiliaryContext): Promise<void> {
    const flsPath = await lw.file.getFlsPath(filePath)
    if (flsPath === undefined) {
        return
    }
    logger.log(`Parsing .fls ${flsPath} .`)
    const rootDir = path.dirname(filePath)
    const auxDir = lw.file.getAuxDir(filePath)
    const ioFiles = parseFlsContent((await lw.file.read(flsPath)) ?? '', rootDir)

    for (const inputFile of ioFiles.input) {
        const inputUri = lw.file.toUri(inputFile)
        // OUTPUT overlap, ignore rules, and missing files are filtered before
        // watcher ownership and extension-specific handling.
        if (ioFiles.output.includes(inputFile) || context.isExcluded(inputFile) || !(await lw.file.exists(inputFile))) {
            continue
        }
        if (inputFile === filePath || lw.watcher.src.has(inputUri)) {
            continue
        }
        if (path.extname(inputFile).toLowerCase() === '.tex') {
            if (context.getCache(filePath) === undefined) {
                logger.log(`Cache not finished on ${filePath} when parsing fls, try re-cache.`)
                await context.refreshSource(filePath)
            }
            const fileCache = context.getCache(filePath)
            if (fileCache !== undefined) {
                fileCache.children.push({
                    index: Number.MAX_VALUE,
                    filePath: inputFile
                })
                context.watchSource(inputFile)
                logger.log(`Found ${inputFile} from .fls ${flsPath} , caching.`)
                void context.refreshSource(inputFile, filePath)
            } else {
                logger.log(`Cache not finished on ${filePath} when parsing fls.`)
            }
        } else {
            context.watchSource(inputFile)
        }
    }

    for (const outputFile of ioFiles.output) {
        if (path.extname(outputFile).toLowerCase() === '.aux' && (await lw.file.exists(outputFile))) {
            logger.log(`Found .aux ${outputFile} from .fls ${flsPath} , parsing.`)
            await loadAuxFile(outputFile, getAuxSourceDir(outputFile, auxDir, rootDir), filePath, context)
            logger.log(`Parsed .aux ${outputFile} .`)
        }
    }
    logger.log(`Parsed .fls ${flsPath} .`)
}

/** Returns every parsed FLS input without workflow filtering for root detection. */
export async function getFlsChildren(texFile: string): Promise<string[]> {
    const flsPath = await lw.file.getFlsPath(texFile)
    if (flsPath === undefined) {
        return []
    }
    const rootDir = path.dirname(texFile)
    return parseFlsContent((await lw.file.read(flsPath)) ?? '', rootDir).input
}
