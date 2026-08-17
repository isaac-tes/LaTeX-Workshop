import * as vscode from 'vscode'
import os from 'os'
import * as path from 'path'
import micromatch from 'micromatch'
import { performance } from 'perf_hooks'

import { lw } from '../lw'
import type { FileCache } from '../types'

import * as utils from '../utils/utils'
import * as auxiliaries from './cache/auxiliaries'
import * as bibliography from './cache/bibliography'
import * as dependencies from './cache/dependencies'
import { CacheStore } from './cache/store'

const logger = lw.log('Cacher')

type RefreshRequest = {
    filePath: string,
    rootPath: string | undefined,
    generation: number,
    revision: number
}

type RefreshStage = 'read' | 'dependencies' | 'ast' | 'completion' | 'bibliography' | 'commit'

type ExternalUpdate = {
    ownerPath: string,
    filePath: string,
    prefix: string
}

/**
 * Coordinates one independent cache state and its source-watcher subscriptions.
 * Every constructed instance must be disposed when its lifetime ends so its
 * callbacks cannot outlive the instance.
 */
export class Cache implements vscode.Disposable {
    private readonly store = new CacheStore()
    private readonly pendingRefreshes = new Map<string, RefreshRequest>()
    private readonly refreshDrafts = new Map<string, FileCache>()
    private readonly pathRevisions = new Map<string, number>()
    private generation = 0
    private readonly watcherSubscription: vscode.Disposable
    /** Coordinates the single outline reconstruction after current refreshes finish. */
    private cachingFilesCount = 0
    /** Records successful work until the last concurrent refresh queue settles. */
    private outlineDirty = false
    private readonly aggressiveRefreshTimers = new Map<string, NodeJS.Timeout>()
    private disposed = false

    constructor() {
        // Cache owns exactly the subscriptions that target this instance. This
        // keeps watcher behavior private while allowing tests to tear instances down.
        this.watcherSubscription = vscode.Disposable.from(
            lw.watcher.src.onChange(uri => this.handleWatchedFileChange(uri)),
            lw.watcher.src.onDelete(uri => this.handleWatchedFileDelete(uri))
        )
    }

    /** Handles a source change delivered by this instance's watcher subscription. */
    private handleWatchedFileChange(uri: vscode.Uri): void {
        const filePath = uri.fsPath
        if (this.canCache(filePath)) {
            this.runDetached(this.refreshCache(filePath), `watched refresh for ${filePath}`)
        }
    }

    /** Handles a source deletion delivered by this instance's watcher subscription. */
    private handleWatchedFileDelete(uri: vscode.Uri): void {
        const filePath = uri.fsPath
        this.invalidatePath(filePath)
        if (this.store.delete(filePath)) {
            logger.log(`Removed ${filePath} .`)
        }
    }

    /** Accepts supported TeX sources except the exact generated expl3 basename. */
    private canCache(filePath: string): boolean {
        const basename = filePath.includes('\\') ? path.win32.basename(filePath) : path.basename(filePath)
        return lw.file.hasTeXExt(path.extname(filePath)) && basename !== 'expl3-code.tex'
    }

    /**
     * Determines if a file path should be excluded based on ignore patterns.
     *
     * This function checks if a given file path matches any of the ignore patterns
     * specified in the workspace configuration. It retrieves the list of patterns
     * to ignore from the 'latex.watch.files.ignore' configuration and uses the
     * `micromatch` library to check if the file path matches any of these patterns.
     * The file path format is adjusted based on the operating system to ensure
     * compatibility.
     *
     * @param {string} filePath - The path to the file to be checked for exclusion.
     * @returns {boolean} - Returns `true` if the file path matches any ignore
     * patterns, otherwise `false`.
     */
    private isExcluded(filePath: string): boolean {
        const globsToIgnore = vscode.workspace.getConfiguration('latex-workshop').get('latex.watch.files.ignore') as string[]
        const format = (str: string): string => (os.platform() === 'win32' ? str.replace(/\\/g, '/') : str)
        return micromatch.some(filePath, globsToIgnore, { format })
    }

