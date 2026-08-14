import * as vscode from 'vscode'
import os from 'os'
import * as path from 'path'
import { createRequire } from 'module'
import * as sinon from 'sinon'
import { assert, get, log, mock, set, sleep } from '../utils'
import { lw } from '../../../src/lw'
import { Cache } from '../../../src/core/cache'
import * as dependencies from '../../../src/core/cache/dependencies'

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

    describe('import-time source watcher listeners', () => {
        it('should capture the production singleton in every external callback', () => {
            const testRequire = createRequire(__filename)
            const cacheModulePath = testRequire.resolve('../../../src/core/cache')
            const cachedCacheModule = testRequire.cache[cacheModulePath]
            const changeDisposeSpy = sinon.spy()
            const deleteDisposeSpy = sinon.spy()
            const onChangeStub = sinon.stub(lw.watcher.src, 'onChange').returns(new vscode.Disposable(changeDisposeSpy))
            const onDeleteStub = sinon.stub(lw.watcher.src, 'onDelete').returns(new vscode.Disposable(deleteDisposeSpy))
            const onDisposeStub = lw.onDispose as sinon.SinonStub
            onDisposeStub.resetHistory()

            // Reload the cache module while registrations are intercepted so this
            // test can exercise its private callbacks without exporting them.
            delete testRequire.cache[cacheModulePath]
            try {
                const isolatedCacheModule = testRequire(cacheModulePath) as typeof import('../../../src/core/cache')
                const changeCallback = onChangeStub.firstCall.args[0] as (uri: vscode.Uri) => void
                const deleteCallback = onDeleteStub.firstCall.args[0] as (uri: vscode.Uri) => void
                const disposable = onDisposeStub.firstCall.args[0] as vscode.Disposable
                const resetStub = sinon.stub(isolatedCacheModule.cache, 'reset')
                const unsupportedUri = vscode.Uri.file('/dev/null')

                changeCallback(unsupportedUri)
                deleteCallback(unsupportedUri)
                disposable.dispose()

                sinon.assert.calledOnce(resetStub)
                sinon.assert.calledOnce(changeDisposeSpy)
                sinon.assert.calledOnce(deleteDisposeSpy)
            } finally {
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
        it('should own watcher subscriptions without registering extension disposal', () => {
            const onChangeSpy = sinon.spy(lw.watcher.src, 'onChange')
            const onDeleteSpy = sinon.spy(lw.watcher.src, 'onDelete')
            const onDisposeStub = lw.onDispose as sinon.SinonStub
            onDisposeStub.resetHistory()
            let instance: Cache | undefined

            try {
                instance = new Cache()

                sinon.assert.calledOnce(onChangeSpy)
                sinon.assert.calledOnce(onDeleteSpy)
                sinon.assert.notCalled(onDisposeStub)
            } finally {
                instance?.dispose()
                onChangeSpy.restore()
                onDeleteSpy.restore()
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

        it('should coordinate dependency updates with the owning instance', async () => {
            const texPath = get.path(fixture, 'main.tex')
            const instance = new Cache()
            const updateStub = sinon.stub(dependencies, 'updateDependencies').resolves()

            try {
                await instance.refreshCache(texPath)
                const [fileCache, rootPath, context] = updateStub.firstCall.args
                assert.strictEqual(fileCache.filePath, texPath)
                assert.strictEqual(rootPath, texPath)

                const getSpy = sinon.spy(instance, 'get')
                const addStub = sinon.stub(instance, 'add')
                const refreshStub = sinon.stub(instance, 'refreshCache').resolves()
                assert.strictEqual(context.getCache(texPath), fileCache)
                context.watchSource(texPath)
                context.refreshSource(texPath, rootPath)

                sinon.assert.calledOnceWithExactly(getSpy, texPath)
                sinon.assert.calledOnceWithExactly(addStub, texPath)
                sinon.assert.calledOnceWithExactly(refreshStub, texPath, rootPath)
            } finally {
                updateStub.restore()
                instance.dispose()
            }
        })

        it('should update AST during caching', async () => {
            const texPath = get.path(fixture, 'main.tex')

            await lw.cache.refreshCache(texPath)
            assert.hasLog('Parsed LaTeX AST in ')
        })

        it('should update document elements during caching', async () => {
            const texPath = get.path(fixture, 'main.tex')

            await lw.cache.refreshCache(texPath)
            assert.hasLog('Updated elements in ')
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

    describe('lw.cache.updateBibfiles', () => {
        it('should not add any bib files if there is nothing', async () => {
            const texPath = get.path(fixture, 'main.tex')

            lw.cache.add(texPath)
            await lw.cache.refreshCache(texPath)
            const fileCache = lw.cache.get(texPath)
            assert.ok(fileCache)
            assert.strictEqual(fileCache.bibfiles.size, 0)
        })

        it('should not add a bib file if the file does not exist', async () => {
            const toParse = get.path(fixture, 'update_bibfiles', 'file_not_exist.tex')
            lw.cache.add(toParse)
            await lw.cache.refreshCache(toParse)
            const fileCache = lw.cache.get(toParse)
            assert.ok(fileCache)
            assert.listStrictEqual(Array.from(fileCache.bibfiles), [])
        })

        it('should add bib files with \\bibliography, \\addbibresource, \\putbib, and possible presense of \\subfix', async () => {
            const bibPath = get.path(fixture, 'main.bib')
            const toParse = get.path(fixture, 'update_bibfiles', 'main.tex')

            lw.cache.add(toParse)
            await lw.cache.refreshCache(toParse)
            const fileCache = lw.cache.get(toParse)
            assert.ok(fileCache)
            assert.listStrictEqual(Array.from(fileCache.bibfiles), [
                bibPath,
                get.path(fixture, 'update_bibfiles', 'bib', '1.bib'),
                get.path(fixture, 'update_bibfiles', 'bib', '2.bib'),
                get.path(fixture, 'update_bibfiles', 'bib', '3.bib'),
                get.path(fixture, 'update_bibfiles', 'bib', '4.bib'),
                get.path(fixture, 'update_bibfiles', 'bib', '5.bib'),
            ])
        })

        it('should add multiple bib files in one macro', async () => {
            const bibPath = get.path(fixture, 'main.bib')
            const toParse = get.path(fixture, 'update_bibfiles', 'same_macro.tex')

            lw.cache.add(toParse)
            await lw.cache.refreshCache(toParse)
            const fileCache = lw.cache.get(toParse)
            assert.ok(fileCache)
            assert.listStrictEqual(Array.from(fileCache.bibfiles), [
                bibPath,
                get.path(fixture, 'update_bibfiles', 'bib', '1.bib'),
            ])
        })

        it('should not add excluded bib files', async () => {
            const toParse = get.path(fixture, 'update_bibfiles', 'file_excluded.tex')
            lw.cache.add(toParse)
            await lw.cache.refreshCache(toParse)
            const fileCache = lw.cache.get(toParse)
            assert.ok(fileCache)
            assert.listStrictEqual(Array.from(fileCache.bibfiles), [])
        })

        it('should watch bib files if added', async () => {
            const bibPath = get.path(fixture, 'main.bib')
            const toParse = get.path(fixture, 'update_bibfiles', 'same_macro.tex')

            lw.cache.add(toParse)
            await lw.cache.refreshCache(toParse)
            assert.ok(lw.watcher.bib.has(vscode.Uri.file(bibPath)))
        })
    })

    describe('lw.cache.updateGlossaryBibFiles', () => {
        it('should add and watch glossary files from both supported macros', async () => {
            const texPath = get.path(fixture, 'main.tex')
            const bibPath = get.path(fixture, 'main.bib')
            const documentStub = mock.textDocument(texPath, '\\GlsXtrLoadResources[src={main}]\n\\glsbibdata{main}', { isDirty: true })

            await lw.cache.refreshCache(texPath)
            documentStub.restore()

            assert.listStrictEqual(Array.from(lw.cache.get(texPath)?.glossarybibfiles ?? []), [bibPath])
            assert.listStrictEqual(lw.cache.getIncludedGlossaryBib(texPath), [bibPath])
            assert.ok(lw.watcher.glossary.has(vscode.Uri.file(bibPath)))
        })

        it('should ignore excluded and empty glossary paths', async () => {
            const texPath = get.path(fixture, 'main.tex')
            const bibPath = get.path(fixture, 'main.bib')
            const documentStub = mock.textDocument(texPath, '\\glsbibdata{main,empty}', { isDirty: true })
            const getBibPathStub = sinon.stub(lw.file, 'getBibPath')
            getBibPathStub.withArgs('main', sinon.match.any).resolves([bibPath])
            getBibPathStub.withArgs('empty', sinon.match.any).resolves([''])
            set.config('latex.watch.files.ignore', ['**/main.bib'])

            await lw.cache.refreshCache(texPath)
            documentStub.restore()
            getBibPathStub.restore()

            assert.listStrictEqual(lw.cache.getIncludedGlossaryBib(texPath), [])
        })

        it('should return an empty list without a root or cached file', () => {
            assert.listStrictEqual(lw.cache.getIncludedGlossaryBib(), [])
            assert.listStrictEqual(lw.cache.getIncludedGlossaryBib(get.path(fixture, 'missing.tex')), [])
        })
    })

    describe('lw.cache.loadFlsFile and lw.cache.parseFlsContent', () => {
        it('should do nothing if no .fls is found', async () => {
            const texPathAnother = get.path(fixture, 'another.tex')

            await lw.cache.loadFlsFile(texPathAnother)
            assert.notHasLog('Parsing .fls ')
        })

        it('should parse an unreadable .fls file as empty', async () => {
            const toParse = get.path(fixture, 'load_fls_file', 'include_main.tex')
            const flsPath = get.path(fixture, 'load_fls_file', 'include_main.fls')
            const readStub = sinon.stub(lw.file, 'read').callThrough()
            readStub.withArgs(flsPath).resolves(undefined)

            await lw.cache.loadFlsFile(toParse)
            readStub.restore()

            assert.strictEqual(lw.cache.get(toParse), undefined)
            assert.hasLog(`Parsed .fls ${flsPath} .`)
        })

        it('should not consider files that are both INPUT and OUTPUT', async () => {
            const toParse = get.path(fixture, 'load_fls_file', 'both_input_output.tex')
            await lw.cache.refreshCache(toParse)
            await lw.cache.loadFlsFile(toParse)
            assert.listStrictEqual(lw.cache.get(toParse)?.children, [])
        })

        it('should not consider files that are excluded', async () => {
            const toParse = get.path(fixture, 'load_fls_file', 'excluded_file.tex')
            await lw.cache.refreshCache(toParse)
            await lw.cache.loadFlsFile(toParse)
            assert.listStrictEqual(lw.cache.get(toParse)?.children, [])
        })

        it('should not consider files that do not exist', async () => {
            const toParse = get.path(fixture, 'load_fls_file', 'file_not_exist.tex')
            await lw.cache.refreshCache(toParse)
            await lw.cache.loadFlsFile(toParse)
            assert.listStrictEqual(lw.cache.get(toParse)?.children, [])
        })

        it('should not consider the file itself if listed in .fls', async () => {
            const toParse = get.path(fixture, 'load_fls_file', 'self_include.tex')
            await lw.cache.refreshCache(toParse)
            await lw.cache.loadFlsFile(toParse)
            assert.listStrictEqual(lw.cache.get(toParse)?.children, [])
        })

        it('should not consider files that already been cached', async () => {
            const texPath = get.path(fixture, 'main.tex')

            lw.cache.add(texPath)
            await lw.cache.refreshCache(texPath)
            const toParse = get.path(fixture, 'load_fls_file', 'include_main.tex')
            await lw.cache.refreshCache(toParse)
            await lw.cache.loadFlsFile(toParse)
            assert.listStrictEqual(lw.cache.get(toParse)?.children, [])
        })

        it('should add file as child if all checks passed', async () => {
            const texPath = get.path(fixture, 'main.tex')
            const toParse = get.path(fixture, 'load_fls_file', 'include_main.tex')

            await lw.cache.loadFlsFile(toParse)
            assert.listStrictEqual(
                lw.cache.get(toParse)?.children.map((child) => child.filePath),
                [texPath]
            )
        })

        it('should add multiple files as children if all checks passed', async () => {
            const texPath = get.path(fixture, 'main.tex')
            const texPathAnother = get.path(fixture, 'another.tex')
            const toParse = get.path(fixture, 'load_fls_file', 'include_many.tex')

            await lw.cache.loadFlsFile(toParse)
            assert.listStrictEqual(
                lw.cache.get(toParse)?.children.map((child) => child.filePath),
                [texPath, texPathAnother]
            )
        })

        it('should watch added .tex files', async () => {
            const texPath = get.path(fixture, 'main.tex')
            const toParse = get.path(fixture, 'load_fls_file', 'include_main.tex')

            await lw.cache.loadFlsFile(toParse)
            assert.ok(lw.watcher.src.has(vscode.Uri.file(texPath)))
        })

        it('should watch added non-.tex files', async () => {
            const pdfPath = get.path(fixture, 'main.pdf')
            const toParse = get.path(fixture, 'load_fls_file', 'non_tex_input.tex')

            await lw.cache.loadFlsFile(toParse)
            assert.ok(lw.watcher.src.has(vscode.Uri.file(pdfPath)))
        })

        it('should watch added non-.tex files, except for aux or out files', async () => {
            const toParse = get.path(fixture, 'load_fls_file', 'aux_out_input.tex')
            await lw.cache.loadFlsFile(toParse)
            assert.ok(!lw.watcher.src.has(vscode.Uri.file(get.path(fixture, 'load_fls_file', 'main.aux'))))
            assert.ok(!lw.watcher.src.has(vscode.Uri.file(get.path(fixture, 'load_fls_file', 'main.out'))))
        })

        it('should handle an excluded root while parsing TeX inputs', async () => {
            const toParse = get.path(fixture, 'load_fls_file', 'include_main.tex')
            set.config('latex.watch.files.ignore', ['**/include_main.tex'])

            await lw.cache.loadFlsFile(toParse)

            assert.strictEqual(lw.cache.get(toParse), undefined)
            assert.hasLog(`Cache not finished on ${toParse} when parsing fls.`)
        })
    })

    describe('lw.cache.parseAuxFile', () => {
        it('should do nothing if no \\bibdata is found', async () => {
            const toParse = get.path(fixture, 'load_aux_file', 'nothing.tex')
            set.root(fixture, 'load_aux_file', 'nothing.tex')
            await lw.cache.refreshCache(toParse)
            await lw.cache.loadFlsFile(toParse)
            assert.listStrictEqual(Array.from(lw.cache.get(toParse)?.bibfiles ?? new Set([''])), [])
        })

        it('should ignore an empty \\bibdata entry', async () => {
            const toParse = get.path(fixture, 'load_aux_file', 'empty.tex')
            set.root(fixture, 'load_aux_file', 'empty.tex')

            await lw.cache.refreshCache(toParse)
            await lw.cache.loadFlsFile(toParse)

            assert.listStrictEqual(Array.from(lw.cache.get(toParse)?.bibfiles ?? new Set([''])), [])
            assert.hasLog('Empty \\bibdata in .aux ')
        })

        it('should parse an unreadable auxiliary file as empty', async () => {
            const toParse = get.path(fixture, 'load_aux_file', 'main.tex')
            const auxPath = get.path(fixture, 'load_aux_file', 'main.aux')
            const readStub = sinon.stub(lw.file, 'read').callThrough()
            readStub.withArgs(auxPath).resolves(undefined)
            set.root(fixture, 'load_aux_file', 'main.tex')

            await lw.cache.refreshCache(toParse)
            await lw.cache.loadFlsFile(toParse)
            readStub.restore()

            assert.listStrictEqual(Array.from(lw.cache.get(toParse)?.bibfiles ?? []), [])
        })

        it('should add \\bibdata from .aux file', async () => {
            const toParse = get.path(fixture, 'load_aux_file', 'main.tex')
            set.root(fixture, 'load_aux_file', 'main.tex')
            await lw.cache.refreshCache(toParse)
            await lw.cache.loadFlsFile(toParse)
            assert.listStrictEqual(Array.from(lw.cache.get(toParse)?.bibfiles ?? new Set()), [
                get.path(fixture, 'load_aux_file', 'main.bib'),
            ])
        })

        it('should not add \\bibdata if the bib is excluded', async () => {
            set.config('latex.watch.files.ignore', ['**/main.bib'])
            const toParse = get.path(fixture, 'load_aux_file', 'main.tex')
            set.root(fixture, 'load_aux_file', 'main.tex')
            await lw.cache.refreshCache(toParse)
            await lw.cache.loadFlsFile(toParse)
            assert.listStrictEqual(Array.from(lw.cache.get(toParse)?.bibfiles ?? new Set([''])), [])
        })

        it('should watch bib files if added', async () => {
            const toParse = get.path(fixture, 'load_aux_file', 'main.tex')
            set.root(fixture, 'load_aux_file', 'main.tex')
            await lw.cache.refreshCache(toParse)
            await lw.cache.loadFlsFile(toParse)
            assert.ok(lw.watcher.bib.has(vscode.Uri.file(get.path(fixture, 'load_aux_file', 'main.bib'))))
        })

        it('should attach AUX bibliography data to the current root instead of the FLS owner', async () => {
            const rootPath = set.root(fixture, 'another.tex')
            const flsOwner = get.path(fixture, 'load_aux_file', 'main.tex')
            const bibPath = get.path(fixture, 'main.bib')
            await lw.cache.refreshCache(rootPath)
            await lw.cache.refreshCache(flsOwner)

            await lw.cache.loadFlsFile(flsOwner)

            assert.listStrictEqual(Array.from(lw.cache.get(rootPath)?.bibfiles ?? []), [bibPath])
            assert.listStrictEqual(Array.from(lw.cache.get(flsOwner)?.bibfiles ?? []), [])
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
        })
    })

    describe('lw.cache.getIncludedBib', () => {
        it('should return an empty list if no file path is given', () => {
            assert.listStrictEqual(lw.cache.getIncludedBib(), [])
        })

        it('should return an empty list if the given file is not cached', () => {
            const toParse = get.path(fixture, 'included_bib', 'main.tex')
            assert.listStrictEqual(lw.cache.getIncludedBib(toParse), [])
        })

        it('should return a list of included .bib files', async () => {
            const bibPath = get.path(fixture, 'main.bib')
            const toParse = get.path(fixture, 'included_bib', 'main.tex')

            await lw.cache.refreshCache(toParse)
            assert.listStrictEqual(lw.cache.getIncludedBib(toParse), [bibPath])
        })

        it('should return a list of included .bib files with \\input', async () => {
            const bibPath = get.path(fixture, 'main.bib')
            const toParse = get.path(fixture, 'included_bib', 'another.tex')

            await lw.cache.refreshCache(toParse)
            await lw.cache.wait(get.path(fixture, 'included_bib', 'main.tex'))
            assert.listStrictEqual(lw.cache.getIncludedBib(toParse), [bibPath])
        })

        it('should return a list of included .bib files with circular inclusions', async () => {
            const bibPath = get.path(fixture, 'main.bib')
            const toParse = get.path(fixture, 'included_bib', 'circular_1.tex')
            const circularChild = get.path(fixture, 'included_bib', 'circular_2.tex')

            lw.cache.add(toParse)
            lw.cache.add(circularChild)
            await lw.cache.refreshCache(toParse)
            await lw.cache.refreshCache(circularChild)
            assert.listStrictEqual(lw.cache.getIncludedBib(toParse), [bibPath])
        })

        it('should return a list of de-duplicated .bib files', async () => {
            const bibPath = get.path(fixture, 'main.bib')
            const toParse = get.path(fixture, 'included_bib', 'duplicate_1.tex')

            await lw.cache.refreshCache(toParse)
            assert.listStrictEqual(lw.cache.getIncludedBib(toParse), [bibPath])
        })
    })

    describe('lw.cache.getFlsChildren', () => {
        it('should return an empty list if no .fls is found', async () => {
            const texPathAnother = get.path(fixture, 'another.tex')

            assert.listStrictEqual(await lw.cache.getFlsChildren(texPathAnother), [])
        })

        it('should return a list of input files in the .fls file', async () => {
            const texPath = get.path(fixture, 'main.tex')
            const toParse = get.path(fixture, 'load_fls_file', 'include_main.tex')

            assert.listStrictEqual(await lw.cache.getFlsChildren(toParse), [texPath])
        })

        it('should return no input files when the .fls file cannot be read', async () => {
            const toParse = get.path(fixture, 'load_fls_file', 'include_main.tex')
            const flsPath = get.path(fixture, 'load_fls_file', 'include_main.fls')
            const readStub = sinon.stub(lw.file, 'read').callThrough()
            readStub.withArgs(flsPath).resolves(undefined)

            const children = await lw.cache.getFlsChildren(toParse)
            readStub.restore()

            assert.listStrictEqual(children, [])
        })
    })
})
