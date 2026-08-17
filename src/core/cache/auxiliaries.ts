import * as path from 'path'

import { lw } from '../../lw'

const logger = lw.log('Cacher')

export type FlsContent = {
    input: string[],
    output: string[]
}

export type AuxContent = {
    bibdata: string[][]
}

export type AuxiliaryDiscovery =
    | { kind: 'input', filePath: string, flsPath: string, isTeX: boolean, ownerPath: string }
    | { kind: 'bibliography', filePath: string, auxPath: string, ownerPath: string }

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
 * yielded discoveries, logging, and failures retain source order.
 */
async function* discoverAuxFile(filePath: string, srcDir: string, ownerPath: string): AsyncGenerator<AuxiliaryDiscovery> {
    const content = parseAuxContent((await lw.file.read(filePath)) ?? '')
    for (const bibs of content.bibdata) {
        if (bibs.length === 0) {
            logger.log(`Empty \\bibdata in .aux ${filePath} , skip.`)
            continue
        }
        for (const bib of bibs) {
            const bibPaths = await lw.file.getBibPath(bib, path.dirname(ownerPath), srcDir)
            for (const bibPath of bibPaths) {
                yield {kind: 'bibliography', filePath: bibPath, auxPath: filePath, ownerPath}
            }
        }
    }
}

/**
 * Discovers FLS inputs in source order before parsing AUX outputs. Cache applies
 * each yielded event before requesting the next one, preserving partial
 * progress and the input-before-output workflow when a later operation fails.
 */
export async function* discoverFls(filePath: string): AsyncGenerator<AuxiliaryDiscovery> {
    const flsPath = await lw.file.getFlsPath(filePath)
    if (flsPath === undefined) {
        return
    }
    logger.log(`Parsing .fls ${flsPath} .`)
    const rootDir = path.dirname(filePath)
    const auxDir = lw.file.getAuxDir(filePath)
    const ioFiles = parseFlsContent((await lw.file.read(flsPath)) ?? '', rootDir)

    for (const inputFile of ioFiles.input) {
        if (ioFiles.output.includes(inputFile)) {
            continue
        }
        yield {
            kind: 'input',
            filePath: inputFile,
            flsPath,
            isTeX: path.extname(inputFile).toLowerCase() === '.tex',
            ownerPath: filePath
        }
    }

    for (const outputFile of ioFiles.output) {
        if (path.extname(outputFile).toLowerCase() === '.aux' && (await lw.file.exists(outputFile))) {
            logger.log(`Found .aux ${outputFile} from .fls ${flsPath} , parsing.`)
            yield* discoverAuxFile(outputFile, getAuxSourceDir(outputFile, auxDir, rootDir), filePath)
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