    /**
     * Registers a non-excluded source with the shared watcher without scheduling
     * a refresh. Throws after this instance has been disposed.
     */
    add(filePath: string): void {
        this.assertActive()
        if (this.isExcluded(filePath)) {
            logger.log(`Ignored ${filePath} .`)
            return
        }
        const uri = lw.file.toUri(filePath)
        if (!lw.watcher.src.has(uri)) {
            logger.log(`Adding ${filePath} .`)
            lw.watcher.src.add(uri)
        }
    }

    /** Returns the committed entry for a path, or undefined after disposal. */
    get(filePath: string): FileCache | undefined {
        if (this.disposed) {
            return undefined
        }
        return this.store.get(filePath)
    }

    /** Returns committed original paths in insertion order, or an empty list after disposal. */
    paths(): string[] {
        if (this.disposed) {
            return []
        }
        return this.store.paths()
    }

    /**
     * Waits for the current refresh of a file to finish. If no refresh starts
     * within the timeout, one is forced. The returned promise resolves only after
     * that final refresh queue settles and rejects when the refresh fails or this
     * instance has been disposed.
     */
    async wait(filePath: string, seconds: number = 2): Promise<void> {
        this.assertActive()
        let waited = 0
        while (this.store.getInFlight(filePath) === undefined && this.get(filePath) === undefined) {
            // Give startup caching a chance before forcing duplicate work.
            await new Promise(resolve => setTimeout(resolve, 100))
            waited++
            if (waited >= seconds * 10) {
                logger.log(`Error loading cache: ${filePath} . Forcing.`)
                await this.refreshCache(filePath)
                break
            }
        }
        await this.store.getInFlight(filePath)
    }

    /**
     * Releases this instance's watcher subscriptions, then performs the same
     * state cleanup as reset. Reset itself keeps subscriptions so a live cache
     * remains reusable.
     */
    dispose(): void {
        if (!this.disposed) {
            this.watcherSubscription.dispose()
            this.disposed = true
        }
        this.reset()
    }

    /**
     * Clears logical cache state, shared watcher entries, and pending timers while
     * keeping this instance's watcher subscriptions active for reuse. In-flight I/O
     * may finish, but generation invalidation prevents stale commits and events.
     */
    reset(): void {
        // Generation invalidation lets underlying I/O finish while preventing
        // work started before reset from mutating the new logical cache state.
        this.generation++
        this.pathRevisions.clear()
        this.pendingRefreshes.clear()
        this.refreshDrafts.clear()
        this.outlineDirty = false
        for (const timer of this.aggressiveRefreshTimers.values()) {
            clearTimeout(timer)
        }
        this.aggressiveRefreshTimers.clear()
        lw.watcher.src.reset()
        lw.watcher.bib.reset()
        lw.watcher.glossary.reset()
        // lw.watcher.pdf.reset()
        this.store.clear()
    }

    /**
     * Refreshes one cache entry and any same-file rerun queued while it is active.
     * The returned promise resolves after the final queued result is committed, or
     * immediately for an ineligible file, and rejects if the final refresh fails or
     * this instance has been disposed.
     */
    async refreshCache(filePath: string, rootPath?: string): Promise<void> {
        this.assertActive()
        if (this.isExcluded(filePath)) {
            logger.log(`File is excluded from caching: ${filePath} .`)
            return
        }
        if (!this.canCache(filePath)) {
            logger.log(`File cannot be cached: ${filePath} .`)
            return
        }
        const cacheKey = CacheStore.normalizePath(filePath)
        const request: RefreshRequest = {
            filePath,
            rootPath,
            generation: this.generation,
            revision: this.pathRevisions.get(cacheKey) ?? 0
        }
        const activeTask = this.store.getInFlight(filePath)
        if (activeTask !== undefined) {
            // Only the latest pending request matters because every queued caller
            // waits for the same queue to become stable.
            this.pendingRefreshes.set(cacheKey, request)
            await activeTask
            return
        }

        const task = this.runRefreshQueue(cacheKey, request)
            .finally(() => {
                this.pendingRefreshes.delete(cacheKey)
                this.store.deleteInFlight(filePath)
            })
        this.store.setInFlight(filePath, task)
        await task
    }

