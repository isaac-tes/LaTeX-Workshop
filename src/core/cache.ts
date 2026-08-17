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

    /**
     * Compatibility access to the mutable in-flight map. New code should rely
     * on refresh and wait behavior instead of observing this implementation
     * detail.
     *
     * @deprecated This property will be removed in Phase 8.
     */
    get promises(): Map<string, Promise<void>> {
        return this.store.promises
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

    /**
     * Determines if a file can be cached based on its extension and specific
     * exclusions.
     *
     * This function checks if a given file path has a TeX file extension with
     * lw.file.hasTeXExt and does not include the string 'expl3-code.tex'.
     *
     * @param {string} filePath - The path to the file to be checked for cache
     * eligibility.
     * @returns {boolean} - Returns `true` if the file can be cached, otherwise
     * `false`.
     */
    private canCache(filePath: string): boolean {
        return lw.file.hasTeXExt(path.extname(filePath)) && !filePath.includes('expl3-code.tex')
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
     * Adds a file to the watcher if it is not excluded and not already being
     * watched.
     *
     * This function checks if a given file path should be excluded from the
     * watcher. If the file is not excluded and is not already in the watcher, it
     * logs the addition and adds the file path to the source watcher. This function
     * will not automatically invoke `refreshCache` in the chain.
     *
     * @param {string} filePath - The path to the file to be added to the watcher.
     */
    add(filePath: string) {
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

    /**
     * Retrieves the cache data for a specified file path.
     *
     * This function looks up the cache for a given file path and returns the
     * corresponding `FileCache` object if it exists. If the file path is not found
     * in the cache, it returns `undefined`.
     *
     * @param {string} filePath - The path to the file whose cache data is to be
     * retrieved.
     * @returns {FileCache | undefined} - The `FileCache` object associated with the
     * file path, or `undefined` if not found.
     */
    get(filePath: string): FileCache | undefined {
        if (this.disposed) {
            return undefined
        }
        return this.store.get(filePath)
    }

    /**
     * Retrieves a list of all cached file paths.
     *
     * This function returns an array containing all the file paths currently stored
     * in the cache. It does this by converting the keys of the `caches` map, which
     * holds the cached file data, into an array.
     *
     * @returns {string[]} - An array of strings representing the file paths of all
     * cached files.
     */
    paths(): string[] {
        if (this.disposed) {
            return []
        }
        return this.store.paths()
    }

    /**
     * Waits for a file to be cached, with a specified timeout.
     *
     * This function monitors the caching status of a specified file path. It
     * continuously checks if the file has been cached by looking up its promise and
     * cache entries. If the file is not found in the cache within the default or
     * provided timeout duration, it forces the cache to refresh for the file. The
     * function waits in increments of 100 milliseconds, and if the total wait time
     * exceeds the specified timeout (default is 2 seconds), it logs an error
     * message and invokes the `refreshCache` function to cache the file forcibly.
     *
     * @param {string} filePath - The path to the file to wait for caching.
     * @param {number} [seconds=2] - The number of seconds to wait before forcing
     * the cache refresh.
     * @returns {Promise<void> | undefined} - A promise that resolves when the file
     * is cached, or undefined if the cache is not refreshed.
     */
    async wait(filePath: string, seconds: number = 2): Promise<Promise<void> | undefined> {
        this.assertActive()
        let waited = 0
        while (this.store.getInFlight(filePath) === undefined && this.get(filePath) === undefined) {
            // Just open vscode, has not cached, wait for a bit?
            await new Promise(resolve => setTimeout(resolve, 100))
            waited++
            if (waited >= seconds * 10) {
                // Waited for two seconds before starting cache. Really?
                logger.log(`Error loading cache: ${filePath} . Forcing.`)
                await this.refreshCache(filePath)
                break
            }
        }
        return this.store.getInFlight(filePath)
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
     * Resets the state of various watchers and clears the file cache.
     *
     * This function resets the source and bibliography watchers to their initial
     * states, ensuring that any ongoing file watching activities are terminated and
     * prepared for a fresh start. It iterates through all cached files and removes
     * them from the cache, effectively clearing all stored file data.
     */
    reset() {
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
     * Refreshes the cache for a given file, optionally considering a root path.
     *
     * This function is responsible for updating the cache of a file specified by
     * its path. It first checks if the file should be excluded or can be cached
     * based on predefined conditions. If the file is valid for caching, it logs the
     * caching action, increases the count of files being cached, and reads the
     * content of the file. The content is then processed to remove comments and
     * verbatim sections, and a `FileCache` object is created to store this
     * processed content along with other metadata. The function then updates the
     * children elements of the file cache and initiates the AST update. Once the
     * AST is updated, the elements of the file cache are also updated. Finally, it
     * performs lint checks, decreases the caching file count, removes the promise
     * from the active promises, fires a file parsed event, and reconstructs the
     * outline if no other files are being cached.
     *
     * @param {string} filePath - The path to the file to be cached.
     * @param {string} [rootPath] - The optional root path to be considered for
     * updating children elements.
     * @returns {Promise<void> | undefined} - A promise that resolves when the cache
     * is refreshed, or undefined if the file is excluded or cannot be cached.
     */
    async refreshCache(filePath: string, rootPath?: string): Promise<Promise<void> | undefined> {
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
            return activeTask
        }

        const task = this.runRefreshQueue(cacheKey, request)
            .finally(() => {
                this.pendingRefreshes.delete(cacheKey)
                this.store.deleteInFlight(filePath)
            })
        this.store.setInFlight(filePath, task)
        return task
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

    private isCurrent(request: RefreshRequest): boolean {
        const cacheKey = CacheStore.normalizePath(request.filePath)
        return !this.disposed && request.generation === this.generation &&
            request.revision === (this.pathRevisions.get(cacheKey) ?? 0)
    }

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
     * Refreshes the cache for a file aggressively based on the user's configuration
     * settings.
     *
     * This function checks if the specified file path has an existing cache entry.
     * If it does, and if the aggressive update setting
     * 'intellisense.update.aggressive.enabled' is enabled in the workspace
     * configuration, it schedules a cache refresh operation. If there is an
     * existing scheduled operation, it is cleared to prevent multiple refreshes
     * from overlapping. The refresh operation is then scheduled to run after a
     * delay specified in the configuration 'intellisense.update.delay'. During the
     * refresh, it also attempts to load the FLS file associated with the root path
     * or the file path.
     *
     * @param {string} filePath - The path to the file for which to refresh the
     * cache aggressively.
     */
    refreshCacheAggressive(filePath: string) {
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
     * precedes the existence check to preserve the existing ignored-file
     * short-circuit, while owner recovery is awaited before adding TeX children.
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

    /**
     * Retrieves a list of included bibliography files for a given file, ensuring
     * uniqueness.
     *
     * @param {string} [filePath] - The path to the file to check for included
     * bibliography files.
     * @returns {string[]} - An array of unique bibliography file paths included in
     * the specified file and its children.
     */
    getIncludedBib(filePath?: string): string[] {
        if (this.disposed) {
            return []
        }
        return bibliography.getIncludedBib(filePath ?? lw.root.file.path, cachePath => this.get(cachePath))
    }

    /**
     * Retrieves a list of included glossary bib files for a given file, ensuring
     * uniqueness.
     *
     * @param {string} [filePath] - The path to the file to check for included
     * bibliography files.
     * @returns {string[]} - An array of unique glossary bib file paths included in
     * the specified file and its children.
     */
    getIncludedGlossaryBib(filePath?: string): string[] {
        if (this.disposed) {
            return []
        }
        return bibliography.getIncludedGlossaryBib(filePath ?? lw.root.file.path, cachePath => this.get(cachePath))
    }

    /**
     * Retrieves a list of included TeX files, starting from a given file path.
     *
     * This function recursively gathers all TeX files included in a specified file,
     * starting from the provided file path or the root file path if none is
     * specified. It uses a depth-first search approach to traverse the file
     * dependencies and caches the results to avoid redundant processing.
     *
     * @param {string} [filePath] - The path to the starting file. Defaults to the
     * root file path.
     * @returns {string[]} - An array of paths to included TeX files.
     */
    getIncludedTeX(filePath?: string, includedTeX = new Set<string>()): Set<string> {
        if (this.disposed) {
            return new Set()
        }
        return dependencies.getIncludedTeX(filePath ?? lw.root.file.path, cachePath => this.get(cachePath), includedTeX)
    }

    /**
     * Retrieves the input file dependencies for a given TeX file from its FLS file.
     *
     * This function determines the path to the FLS file corresponding to a given
     * TeX file. If the FLS file path is found, it reads the content of the FLS file
     * and parses it to extract the list of input files. The function then returns
     * this list of input files, which represent the dependencies of the TeX file.
     *
     * @param {string} texFile - The path to the TeX file whose input file
     * dependencies are to be retrieved.
     * @returns {Promise<string[]>} - An array of strings representing the input
     * file dependencies of the TeX file.
     */
    async getFlsChildren(texFile: string): Promise<string[]> {
        this.assertActive()
        return auxiliaries.getFlsChildren(texFile)
    }
}

// The module owns the sole production instance. Additional instances are only
// for isolated tests and must be disposed by their callers.
export const cache = new Cache()
lw.onDispose(cache)
