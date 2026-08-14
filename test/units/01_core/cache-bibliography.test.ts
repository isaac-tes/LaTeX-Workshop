import * as path from 'path'
import * as sinon from 'sinon'

import { assert, get, log, mock } from '../utils'
import { lw } from '../../../src/lw'
import type { FileCache } from '../../../src/types'
import {
    type BibliographyContext,
    getIncludedBib,
    getIncludedGlossaryBib,
    updateBibliography
} from '../../../src/core/cache/bibliography'

describe(path.basename(__filename).split('.')[0] + ':', () => {
    const fixture = get.path('01_core', 'cache')
    let sandbox: sinon.SinonSandbox
    let caches: Map<string, FileCache>
    let isExcluded: sinon.SinonStub
    let context: BibliographyContext
    let watchedBib: Set<string>
    let watchedGlossary: Set<string>
    let addBib: sinon.SinonStub
    let addGlossary: sinon.SinonStub

    function createFileCache(filePath: string, contentTrimmed = ''): FileCache {
        return {
            filePath,
            content: contentTrimmed,
            contentTrimmed,
            elements: {},
            children: [],
            bibfiles: new Set(),
            glossarybibfiles: new Set(),
            external: {}
        }
    }

    async function readFileCache(...relativePath: string[]): Promise<FileCache> {
        const filePath = get.path(fixture, ...relativePath)
        return createFileCache(filePath, (await lw.file.read(filePath)) ?? '')
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

    before(() => {
        mock.init(lw, 'watcher', 'cache')
    })

    beforeEach(() => {
        sandbox = sinon.createSandbox()
        caches = new Map()
        isExcluded = sandbox.stub().returns(false)
        context = {
            getCache: filePath => caches.get(filePath),
            isExcluded
        }
        watchedBib = new Set()
        watchedGlossary = new Set()
        sandbox.stub(lw.watcher.bib, 'has').callsFake(uri => watchedBib.has(uri.fsPath))
        addBib = sandbox.stub(lw.watcher.bib, 'add').callsFake(uri => {
            watchedBib.add(uri.fsPath)
        })
        sandbox.stub(lw.watcher.glossary, 'has').callsFake(uri => watchedGlossary.has(uri.fsPath))
        addGlossary = sandbox.stub(lw.watcher.glossary, 'add').callsFake(uri => {
            watchedGlossary.add(uri.fsPath)
        })
    })

    afterEach(() => {
        sandbox.restore()
    })

    after(() => {
        sinon.restore()
    })

    describe('updateBibliography BibTeX resources', () => {
        it('should leave resource Sets empty without supported macros', async () => {
            const fileCache = await readFileCache('main.tex')

            await updateBibliography(fileCache, context)

            assert.deepStrictEqual([...fileCache.bibfiles], [])
            assert.deepStrictEqual([...fileCache.glossarybibfiles], [])
            sinon.assert.notCalled(addBib)
            sinon.assert.notCalled(addGlossary)
        })

        it('should discover every supported macro and subfix form in source order', async () => {
            const fileCache = await readFileCache('update_bibfiles', 'main.tex')

            await updateBibliography(fileCache, context)

            assert.pathListStrictEqual([...fileCache.bibfiles], [
                get.path(fixture, 'main.bib'),
                get.path(fixture, 'update_bibfiles', 'bib', '1.bib'),
                get.path(fixture, 'update_bibfiles', 'bib', '2.bib'),
                get.path(fixture, 'update_bibfiles', 'bib', '3.bib'),
                get.path(fixture, 'update_bibfiles', 'bib', '4.bib'),
                get.path(fixture, 'update_bibfiles', 'bib', '5.bib')
            ])
            sinon.assert.callCount(addBib, 6)
        })

        it('should discover comma-separated resources from one macro', async () => {
            const fileCache = await readFileCache('update_bibfiles', 'same_macro.tex')

            await updateBibliography(fileCache, context)

            assert.pathListStrictEqual([...fileCache.bibfiles], [
                get.path(fixture, 'main.bib'),
                get.path(fixture, 'update_bibfiles', 'bib', '1.bib')
            ])
        })

        it('should ignore resources that cannot be resolved', async () => {
            const fileCache = await readFileCache('update_bibfiles', 'file_not_exist.tex')

            await updateBibliography(fileCache, context)

            assert.deepStrictEqual([...fileCache.bibfiles], [])
            sinon.assert.notCalled(addBib)
        })

        it('should skip resources excluded by the owning Cache', async () => {
            const fileCache = await readFileCache('update_bibfiles', 'file_excluded.tex')
            isExcluded.returns(true)

            await updateBibliography(fileCache, context)

            assert.deepStrictEqual([...fileCache.bibfiles], [])
            sinon.assert.called(isExcluded)
            sinon.assert.notCalled(addBib)
        })

        it('should preserve multiple resolved paths and suppress duplicate watcher registration', async () => {
            const fileCache = createFileCache('/project/main.tex', '\\bibliography{one,two,one}')
            const first = '/bib/first.bib'
            const second = '/bib/second.bib'
            const third = '/bib/third.bib'
            const getBibPath = sandbox.stub(lw.file, 'getBibPath')
            getBibPath.withArgs('one', '/project').resolves([first, second])
            getBibPath.withArgs('two', '/project').resolves([third])
            log.start()

            await updateBibliography(fileCache, context)
            log.stop()

            assert.deepStrictEqual([...fileCache.bibfiles], [first, second, third])
            assert.deepStrictEqual(getBibPath.args.map(args => args[0]), ['one', 'two', 'one'])
            sinon.assert.callCount(addBib, 3)
            assert.strictEqual(log.all().filter(message => message.includes(`Bib ${first} from`)).length, 2)
        })

        it('should preserve an empty resolved BibTeX path', async () => {
            const fileCache = createFileCache('/project/main.tex', '\\bibliography{empty}')
            sandbox.stub(lw.file, 'getBibPath').resolves([''])

            await updateBibliography(fileCache, context)

            assert.deepStrictEqual([...fileCache.bibfiles], [''])
            sinon.assert.calledOnce(addBib)
        })

        it('should ignore an empty BibTeX macro that the current regexp does not match', async () => {
            const fileCache = createFileCache('/project/main.tex', '\\bibliography{}')
            const getBibPath = sandbox.spy(lw.file, 'getBibPath')

            await updateBibliography(fileCache, context)

            assert.deepStrictEqual([...fileCache.bibfiles], [])
            sinon.assert.notCalled(getBibPath)
        })
    })

    describe('updateBibliography glossary resources', () => {
        it('should discover both supported macro families, options, multiline content, and comma lists', async () => {
            const fileCache = createFileCache(
                '/project/main.tex',
                '\\GlsXtrLoadResources[\nfoo,src={one,two}\n]\n\\glsbibdata[selection=all]{three}'
            )
            const getBibPath = sandbox.stub(lw.file, 'getBibPath')
            getBibPath.withArgs('one', '/project').resolves(['/bib/one.bib'])
            getBibPath.withArgs('two', '/project').resolves(['/bib/two.bib'])
            getBibPath.withArgs('three', '/project').resolves(['/bib/three.bib'])

            await updateBibliography(fileCache, context)

            assert.deepStrictEqual([...fileCache.glossarybibfiles], [
                '/bib/one.bib',
                '/bib/two.bib',
                '/bib/three.bib'
            ])
            sinon.assert.callCount(addGlossary, 3)
        })

        it('should ignore missing, empty, and excluded glossary paths', async () => {
            const fileCache = createFileCache('/project/main.tex', '\\glsbibdata{missing,empty,excluded}')
            const getBibPath = sandbox.stub(lw.file, 'getBibPath')
            getBibPath.withArgs('missing', '/project').resolves([])
            getBibPath.withArgs('empty', '/project').resolves([''])
            getBibPath.withArgs('excluded', '/project').resolves(['/bib/excluded.bib'])
            isExcluded.withArgs('/bib/excluded.bib').returns(true)

            await updateBibliography(fileCache, context)

            assert.deepStrictEqual([...fileCache.glossarybibfiles], [])
            sinon.assert.notCalled(addGlossary)
        })

        it('should resolve an empty glossary macro as an empty resource name', async () => {
            const fileCache = createFileCache('/project/main.tex', '\\glsbibdata{}')
            const getBibPath = sandbox.stub(lw.file, 'getBibPath').resolves([])

            await updateBibliography(fileCache, context)

            sinon.assert.calledOnceWithExactly(getBibPath, '', '/project')
            assert.deepStrictEqual([...fileCache.glossarybibfiles], [])
        })

        it('should keep BibTeX and glossary ownership and watchers separate', async () => {
            const fileCache = createFileCache('/project/main.tex', '\\bibliography{shared}\n\\glsbibdata{shared}')
            sandbox.stub(lw.file, 'getBibPath').resolves(['/bib/shared.bib'])

            await updateBibliography(fileCache, context)

            assert.deepStrictEqual([...fileCache.bibfiles], ['/bib/shared.bib'])
            assert.deepStrictEqual([...fileCache.glossarybibfiles], ['/bib/shared.bib'])
            sinon.assert.calledOnce(addBib)
            sinon.assert.calledOnce(addGlossary)
        })

        it('should not register resources that their watcher already owns', async () => {
            const fileCache = createFileCache('/project/main.tex', '\\bibliography{shared}\n\\glsbibdata{shared}')
            sandbox.stub(lw.file, 'getBibPath').resolves(['/bib/shared.bib'])
            watchedBib.add('/bib/shared.bib')
            watchedGlossary.add('/bib/shared.bib')

            await updateBibliography(fileCache, context)

            assert.deepStrictEqual([...fileCache.bibfiles], ['/bib/shared.bib'])
            assert.deepStrictEqual([...fileCache.glossarybibfiles], ['/bib/shared.bib'])
            sinon.assert.notCalled(addBib)
            sinon.assert.notCalled(addGlossary)
        })
    })

    describe('updateBibliography ordering and errors', () => {
        it('should resolve serially and stop before glossary discovery after an error', async () => {
            const fileCache = createFileCache('/project/main.tex', '\\bibliography{one,two}\n\\glsbibdata{three}')
            const first = deferred<string[]>()
            const failure = new Error('resolution failed')
            const getBibPath = sandbox.stub(lw.file, 'getBibPath')
            getBibPath.onFirstCall().returns(first.promise)
            getBibPath.onSecondCall().rejects(failure)

            const updating = updateBibliography(fileCache, context)
            await Promise.resolve()
            sinon.assert.calledOnceWithExactly(getBibPath, 'one', '/project')

            first.resolve(['/bib/one.bib'])
            await assert.rejects(updating, failure)

            assert.deepStrictEqual(getBibPath.args.map(args => args[0]), ['one', 'two'])
            assert.deepStrictEqual([...fileCache.bibfiles], ['/bib/one.bib'])
            assert.deepStrictEqual([...fileCache.glossarybibfiles], [])
        })
    })

    describe('included bibliography graph queries', () => {
        it('should return empty results without a cached starting file', () => {
            assert.deepStrictEqual(getIncludedBib(undefined, context), [])
            assert.deepStrictEqual(getIncludedBib('/missing.tex', context), [])
            assert.deepStrictEqual(getIncludedGlossaryBib(undefined, context), [])
            assert.deepStrictEqual(getIncludedGlossaryBib('/missing.tex', context), [])
        })

        it('should traverse children depth first, prevent cycles, and preserve first resource occurrence', () => {
            const root = createFileCache('/root.tex')
            const first = createFileCache('/first.tex')
            const second = createFileCache('/second.tex')
            const shared = createFileCache('/shared.tex')
            const external = createFileCache('/external.tex')
            root.children.push(
                {filePath: first.filePath, index: 0},
                {filePath: second.filePath, index: 1},
                {filePath: '/missing.tex', index: 2}
            )
            first.children.push(
                {filePath: root.filePath, index: 0},
                {filePath: shared.filePath, index: 1}
            )
            second.children.push({filePath: shared.filePath, index: 0})
            root.external[external.filePath] = ''
            root.bibfiles = new Set(['/bib/root.bib', '/bib/shared.bib'])
            first.bibfiles = new Set(['/bib/first.bib'])
            shared.bibfiles = new Set(['/bib/shared.bib', '/bib/deep.bib'])
            second.bibfiles = new Set(['/bib/second.bib'])
            external.bibfiles = new Set(['/bib/external.bib'])
            root.glossarybibfiles = new Set(['/glossary/root.bib'])
            first.glossarybibfiles = new Set(['/glossary/shared.bib'])
            shared.glossarybibfiles = new Set(['/glossary/deep.bib'])
            second.glossarybibfiles = new Set(['/glossary/shared.bib', '/glossary/second.bib'])
            external.glossarybibfiles = new Set(['/glossary/external.bib'])
            for (const cache of [root, first, second, shared, external]) {
                caches.set(cache.filePath, cache)
            }

            assert.deepStrictEqual(getIncludedBib(root.filePath, context), [
                '/bib/root.bib',
                '/bib/shared.bib',
                '/bib/first.bib',
                '/bib/deep.bib',
                '/bib/second.bib'
            ])
            assert.deepStrictEqual(getIncludedGlossaryBib(root.filePath, context), [
                '/glossary/root.bib',
                '/glossary/shared.bib',
                '/glossary/deep.bib',
                '/glossary/second.bib'
            ])
        })
    })
})