    /**
     * Serializes refreshes for one normalized path. Requests received during a
     * run collapse into one rerun, and the shared task settles only when no newer
     * request remains. Recursive child refreshes still remain fire-and-forget so
     * circular dependency graphs cannot create queue wait cycles.
     */
    private async runRefreshQueue(cacheKey: string, initialRequest: RefreshRequest): Promise<void> {
        this.cachingFilesCount++
        let request: RefreshRequest | undefined = initialRequest
        try {
            while (request !== undefined) {
                try {
                    await this.refreshFile(request)
                } catch (error) {
                    if (!this.pendingRefreshes.has(cacheKey)) {
                        throw error
                    }
                }
                request = this.pendingRefreshes.get(cacheKey)
                this.pendingRefreshes.delete(cacheKey)
            }
        } finally {
            this.cachingFilesCount--
            if (this.cachingFilesCount === 0 && this.outlineDirty) {
                this.outlineDirty = false
                this.runDetached(lw.outline.reconstruct(), 'outline reconstruction')
            }
        }
    }

    /**
     * Builds a private draft through fixed stages, then replaces the committed
     * cache exactly once. A failed stage leaves the previous successful cache in
     * place and cannot emit FileParsed. External-document changes are deferred to
     * the same commit boundary, while watcher and child scheduling remain
     * discovery side effects.
     */
    private async refreshFile(request: RefreshRequest): Promise<void> {
        const {filePath, rootPath} = request
        logger.log(`Caching ${filePath} .`)
        let stage: RefreshStage = 'read'
        const cacheKey = CacheStore.normalizePath(filePath)
        try {
            const openEditor: vscode.TextDocument | undefined = vscode.workspace.textDocuments.find(document => document.fileName === path.normalize(filePath))
            const content = openEditor?.isDirty ? openEditor.getText() : (await lw.file.read(filePath)) ?? ''
            if (!this.isCurrent(request)) {
                return
            }
            const fileCache: FileCache = {
                filePath,
                content,
                contentTrimmed: utils.stripCommentsAndVerbatim(content),
                elements: {},
                children: [],
                bibfiles: new Set(),
                glossarybibfiles: new Set(),
                external: {}
            }
            this.refreshDrafts.set(cacheKey, fileCache)
            const dependencyRoot = rootPath || lw.root.file.path || fileCache.filePath

            stage = 'dependencies'
            const externalUpdates = await this.applyDependencyDiscoveries(fileCache, dependencyRoot, request)
            if (!this.isCurrent(request)) {
                return
            }
            // Input scanners can yield macro families in separate passes. The
            // committed array follows textual indices; later FLS-only entries use
            // the MAX_VALUE sentinel and therefore remain at the end.
            fileCache.children.sort((first, second) => first.index - second.index)
            stage = 'ast'
            await this.updateAST(fileCache)
            if (!this.isCurrent(request)) {
                return
            }
            stage = 'completion'
            await this.updateElements(fileCache)
            stage = 'bibliography'
            await this.applyBibliographyDiscoveries(fileCache, path.dirname(dependencyRoot), request)
            if (!this.isCurrent(request)) {
                return
            }
            stage = 'commit'
            this.store.set(filePath, fileCache)
            for (const update of externalUpdates) {
                const ownerCache = this.getRefreshCache(update.ownerPath)
                if (ownerCache !== undefined) {
                    ownerCache.external[update.filePath] = update.prefix
                    logger.log(
                        `External document ${update.filePath} from ${filePath} .` +
                        (update.prefix ? ` Prefix is ${update.prefix}` : '')
                    )
                }
            }
            this.outlineDirty = true
            lw.event.fire(lw.event.FileParsed, filePath)
        } catch (error) {
            logger.log(`Failed caching ${filePath} at ${stage} stage: ${String(error)}`)
            throw error
        } finally {
            this.refreshDrafts.delete(cacheKey)
            lw.lint.label.check()
        }
    }

