import * as vscode from 'vscode'
import os from 'os'
import * as path from 'path'
import { createRequire } from 'module'
import * as sinon from 'sinon'
import { assert, get, log, mock, set, sleep } from '../utils'
import { lw } from '../../../src/lw'
import * as cacheModule from '../../../src/core/cache'
import * as auxiliaries from '../../../src/core/cache/auxiliaries'
import * as bibliography from '../../../src/core/cache/bibliography'
import * as dependencies from '../../../src/core/cache/dependencies'

const {Cache, cache} = cacheModule
type CacheInstance = InstanceType<typeof Cache>

describe(path.basename(__filename).split('.')[0] + ':', () => {
    const fixture = get.fixture(__filename)
    // Drive the watcher's real dispatch path while exposing only the private hooks these characterization tests need.
    const sourceWatcherTestHooks = lw.watcher.src as unknown as {
        onDidChange: (event: 'create' | 'change', uri: vscode.Uri) => Promise<void>,
        onDidDelete: (uri: vscode.Uri) => Promise<void>
    }

    function deferred<T>() {
        let resolve!: (value: T | PromiseLike<T>) => void
        let reject!: (reason?: unknown) => void
        const promise = new Promise<T>((promiseResolve, promiseReject) => {
            resolve = promiseResolve
            reject = promiseReject
        })
        return {promise, resolve, reject}
    }

    async function waitFor(condition: () => boolean, timeout = 1000): Promise<void> {
        const started = Date.now()
        while (!condition()) {
            if (Date.now() - started >= timeout) {
                throw new Error('Timed out waiting for cache test condition.')
            }
            await sleep(10)
        }
    }

    before(() => {
        mock.init(lw, 'watcher', 'cache')
    })

    after(() => {
        sinon.restore()
    })

    describe('public module lifecycle', () => {
        it('should expose only the Cache class and production singleton', () => {
            assert.deepStrictEqual(Object.keys(cacheModule).sort(), ['Cache', 'cache'])
            assert.ok(cache instanceof Cache)
            assert.strictEqual(cache, lw.cache)
        })

        it('should isolate import-time subscriptions and extension disposal during a module reload', () => {
            const testRequire = createRequire(__filename)
            const cacheModulePath = testRequire.resolve('../../../src/core/cache')
            const cachedCacheModule = testRequire.cache[cacheModulePath]
            const changeDisposeSpy = sinon.spy()
            const deleteDisposeSpy = sinon.spy()
            const onChangeStub = sinon.stub(lw.watcher.src, 'onChange').returns(new vscode.Disposable(changeDisposeSpy))
            const onDeleteStub = sinon.stub(lw.watcher.src, 'onDelete').returns(new vscode.Disposable(deleteDisposeSpy))
            const onDisposeStub = lw.onDispose as sinon.SinonStub
            onDisposeStub.resetHistory()
            let isolatedCacheModule: typeof import('../../../src/core/cache') | undefined
            let resetStub: sinon.SinonStub | undefined
            let disposed = false

            // Intercept every import-time registration and restore the original
            // module entry so the reload cannot leak a second production instance.
            delete testRequire.cache[cacheModulePath]
            try {
                isolatedCacheModule = testRequire(cacheModulePath) as typeof import('../../../src/core/cache')
                const changeCallback = onChangeStub.firstCall.args[0] as (uri: vscode.Uri) => void
                const deleteCallback = onDeleteStub.firstCall.args[0] as (uri: vscode.Uri) => void
                const disposable = onDisposeStub.firstCall.args[0] as vscode.Disposable
                const unsupportedUri = vscode.Uri.file('/dev/null')
                resetStub = sinon.stub(isolatedCacheModule.cache, 'reset')

                assert.deepStrictEqual(Object.keys(isolatedCacheModule).sort(), ['Cache', 'cache'])
                assert.ok(isolatedCacheModule.cache instanceof isolatedCacheModule.Cache)
                assert.notStrictEqual(isolatedCacheModule.cache, lw.cache)
                sinon.assert.calledOnce(onChangeStub)
                sinon.assert.calledOnce(onDeleteStub)
                sinon.assert.calledOnceWithExactly(onDisposeStub, isolatedCacheModule.cache)

                changeCallback(unsupportedUri)
                deleteCallback(unsupportedUri)
                disposable.dispose()
                disposed = true

                sinon.assert.calledOnce(resetStub)
                sinon.assert.calledOnce(changeDisposeSpy)
                sinon.assert.calledOnce(deleteDisposeSpy)
            } finally {
                if (!disposed) {
                    isolatedCacheModule?.cache.dispose()
                }
                resetStub?.restore()
                delete testRequire.cache[cacheModulePath]
                if (cachedCacheModule) {
                    testRequire.cache[cacheModulePath] = cachedCacheModule
                }
                onChangeStub.restore()
                onDeleteStub.restore()
            }
        })

        it('should refresh a cacheable watched source when the watcher reports a change', async () => {
            const texPath = get.path(fixture, 'main.tex')
            const uri = vscode.Uri.file(texPath)
            const eventStub = lw.event.fire as sinon.SinonStub
            eventStub.resetHistory()
            const documentStub = mock.textDocument(texPath, '\\section{watched}', {isDirty: true})
            lw.cache.add(texPath)

            await sourceWatcherTestHooks.onDidChange('change', uri)
            documentStub.restore()
            await waitFor(() => eventStub.calledWith(lw.event.FileParsed, texPath))

            assert.strictEqual(lw.cache.get(texPath)?.content, '\\section{watched}')
        })

        it('should remove a cached source when the watcher confirms its deletion', async () => {
            const texPath = get.path(fixture, 'main.tex')
            const uri = vscode.Uri.file(texPath)
            set.config('latex.watch.delay', 0)
            lw.cache.add(texPath)
            await lw.cache.refreshCache(texPath)
            const existsStub = sinon.stub(lw.file, 'exists').resolves(false)

            await sourceWatcherTestHooks.onDidDelete(uri)
            existsStub.restore()

            assert.strictEqual(lw.cache.get(texPath), undefined)
            assert.hasLog(`Removed ${texPath} .`)
        })
    })

    describe('Cache instances', () => {
        it('should release owned watcher subscriptions before reset without registering extension disposal', () => {
            const changeDisposeSpy = sinon.spy()
            const deleteDisposeSpy = sinon.spy()
            const onChangeStub = sinon.stub(lw.watcher.src, 'onChange').returns(new vscode.Disposable(changeDisposeSpy))
            const onDeleteStub = sinon.stub(lw.watcher.src, 'onDelete').returns(new vscode.Disposable(deleteDisposeSpy))
            const onDisposeStub = lw.onDispose as sinon.SinonStub
            onDisposeStub.resetHistory()
            let instance: CacheInstance | undefined
            let resetStub: sinon.SinonStub | undefined
            let disposed = false

            try {
                instance = new Cache()
                resetStub = sinon.stub(instance, 'reset').callsFake(() => {
                    sinon.assert.calledOnce(changeDisposeSpy)
                    sinon.assert.calledOnce(deleteDisposeSpy)
                })

                sinon.assert.calledOnce(onChangeStub)
                sinon.assert.calledOnce(onDeleteStub)
                sinon.assert.notCalled(onDisposeStub)
                instance.dispose()
                disposed = true

                sinon.assert.calledOnce(resetStub)
            } finally {
                if (!disposed) {
                    instance?.dispose()
                }
                resetStub?.restore()
                onChangeStub.restore()
                onDeleteStub.restore()
            }
        })

        it('should preserve subscriptions across reset and remove only the disposed instance callbacks', () => {
            type Handler = (uri: vscode.Uri) => void
            const changeHandlers = new Set<Handler>()
            const deleteHandlers = new Set<Handler>()
            const onChangeStub = sinon.stub(lw.watcher.src, 'onChange').callsFake(handler => {
                changeHandlers.add(handler)
                return new vscode.Disposable(() => changeHandlers.delete(handler))
            })
            const onDeleteStub = sinon.stub(lw.watcher.src, 'onDelete').callsFake(handler => {
                deleteHandlers.add(handler)
                return new vscode.Disposable(() => deleteHandlers.delete(handler))
            })
            const first = new Cache()
            const second = new Cache()
            const firstRefresh = sinon.stub(first, 'refreshCache').resolves()
            const secondRefresh = sinon.stub(second, 'refreshCache').resolves()
            const uri = vscode.Uri.file(get.path(fixture, 'main.tex'))
            let firstDisposed = false

            try {
                first.reset()
                assert.strictEqual(changeHandlers.size, 2)
                assert.strictEqual(deleteHandlers.size, 2)

                changeHandlers.forEach(handler => handler(uri))
                sinon.assert.calledOnceWithExactly(firstRefresh, uri.fsPath)
                sinon.assert.calledOnceWithExactly(secondRefresh, uri.fsPath)

                first.dispose()
                firstDisposed = true
                assert.strictEqual(changeHandlers.size, 1)
                assert.strictEqual(deleteHandlers.size, 1)
                firstRefresh.resetHistory()
                secondRefresh.resetHistory()

                changeHandlers.forEach(handler => handler(uri))
                sinon.assert.notCalled(firstRefresh)
                sinon.assert.calledOnceWithExactly(secondRefresh, uri.fsPath)
            } finally {
                if (!firstDisposed) {
                    first.dispose()
                }
                second.dispose()
                onChangeStub.restore()
                onDeleteStub.restore()
            }
        })

        it('should keep cache and in-flight state independent between instances', async () => {
            const first = new Cache()
            const second = new Cache()
            const texPath = get.path(fixture, 'main.tex')
            const anotherPath = get.path(fixture, 'another.tex')

            try {
                await first.refreshCache(texPath)
                await second.refreshCache(anotherPath)

                assert.ok(first.get(texPath))
                assert.strictEqual(second.get(texPath), undefined)
                assert.strictEqual(first.get(anotherPath), undefined)
                assert.ok(second.get(anotherPath))
                assert.notStrictEqual(first.promises, second.promises)

                first.reset()
                assert.listStrictEqual(first.paths(), [])
                assert.listStrictEqual(second.paths(), [anotherPath])
            } finally {
                first.dispose()
                second.dispose()
            }
        })
    })

    describe('lw.cache.isExcluded', () => {
        const texPath = get.path(fixture, 'main.tex')
        const bblPath = get.path(fixture, 'main.bbl')

        it('should excluded files', async () => {
            log.start()
            await lw.cache.refreshCache(bblPath)
            log.stop()
            assert.hasLog(`File is excluded from caching: ${bblPath} .`)

            log.start()
            await lw.cache.refreshCache('/dev/null')
            log.stop()
            assert.hasLog('File is excluded from caching: /dev/null .')
        })

        it('should not exclude non-excluded files', async () => {
            await lw.cache.refreshCache(texPath)
            assert.notHasLog(`File is excluded from caching: ${texPath} .`)
        })

        it('should excluded files with config set ', async () => {
            set.config('latex.watch.files.ignore', ['**/*.bbl'])

            log.start()
            await lw.cache.refreshCache(bblPath)
            log.stop()
            assert.hasLog(`File is excluded from caching: ${bblPath} .`)

            log.start()
            await lw.cache.refreshCache('/dev/null')
            log.stop()
            assert.notHasLog('File is excluded from caching: /dev/null .')
        })

        it('should normalize Windows paths before matching ignore globs', async () => {
            const platformStub = sinon.stub(os, 'platform').returns('win32')
            set.config('latex.watch.files.ignore', ['C:/ignored/*.tex'])

            await lw.cache.refreshCache('C:\\ignored\\main.tex')
            platformStub.restore()

            assert.hasLog('File is excluded from caching: C:\\ignored\\main.tex .')
        })
    })

    describe('lw.cache.canCache', () => {
        beforeEach(() => {
            set.config('latex.watch.files.ignore', [])
        })

        it('should cache supported TeX files', async () => {
            const texPath = get.path(fixture, 'main.tex')

            log.start()
            await lw.cache.refreshCache(texPath)
            log.stop()
            assert.notHasLog(`File cannot be cached: ${texPath} .`)

            log.start()
            await lw.cache.refreshCache(get.path(fixture, 'main.rnw'))
            log.stop()
            assert.notHasLog(`File cannot be cached: ${get.path(fixture, 'main.rnw')} .`)

            log.start()
            await lw.cache.refreshCache(get.path(fixture, 'main.jnw'))
            log.stop()
            assert.notHasLog(`File cannot be cached: ${get.path(fixture, 'main.jnw')} .`)

            log.start()
            await lw.cache.refreshCache(get.path(fixture, 'main.pnw'))
            log.stop()
            assert.notHasLog(`File cannot be cached: ${get.path(fixture, 'main.pnw')} .`)
        })

        it('should return false for unsupported files', async () => {
            log.start()
            await lw.cache.refreshCache(get.path(fixture, 'main.cls'))
            log.stop()
            assert.hasLog(`File cannot be cached: ${get.path(fixture, 'main.cls')} .`)

            log.start()
            await lw.cache.refreshCache(get.path(fixture, 'main.sty'))
            log.stop()
            assert.hasLog(`File cannot be cached: ${get.path(fixture, 'main.sty')} .`)

            log.start()
            await lw.cache.refreshCache(get.path(fixture, 'main.txt'))
            log.stop()
            assert.hasLog(`File cannot be cached: ${get.path(fixture, 'main.txt')} .`)
        })

        it('should return false for expl3-code.tex', async () => {
            await lw.cache.refreshCache(get.path(fixture, 'expl3-code.tex'))
            assert.hasLog(`File cannot be cached: ${get.path(fixture, 'expl3-code.tex')} .`)
        })
    })

    describe('lw.cache.add', () => {
        it('should add a TeX file to watcher if not excluded', () => {
            const texPath = get.path(fixture, 'main.tex')

            lw.cache.add(texPath)
            assert.ok(lw.watcher.src.has(vscode.Uri.file(texPath)))
        })

        it('should ignore excluded files', () => {
            const bblPath = get.path(fixture, 'main.bbl')

            lw.cache.add(bblPath)
            assert.ok(!lw.watcher.src.has(vscode.Uri.file(bblPath)))
        })

        it('should add a file to watcher but not cache it', () => {
            const texPath = get.path(fixture, 'main.tex')

            lw.cache.add(texPath)
            assert.strictEqual(lw.cache.promises.get(texPath), undefined)
        })
    })

    describe('lw.cache.get', () => {
        it('should get the cache for a TeX file if exist', async () => {
            const texPath = get.path(fixture, 'main.tex')

            lw.cache.add(texPath)
            await lw.cache.refreshCache(texPath)
            assert.ok(lw.cache.get(texPath))
        })

        it('should get undefined if a TeX file is not cached', () => {
            const texPath = get.path(fixture, 'main.tex')

            assert.ok(!lw.cache.get(texPath))
        })
    })

    describe('lw.cache.paths', () => {
        it('should get the paths of cached files', async () => {
            const texPath = get.path(fixture, 'main.tex')
            const texPathAnother = get.path(fixture, 'another.tex')

            lw.cache.add(texPath)
            lw.cache.add(texPathAnother)
            await lw.cache.refreshCache(texPath)
            await lw.cache.refreshCache(texPathAnother)
            const paths = lw.cache.paths()
            assert.listStrictEqual(paths, [texPath, texPathAnother])
        })

        it('should get an empty array if no files are cached', () => {
            assert.listStrictEqual(lw.cache.paths(), [])
        })
    })

    describe('lw.cache.wait', () => {
        it('should wait for finishing current caching', async () => {
            const texPath = get.path(fixture, 'main.tex')

            lw.cache.add(texPath)
            void lw.cache.refreshCache(texPath)
            await lw.cache.wait(texPath)
            assert.ok(lw.cache.get(texPath))
        })

        it('should initiate a caching if not already cached', async () => {
            const texPath = get.path(fixture, 'main.tex')

            await lw.cache.wait(texPath, 0.2)
            assert.ok(lw.cache.get(texPath))
        })

        it('should handle concurrent caching', async () => {
            const texPath = get.path(fixture, 'main.tex')

            const wait = lw.cache.wait(texPath)
            void lw.cache.refreshCache(texPath)
            await wait
            assert.ok(lw.cache.get(texPath))
        })
    })

    describe('lw.cache.reset', () => {
        it('should reset the src and bib watchers, but not pdf', () => {
            const texPath = get.path(fixture, 'main.tex')
            const bibPath = get.path(fixture, 'main.bib')
            const pdfPath = get.path(fixture, 'main.pdf')

            lw.watcher.src.add(vscode.Uri.file(texPath))
            lw.watcher.bib.add(vscode.Uri.file(bibPath))
            lw.watcher.pdf.add(vscode.Uri.file(pdfPath))
            lw.cache.reset()
            assert.ok(!lw.watcher.src.has(vscode.Uri.file(texPath)))
            assert.ok(!lw.watcher.bib.has(vscode.Uri.file(bibPath)))
            assert.ok(lw.watcher.pdf.has(vscode.Uri.file(pdfPath)))
        })

        it('should reset the cache', async () => {
            const texPath = get.path(fixture, 'main.tex')

            lw.cache.add(texPath)
            await lw.cache.refreshCache(texPath)
            lw.cache.reset()
            assert.listStrictEqual(lw.cache.paths(), [])
        })
    })

    describe('lw.cache.refreshCache', () => {
        it('should properly exclude configged sources', async () => {
            const bblPath = get.path(fixture, 'main.bbl')

            await lw.cache.refreshCache(bblPath)
            assert.listStrictEqual(lw.cache.paths(), [])
        })

        it('should properly skip non-cacheable sources', async () => {
            await lw.cache.refreshCache(get.path(fixture, 'expl3-code.tex'))
            assert.listStrictEqual(lw.cache.paths(), [])
        })

        it('should cache provided TeX source', async () => {
            const texPath = get.path(fixture, 'main.tex')

            await lw.cache.refreshCache(texPath)
            assert.listStrictEqual(lw.cache.paths(), [texPath])
        })

        it('should apply dependency discoveries through the owning instance', async () => {
            const texPath = get.path(fixture, 'main.tex')
            const instance = new Cache()
            const childPath = '/phase6/child.tex'
            const watchedPath = '/phase6/watched.tex'
            const externalPath = '/phase6/external.tex'
            const unprefixedPath = '/phase6/unprefixed.tex'
            const missingOwnerPath = '/phase6/missing-owner.tex'
            lw.watcher.src.add(vscode.Uri.file(watchedPath))
            const discoverStub = sinon.stub(dependencies, 'discoverDependencies').callsFake(async function* () {
                await Promise.resolve()
                yield {kind: 'input' as const, filePath: childPath, index: 7, rootPath: texPath}
                yield {kind: 'input' as const, filePath: watchedPath, index: 8, rootPath: texPath}
                yield {
                    kind: 'external' as const,
                    filePath: externalPath,
                    prefix: 'xr-',
                    ownerPath: texPath,
                    rootPath: externalPath
                }
                yield {
                    kind: 'external' as const,
                    filePath: unprefixedPath,
                    prefix: '',
                    ownerPath: texPath,
                    rootPath: unprefixedPath
                }
                yield {
                    kind: 'external' as const,
                    filePath: missingOwnerPath,
                    prefix: '',
                    ownerPath: '/phase6/not-cached.tex',
                    rootPath: missingOwnerPath
                }
            })
            const originalRefresh = instance.refreshCache.bind(instance)
            const refreshStub = sinon.stub(instance, 'refreshCache').resolves()
            const addStub = sinon.stub(instance, 'add')

            try {
                await originalRefresh(texPath)
                const fileCache = instance.get(texPath)
                assert.deepStrictEqual(fileCache?.children, [
                    {filePath: childPath, index: 7},
                    {filePath: watchedPath, index: 8}
                ])
                assert.deepStrictEqual(fileCache?.external, {[externalPath]: 'xr-', [unprefixedPath]: ''})
                assert.strictEqual(discoverStub.firstCall.args[0].filePath, texPath)
                assert.strictEqual(discoverStub.firstCall.args[1], texPath)
                assert.deepStrictEqual(addStub.args.map(args => args[0]), [
                    childPath, externalPath, unprefixedPath, missingOwnerPath
                ])
                assert.deepStrictEqual(refreshStub.args, [
                    [childPath, texPath],
                    [externalPath, externalPath],
                    [unprefixedPath, unprefixedPath],
                    [missingOwnerPath, missingOwnerPath]
                ])
            } finally {
                discoverStub.restore()
                instance.dispose()
            }
        })

        it('should update AST during caching', async () => {
            const texPath = get.path(fixture, 'main.tex')

            await lw.cache.refreshCache(texPath)
            assert.hasLog('Parsed LaTeX AST in ')
        })

        it('should apply bibliography discoveries through the owning instance', async () => {
            const texPath = get.path(fixture, 'main.tex')
            const bibPath = get.path(fixture, 'main.bib')
            const excludedPath = '/phase6/excluded.bib'
            const instance = new Cache()
            set.config('latex.watch.files.ignore', ['**/excluded.bib'])
            const discoverStub = sinon.stub(bibliography, 'discoverBibliography').callsFake(async function* () {
                await Promise.resolve()
                yield {kind: 'bibtex' as const, filePath: bibPath}
                yield {kind: 'bibtex' as const, filePath: bibPath}
                yield {kind: 'bibtex' as const, filePath: excludedPath}
                yield {kind: 'glossary' as const, filePath: ''}
                yield {kind: 'glossary' as const, filePath: bibPath}
                yield {kind: 'glossary' as const, filePath: bibPath}
            })

            try {
                await instance.refreshCache(texPath)
                assert.deepStrictEqual([...instance.get(texPath)!.bibfiles], [bibPath])
                assert.deepStrictEqual([...instance.get(texPath)!.glossarybibfiles], [bibPath])
                assert.strictEqual(discoverStub.firstCall.args[0].filePath, texPath)
                assert.strictEqual(discoverStub.firstCall.args[1], path.dirname(texPath))
                assert.ok(lw.watcher.bib.has(vscode.Uri.file(bibPath)))
                assert.ok(lw.watcher.glossary.has(vscode.Uri.file(bibPath)))
            } finally {
                discoverStub.restore()
                instance.dispose()
            }
        })

        it('should cache provided dirty TeX source', async () => {
            const texPath = get.path(fixture, 'main.tex')
            const stub = mock.textDocument(texPath, '', { isDirty: true })

            await lw.cache.refreshCache(texPath)
            stub.restore()
            assert.listStrictEqual(lw.cache.paths(), [texPath])
            assert.strictEqual(lw.cache.get(texPath)?.content, '')
        })

        it('should manage caching promises properly', async () => {
            const texPath = get.path(fixture, 'main.tex')

            await lw.cache.refreshCache(texPath)
            assert.ok(!lw.cache.promises.get(texPath))
        })

        it('should refresh cache if content is changed', async () => {
            const texPath = get.path(fixture, 'main.tex')

            await lw.cache.refreshCache(texPath)
            assert.strictEqual(lw.cache.get(lw.cache.paths()[0])?.content, '%')
            const stub = mock.textDocument(texPath, '', { isDirty: true })
            await lw.cache.refreshCache(texPath)
            stub.restore()
            assert.strictEqual(lw.cache.get(lw.cache.paths()[0])?.content, '')
        })

        it('should keep a partial cache and emit completion side effects when AST parsing fails', async () => {
            const texPath = get.path(fixture, 'main.tex')
            const parseStub = lw.parser.parse.tex as sinon.SinonStub
            const eventStub = lw.event.fire as sinon.SinonStub
            const outlineStub = lw.outline.reconstruct as sinon.SinonStub
            parseStub.reset()
            eventStub.resetHistory()
            outlineStub.resetHistory()
            parseStub.rejects(new Error('characterized parse failure'))

            try {
                await assert.rejects(lw.cache.refreshCache(texPath), /characterized parse failure/)

                const cached = lw.cache.get(texPath)
                assert.strictEqual(cached?.content, '%')
                assert.strictEqual(cached?.ast, undefined)
                assert.deepStrictEqual(cached?.elements, {})
                assert.strictEqual(lw.cache.promises.get(texPath), undefined)
                sinon.assert.calledWith(eventStub, lw.event.FileParsed, texPath)
                sinon.assert.calledOnce(outlineStub)
            } finally {
                parseStub.reset()
            }
        })

        it('should run same-file refreshes concurrently and let an earlier task clear the shared promise entry', async () => {
            const texPath = get.path(fixture, 'main.tex')
            const parseStub = lw.parser.parse.tex as sinon.SinonStub
            const firstParse = deferred<any>()
            const secondParse = deferred<any>()
            parseStub.reset()
            parseStub.onFirstCall().returns(firstParse.promise)
            parseStub.onSecondCall().returns(secondParse.promise)

            let firstRefresh: ReturnType<typeof lw.cache.refreshCache> | undefined
            let secondRefresh: ReturnType<typeof lw.cache.refreshCache> | undefined
            try {
                let documentStub = mock.textDocument(texPath, '\\section{first}', {isDirty: true})
                firstRefresh = lw.cache.refreshCache(texPath)
                documentStub.restore()

                documentStub = mock.textDocument(texPath, '\\section{second}', {isDirty: true})
                secondRefresh = lw.cache.refreshCache(texPath)
                documentStub.restore()

                await waitFor(() => parseStub.callCount === 2)
                assert.strictEqual(lw.cache.get(texPath)?.content, '\\section{second}')
                assert.ok(lw.cache.promises.has(texPath))

                firstParse.resolve(undefined)
                await firstRefresh

                assert.strictEqual(lw.cache.promises.get(texPath), undefined)
                assert.strictEqual(lw.cache.get(texPath)?.content, '\\section{second}')

                secondParse.resolve(undefined)
                await secondRefresh
            } finally {
                firstParse.resolve(undefined)
                secondParse.resolve(undefined)
                if (firstRefresh && secondRefresh) {
                    await Promise.allSettled([firstRefresh, secondRefresh])
                }
                parseStub.reset()
            }
        })

        it('should keep refresh completion side effects after reset removes an in-progress cache', async () => {
            const texPath = get.path(fixture, 'main.tex')
            const parseStub = lw.parser.parse.tex as sinon.SinonStub
            const eventStub = lw.event.fire as sinon.SinonStub
            const pendingParse = deferred<any>()
            parseStub.reset()
            eventStub.resetHistory()
            parseStub.returns(pendingParse.promise)

            let refresh: ReturnType<typeof lw.cache.refreshCache> | undefined
            try {
                refresh = lw.cache.refreshCache(texPath)
                await waitFor(() => parseStub.calledOnce)
                assert.ok(lw.cache.get(texPath))
                assert.ok(lw.cache.promises.has(texPath))

                lw.cache.reset()

                assert.strictEqual(lw.cache.get(texPath), undefined)
                assert.ok(lw.cache.promises.has(texPath))

                pendingParse.resolve(undefined)
                await refresh

                assert.strictEqual(lw.cache.get(texPath), undefined)
                sinon.assert.calledWith(eventStub, lw.event.FileParsed, texPath)
            } finally {
                pendingParse.resolve(undefined)
                if (refresh) {
                    await Promise.allSettled([refresh])
                }
                parseStub.reset()
            }
        })

        it('should keep refresh completion side effects after deletion removes an in-progress cache', async () => {
            const texPath = get.path(fixture, 'main.tex')
            const uri = vscode.Uri.file(texPath)
            const parseStub = lw.parser.parse.tex as sinon.SinonStub
            const eventStub = lw.event.fire as sinon.SinonStub
            const pendingParse = deferred<any>()
            parseStub.reset()
            eventStub.resetHistory()
            parseStub.returns(pendingParse.promise)
            set.config('latex.watch.delay', 0)
            lw.cache.add(texPath)

            let refresh: ReturnType<typeof lw.cache.refreshCache> | undefined
            let existsStub: sinon.SinonStub | undefined
            try {
                refresh = lw.cache.refreshCache(texPath)
                await waitFor(() => parseStub.calledOnce)
                existsStub = sinon.stub(lw.file, 'exists').resolves(false)

                await sourceWatcherTestHooks.onDidDelete(uri)

                assert.strictEqual(lw.cache.get(texPath), undefined)
                assert.ok(lw.cache.promises.has(texPath))

                pendingParse.resolve(undefined)
                await refresh

                assert.strictEqual(lw.cache.get(texPath), undefined)
                sinon.assert.calledWith(eventStub, lw.event.FileParsed, texPath)
            } finally {
                existsStub?.restore()
                pendingParse.resolve(undefined)
                if (refresh) {
                    await Promise.allSettled([refresh])
                }
                parseStub.reset()
            }
        })
    })

    describe('lw.cache.refreshCacheAggressive', () => {
        beforeEach(() => {
            set.config('intellisense.update.aggressive.enabled', true)
            set.config('intellisense.update.delay', 100)
        })

        it('should not aggressively cache non-cached files', async () => {
            const texPath = get.path(fixture, 'main.tex')

            lw.cache.refreshCacheAggressive(texPath)
            await sleep(150)
            assert.listStrictEqual(lw.cache.paths(), [])
        })

        it('should aggressively cache cached files', async () => {
            const texPath = get.path(fixture, 'main.tex')

            lw.cache.add(texPath)
            await lw.cache.refreshCache(texPath)

            let stub = mock.textDocument(texPath, '', { isDirty: true })
            lw.cache.refreshCacheAggressive(texPath)
            await sleep(50)
            stub.restore()
            assert.strictEqual(lw.cache.get(lw.cache.paths()[0])?.content, '%')

            stub = mock.textDocument(texPath, '', { isDirty: true })
            await sleep(100)
            stub.restore()
            assert.strictEqual(lw.cache.get(lw.cache.paths()[0])?.content, '')
        })

        it('should reload .fls file when aggressively caching cached files', async () => {
            const texPath = get.path(fixture, 'main.tex')

            lw.cache.add(texPath)
            await lw.cache.refreshCache(texPath)

            const stub = mock.textDocument(texPath, '', { isDirty: true })
            lw.cache.refreshCacheAggressive(texPath)
            await sleep(250)
            stub.restore()
            assert.hasLog('Parsing .fls ')
        })

        it('should not aggressively cache cached files without `intellisense.update.aggressive.enabled`', async () => {
            const texPath = get.path(fixture, 'main.tex')

            set.config('intellisense.update.aggressive.enabled', false)
            lw.cache.add(texPath)
            await lw.cache.refreshCache(texPath)
            const stub = mock.textDocument(texPath, '', { isDirty: true })
            lw.cache.refreshCacheAggressive(texPath)
            await sleep(150)
            stub.restore()
            assert.strictEqual(lw.cache.get(lw.cache.paths()[0])?.content, '%')
        })

        it('should aggressively cache cached files once on quick changes', async () => {
            const texPath = get.path(fixture, 'main.tex')

            lw.cache.add(texPath)
            await lw.cache.refreshCache(texPath)

            let stub = mock.textDocument(texPath, '', { isDirty: true })
            lw.cache.refreshCacheAggressive(texPath)
            await sleep(50)
            stub.restore()
            assert.strictEqual(lw.cache.get(lw.cache.paths()[0])?.content, '%')

            stub = mock.textDocument(texPath, '%%', { isDirty: true })
            lw.cache.refreshCacheAggressive(texPath)
            await sleep(50)
            stub.restore()
            assert.strictEqual(lw.cache.get(lw.cache.paths()[0])?.content, '%')

            stub = mock.textDocument(texPath, '%%', { isDirty: true })
            await sleep(100)
            stub.restore()
            assert.strictEqual(lw.cache.get(lw.cache.paths()[0])?.content, '%%')
        })

        it('should aggressively cache cached files multiple times on slow changes', async () => {
            const texPath = get.path(fixture, 'main.tex')

            lw.cache.add(texPath)
            await lw.cache.refreshCache(texPath)

            let stub = mock.textDocument(texPath, '', { isDirty: true })
            lw.cache.refreshCacheAggressive(texPath)
            await sleep(150)
            stub.restore()
            assert.strictEqual(lw.cache.get(lw.cache.paths()[0])?.content, '')

            stub = mock.textDocument(texPath, '%%', { isDirty: true })
            lw.cache.refreshCacheAggressive(texPath)
            await sleep(150)
            stub.restore()
            assert.strictEqual(lw.cache.get(lw.cache.paths()[0])?.content, '%%')
        })
    })

    describe('lw.cache.updateAST', () => {
        it('should call lw.parser.parse.tex to parse AST', async () => {
            const texPath = get.path(fixture, 'main.tex')

            ;(lw.parser.parse.tex as sinon.SinonStub).reset()
            await lw.cache.refreshCache(texPath)
            assert.hasLog(`Parse LaTeX AST: ${texPath} .`)
            assert.strictEqual((lw.parser.parse.tex as sinon.SinonStub).callCount, 1)
        })
    })

    describe('lw.cache auxiliary coordination', () => {
        it('should apply FLS discoveries and forward raw child queries', async () => {
            const owner = get.path(fixture, 'main.tex')
            const child = '/phase6/fls-child.tex'
            const input = '/phase6/generated.out'
            const bib = get.path(fixture, 'main.bib')
            set.config('latex.watch.files.ignore', [])
            await lw.cache.refreshCache(owner)
            const discoverStub = sinon.stub(auxiliaries, 'discoverFls').callsFake(async function* () {
                await Promise.resolve()
                yield {kind: 'input' as const, filePath: child, flsPath: '/phase6/main.fls', isTeX: true, ownerPath: owner}
                yield {kind: 'input' as const, filePath: input, flsPath: '/phase6/main.fls', isTeX: false, ownerPath: owner}
                yield {kind: 'bibliography' as const, filePath: bib, auxPath: '/phase6/main.aux', ownerPath: owner}
                yield {kind: 'bibliography' as const, filePath: bib, auxPath: '/phase6/main.aux', ownerPath: owner}
            })
            const childrenStub = sinon.stub(auxiliaries, 'getFlsChildren').resolves(['/child.tex'])
            const existsStub = sinon.stub(lw.file, 'exists').resolves({type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0})
            const refreshStub = sinon.stub(lw.cache, 'refreshCache').resolves()
            const addSpy = sinon.spy(lw.cache, 'add')

            try {
                await lw.cache.loadFlsFile(owner)
                assert.deepStrictEqual(await lw.cache.getFlsChildren('/candidate.tex'), ['/child.tex'])

                sinon.assert.calledOnceWithExactly(discoverStub, owner)
                sinon.assert.calledOnceWithExactly(childrenStub, '/candidate.tex')
                assert.deepStrictEqual(lw.cache.get(owner)?.children.slice(-1), [{filePath: child, index: Number.MAX_VALUE}])
                sinon.assert.calledWith(addSpy, child)
                sinon.assert.calledWith(addSpy, input)
                assert.deepStrictEqual([...lw.cache.get(owner)!.bibfiles], [bib])
                assert.ok(lw.watcher.bib.has(vscode.Uri.file(bib)))
                sinon.assert.calledOnceWithExactly(refreshStub, child, owner)
            } finally {
                discoverStub.restore()
                childrenStub.restore()
                existsStub.restore()
                refreshStub.restore()
                addSpy.restore()
            }
        })

        it('should preserve FLS filtering order and stop TeX application when owner recovery fails', async () => {
            const owner = '/phase6/missing-owner.tex'
            const excludedInput = '/phase6/excluded.tex'
            const missingInput = '/phase6/missing.tex'
            const watchedInput = '/phase6/watched.tex'
            const child = '/phase6/child.tex'
            const excludedBib = '/phase6/excluded.bib'
            const watchedBib = get.path(fixture, 'main.bib')
            const instance = new Cache()
            set.config('latex.watch.files.ignore', ['**/excluded.tex', '**/excluded.bib'])
            lw.watcher.src.add(vscode.Uri.file(watchedInput))
            lw.watcher.bib.add(vscode.Uri.file(watchedBib))
            const discoverStub = sinon.stub(auxiliaries, 'discoverFls').callsFake(async function* () {
                await Promise.resolve()
                for (const filePath of [excludedInput, missingInput, owner, watchedInput, child]) {
                    yield {kind: 'input' as const, filePath, flsPath: '/phase6/main.fls', isTeX: true, ownerPath: owner}
                }
                yield {kind: 'bibliography' as const, filePath: excludedBib, auxPath: '/phase6/main.aux', ownerPath: owner}
                yield {kind: 'bibliography' as const, filePath: watchedBib, auxPath: '/phase6/main.aux', ownerPath: owner}
            })
            const existsStub = sinon.stub(lw.file, 'exists').callsFake(filePath => Promise.resolve(
                filePath === missingInput ? false : {type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0}
            ))
            const refreshStub = sinon.stub(instance, 'refreshCache').resolves()
            const addSpy = sinon.spy(instance, 'add')

            try {
                await instance.loadFlsFile(owner)

                sinon.assert.neverCalledWith(existsStub, excludedInput)
                sinon.assert.calledOnceWithExactly(refreshStub, owner)
                sinon.assert.notCalled(addSpy)
                assert.strictEqual(instance.get(owner), undefined)
                assert.notHasLog(`Found .bib ${watchedBib} from .aux /phase6/main.aux .`)
            } finally {
                discoverStub.restore()
                existsStub.restore()
                instance.dispose()
            }
        })
    })

    describe('lw.cache.getIncludedTeX coordination', () => {
        it('should resolve the current root and forward the compatibility Set', () => {
            const rootPath = set.root(fixture, 'main.tex')
            const includedTeX = new Set(['/seed.tex'])
            const includedStub = sinon.stub(dependencies, 'getIncludedTeX').returns(includedTeX)

            const result = lw.cache.getIncludedTeX(undefined, includedTeX)
            const [filePath, , forwardedSet] = includedStub.firstCall.args

            assert.strictEqual(result, includedTeX)
            assert.strictEqual(filePath, rootPath)
            assert.strictEqual(forwardedSet, includedTeX)
            assert.strictEqual(typeof includedStub.firstCall.args[1], 'function')
        })
    })

    describe('lw.cache bibliography query coordination', () => {
        it('should dynamically resolve the root and forward inline cache lookups', () => {
            const firstRoot = set.root(fixture, 'main.tex')
            const bibStub = sinon.stub(bibliography, 'getIncludedBib').returns(['/bib.bib'])
            const glossaryStub = sinon.stub(bibliography, 'getIncludedGlossaryBib').returns(['/glossary.bib'])

            try {
                assert.deepStrictEqual(lw.cache.getIncludedBib(), ['/bib.bib'])
                const secondRoot = set.root(fixture, 'another.tex')
                assert.deepStrictEqual(lw.cache.getIncludedGlossaryBib(), ['/glossary.bib'])
                assert.deepStrictEqual(lw.cache.getIncludedBib('/explicit.tex'), ['/bib.bib'])

                assert.strictEqual(bibStub.firstCall.args[0], firstRoot)
                assert.strictEqual(glossaryStub.firstCall.args[0], secondRoot)
                assert.strictEqual(bibStub.secondCall.args[0], '/explicit.tex')
                assert.strictEqual(typeof bibStub.firstCall.args[1], 'function')
                assert.strictEqual(typeof bibStub.secondCall.args[1], 'function')
                assert.strictEqual(typeof glossaryStub.firstCall.args[1], 'function')
            } finally {
                bibStub.restore()
                glossaryStub.restore()
            }
        })
    })

})