    /**
     * Applies dependency events as they are discovered so earlier mutations and
     * watcher registrations remain visible if a later path resolution fails.
     * Recursive refreshes are not awaited because circular TeX graphs would
     * otherwise make parent and child refreshes wait on each other.
     */
    private async applyDependencyDiscoveries(
        fileCache: FileCache,
        rootPath: string,
        request: RefreshRequest
    ): Promise<ExternalUpdate[]> {
        const externalUpdates: ExternalUpdate[] = []
        const source = {
            filePath: fileCache.filePath,
            contentTrimmed: fileCache.contentTrimmed,
            childPaths: fileCache.children.map(child => child.filePath)
        }
        for await (const discovery of dependencies.discoverDependencies(source, rootPath)) {
            if (!this.isCurrent(request)) {
                break
            }
            if (discovery.kind === 'input') {
                fileCache.children.push({index: discovery.index, filePath: discovery.filePath})
                logger.log(`Input ${discovery.filePath} from ${fileCache.filePath} .`)
            } else {
                // XR metadata belongs to the root even when declared in a child,
                // so mutation waits for this file's commit boundary.
                externalUpdates.push(discovery)
            }

            const uri = lw.file.toUri(discovery.filePath)
            if (lw.watcher.src.has(uri)) {
                continue
            }
            this.add(discovery.filePath)
            this.runDetached(
                this.refreshCache(discovery.filePath, discovery.rootPath),
                `dependency refresh for ${discovery.filePath}`
            )
        }
        return externalUpdates
    }

    /** Finds an active draft before falling back to committed cache state. */
    private getRefreshCache(filePath: string): FileCache | undefined {
        return this.refreshDrafts.get(CacheStore.normalizePath(filePath)) ?? this.get(filePath)
    }

    /** Accepts work only while both its whole-cache generation and path revision remain current. */
    private isCurrent(request: RefreshRequest): boolean {
        const cacheKey = CacheStore.normalizePath(request.filePath)
        return !this.disposed && request.generation === this.generation &&
            request.revision === (this.pathRevisions.get(cacheKey) ?? 0)
    }

    /** Invalidates one path without cancelling its underlying I/O. */
    private invalidatePath(filePath: string): void {
        const cacheKey = CacheStore.normalizePath(filePath)
        this.pathRevisions.set(cacheKey, (this.pathRevisions.get(cacheKey) ?? 0) + 1)
        this.pendingRefreshes.delete(cacheKey)
        this.refreshDrafts.delete(cacheKey)
        const timer = this.aggressiveRefreshTimers.get(cacheKey)
        if (timer !== undefined) {
            clearTimeout(timer)
            this.aggressiveRefreshTimers.delete(cacheKey)
        }
    }

    private assertActive(): void {
        if (this.disposed) {
            throw new Error('Cache instance has been disposed.')
        }
    }

    /** Prevents detached application work from becoming an unhandled rejection. */
    private runDetached(operation: Promise<unknown> | undefined, description: string): void {
        void Promise.resolve(operation).catch(error => logger.log(`Failed ${description}: ${String(error)}`))
    }

    /**
     * Debounces source and FLS refresh work independently per normalized path when
     * aggressive updates are enabled. Throws after disposal; detached failures are
     * logged by the scheduled callback.
     */
    refreshCacheAggressive(filePath: string): void {
        this.assertActive()
        if (this.get(filePath) === undefined) {
            return
        }
        const configuration = vscode.workspace.getConfiguration('latex-workshop')
        if (configuration.get('intellisense.update.aggressive.enabled')) {
            const cacheKey = CacheStore.normalizePath(filePath)
            const currentTimer = this.aggressiveRefreshTimers.get(cacheKey)
            if (currentTimer !== undefined) {
                clearTimeout(currentTimer)
            }
            // Each normalized path owns one timer, so activity in another file
            // cannot cancel its delayed refresh. Repeated requests replace only
            // this entry, and lifecycle invalidation clears the whole map.
            const timer = setTimeout(() => {
                this.aggressiveRefreshTimers.delete(cacheKey)
                this.runDetached(
                    this.runAggressiveRefresh(filePath),
                    `aggressive refresh for ${filePath}`
                )
            }, configuration.get('intellisense.update.delay', 1000))
            this.aggressiveRefreshTimers.set(cacheKey, timer)
        }
    }

    private async runAggressiveRefresh(filePath: string): Promise<void> {
        await this.refreshCache(filePath, lw.root.file.path)
        // A source refresh discards children known only through the FLS file, so
        // restore those dependencies after the coalesced source queue settles.
        await this.loadFlsFile(lw.root.file.path || filePath)
    }

    /**
     * Updates the Abstract Syntax Tree (AST) for a given file cache.
     *
     * This function is responsible for parsing the content of a file stored in the
     * file cache and updating its AST. It logs the start of the parsing process,
     * measures the time taken to parse the content, and logs the elapsed time once
     * the parsing is complete. The parsed AST is then stored in the `ast` property
     * of the `fileCache` object.
     *
     * @param {FileCache} fileCache - The file cache object containing the content
     * to be parsed.
     * @returns {Promise<void>} - A promise that resolves when the AST is updated.
     */
    private async updateAST(fileCache: FileCache): Promise<void> {
        logger.log(`Parse LaTeX AST: ${fileCache.filePath} .`)
        const start = performance.now()
        fileCache.ast = await lw.parser.parse.tex(fileCache.contentTrimmed)
        const elapsed = performance.now() - start
        logger.log(`Parsed LaTeX AST in ${elapsed.toFixed(2)} ms: ${fileCache.filePath} .`)
    }

    /**
     * Updates various elements in the file cache, parsing different components.
     *
     * This function updates the elements of a file cache by parsing various
     * components, namely, citations, packages, references, glossaries,
     * environments, macros, subscripts, superscripts, and graphics paths. It
     * records the time taken to perform these updates and logs the elapsed time
     * along with the file path. Each parsing step is performed in a specific order
     * to ensure dependencies are resolved correctly.
     *
     * @param {FileCache} fileCache - The cache object containing the file data and
     * metadata to be updated.
     */
    private updateElements(fileCache: FileCache): void {
        const start = performance.now()
        lw.completion.citation.parse(fileCache)
        // Package parsing must be before command and environment.
        lw.completion.usepackage.parse(fileCache)
        lw.completion.reference.parse(fileCache)
        lw.completion.glossary.parse(fileCache)
        lw.completion.environment.parse(fileCache)
        lw.completion.macro.parse(fileCache)
        lw.completion.subsuperscript.parse(fileCache)
        lw.completion.input.parseGraphicsPath(fileCache)
        const elapsed = performance.now() - start
        logger.log(`Updated elements in ${elapsed.toFixed(2)} ms: ${fileCache.filePath} .`)
    }

    /** Applies bibliography discoveries to their distinct Sets and watchers. */
    private async applyBibliographyDiscoveries(
        fileCache: FileCache,
        rootDir: string,
        request: RefreshRequest
    ): Promise<void> {
        const source = {filePath: fileCache.filePath, contentTrimmed: fileCache.contentTrimmed}
        for await (const discovery of bibliography.discoverBibliography(source, rootDir)) {
            if (!this.isCurrent(request)) {
                break
            }
            if ((discovery.kind === 'glossary' && !discovery.filePath) || this.isExcluded(discovery.filePath)) {
                continue
            }

            if (discovery.kind === 'bibtex') {
                // Store before registering the watcher because Watcher.add may
                // synchronously notify create handlers that read the cache.
                fileCache.bibfiles.add(discovery.filePath)
                logger.log(`Bib ${discovery.filePath} from ${fileCache.filePath} .`)
                const uri = lw.file.toUri(discovery.filePath)
                if (!lw.watcher.bib.has(uri)) {
                    lw.watcher.bib.add(uri)
                }
            } else {
                fileCache.glossarybibfiles.add(discovery.filePath)
                logger.log(`Glossary bib ${discovery.filePath} from ${fileCache.filePath} .`)
                const uri = lw.file.toUri(discovery.filePath)
                if (!lw.watcher.glossary.has(uri)) {
                    lw.watcher.glossary.add(uri)
                }
            }
        }
    }

    /**
     * Applies FLS inputs before AUX bibliography events. Exclusion deliberately
     * precedes the existence check, owner recovery is awaited before adding TeX
     * children, and every AUX bibliography result remains attached to the fixed
     * FLS owner. Throws after disposal.
     */
    async loadFlsFile(filePath: string): Promise<void> {
        this.assertActive()
        for await (const discovery of auxiliaries.discoverFls(filePath)) {
            if (discovery.kind === 'input') {
                if (this.isExcluded(discovery.filePath) || !(await lw.file.exists(discovery.filePath))) {
                    continue
                }
                const uri = lw.file.toUri(discovery.filePath)
                if (discovery.filePath === discovery.ownerPath || lw.watcher.src.has(uri)) {
                    continue
                }
                if (!discovery.isTeX) {
                    this.add(discovery.filePath)
                    continue
                }

                if (this.get(discovery.ownerPath) === undefined) {
                    logger.log(`Cache not finished on ${discovery.ownerPath} when parsing fls, try re-cache.`)
                    await this.refreshCache(discovery.ownerPath)
                }
                const ownerCache = this.get(discovery.ownerPath)
                if (ownerCache === undefined) {
                    logger.log(`Cache not finished on ${discovery.ownerPath} when parsing fls.`)
                    continue
                }
                const childKey = CacheStore.normalizePath(discovery.filePath)
                if (ownerCache.children.some(child => CacheStore.normalizePath(child.filePath) === childKey)) {
                    continue
                }
                ownerCache.children.push({index: Number.MAX_VALUE, filePath: discovery.filePath})
                this.add(discovery.filePath)
                logger.log(`Found ${discovery.filePath} from .fls ${discovery.flsPath} , caching.`)
                // Child refresh remains fire-and-forget to avoid circular waits.
                this.runDetached(
                    this.refreshCache(discovery.filePath, discovery.ownerPath),
                    `FLS child refresh for ${discovery.filePath}`
                )
                continue
            }

            if (this.isExcluded(discovery.filePath)) {
                continue
            }
            const ownerCache = this.get(discovery.ownerPath)
            if (ownerCache !== undefined && !ownerCache.bibfiles.has(discovery.filePath)) {
                ownerCache.bibfiles.add(discovery.filePath)
                logger.log(`Found .bib ${discovery.filePath} from .aux ${discovery.auxPath} .`)
            }
            const uri = lw.file.toUri(discovery.filePath)
            if (!lw.watcher.bib.has(uri)) {
                lw.watcher.bib.add(uri)
            }
        }
    }

    /** Returns unique BibTeX resources in depth-first graph order, or an empty list after disposal. */
    getIncludedBib(filePath?: string): string[] {
        if (this.disposed) {
            return []
        }
        return bibliography.getIncludedBib(filePath ?? lw.root.file.path, cachePath => this.get(cachePath))
    }

    /** Returns unique glossary resources in depth-first graph order, or an empty list after disposal. */
    getIncludedGlossaryBib(filePath?: string): string[] {
        if (this.disposed) {
            return []
        }
        return bibliography.getIncludedGlossaryBib(filePath ?? lw.root.file.path, cachePath => this.get(cachePath))
    }

    /** Returns TeX paths in depth-first graph order, or an empty Set after disposal. */
    getIncludedTeX(filePath?: string): Set<string> {
        if (this.disposed) {
            return new Set()
        }
        return dependencies.getIncludedTeX(filePath ?? lw.root.file.path, cachePath => this.get(cachePath))
    }

    /** Returns all parsed FLS inputs without cache filtering and rejects after disposal. */
    async getFlsChildren(texFile: string): Promise<string[]> {
        this.assertActive()
        return auxiliaries.getFlsChildren(texFile)
    }
}

// The module owns the sole production instance. Additional instances are only
// for isolated tests and must be disposed by their callers.
export const cache = new Cache()
lw.onDispose(cache)
