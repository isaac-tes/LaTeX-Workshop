import * as path from 'path'
import * as sinon from 'sinon'

import { assert, get, mock } from '../utils'
import { lw } from '../../../src/lw'
import type { FileCache } from '../../../src/types'
import {
    type BibliographyDiscovery,
    discoverBibliography,
    getIncludedBib,
    getIncludedGlossaryBib
} from '../../../src/core/cache/bibliography'
import { CacheStore } from '../../../src/core/cache/store'

describe(path.basename(__filename).split('.')[0] + ':', () => {
    const fixture = get.path('01_core', 'cache')
    let sandbox: sinon.SinonSandbox
    let caches: Map<string, FileCache>

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

    async function discover(fileCache: FileCache, rootDir = path.dirname(fileCache.filePath)): Promise<BibliographyDiscovery[]> {
        const discoveries: BibliographyDiscovery[] = []
        const source = {filePath: fileCache.filePath, contentTrimmed: fileCache.contentTrimmed}
        for await (const discovery of discoverBibliography(source, rootDir)) {
            discoveries.push(discovery)
        }
        return discoveries
    }

    function deferred<T>() {
        let resolve!: (value: T | PromiseLike<T>) => void
        const promise = new Promise<T>(promiseResolve => {
            resolve = promiseResolve
        })
        return {promise, resolve}
    }

    before(() => {
        mock.init(lw, 'watcher', 'cache')
    })

    beforeEach(() => {
        sandbox = sinon.createSandbox()
        caches = new Map()
    })

    afterEach(() => {
        sandbox.restore()
    })

    after(() => {
        sinon.restore()
    })

    describe('discoverBibliography', () => {
        it('should return no discoveries without supported macros', async () => {
            assert.deepStrictEqual(await discover(await readFileCache('main.tex')), [])
        })

        it('should discover every BibTeX macro and subfix form in source order', async () => {
            const fileCache = await readFileCache('update_bibfiles', 'main.tex')
            const rootDir = path.dirname(get.path(fixture, 'main.tex'))
            const discoveries = await discover(fileCache, rootDir)

            assert.deepStrictEqual(discoveries.map(({kind}) => kind), Array(6).fill('bibtex'))
            assert.pathListStrictEqual(discoveries.map(({filePath}) => filePath), [
                get.path(fixture, 'main.bib'),
                get.path(fixture, 'update_bibfiles', 'bib', '1.bib'),
                get.path(fixture, 'update_bibfiles', 'bib', '2.bib'),
                get.path(fixture, 'update_bibfiles', 'bib', '3.bib'),
                get.path(fixture, 'update_bibfiles', 'bib', '4.bib'),
                get.path(fixture, 'update_bibfiles', 'bib', '5.bib')
            ])
        })

        it('should preserve duplicate, multiple, and empty BibTeX paths', async () => {
            const fileCache = createFileCache('/source/main.tex', '\\bibliography{one,two,one}')
            const getBibPath = sandbox.stub(lw.file, 'getBibPath')
            getBibPath.withArgs('one', '/owner', '/source').resolves(['/bib/first.bib', ''])
            getBibPath.withArgs('two', '/owner', '/source').resolves(['/bib/second.bib'])

            assert.deepStrictEqual(await discover(fileCache, '/owner'), [
                {kind: 'bibtex', filePath: '/bib/first.bib'},
                {kind: 'bibtex', filePath: ''},
                {kind: 'bibtex', filePath: '/bib/second.bib'},
                {kind: 'bibtex', filePath: '/bib/first.bib'},
                {kind: 'bibtex', filePath: ''}
            ])
            assert.deepStrictEqual(getBibPath.args.map(args => args[0]), ['one', 'two', 'one'])
        })

        it('should not match an empty classic BibTeX macro', async () => {
            const getBibPath = sandbox.spy(lw.file, 'getBibPath')
            assert.deepStrictEqual(await discover(createFileCache('/project/main.tex', '\\bibliography{}')), [])
            sinon.assert.notCalled(getBibPath)
        })

        it('should discover glossary macro families after all BibTeX resources', async () => {
            const fileCache = createFileCache(
                '/source/main.tex',
                '\\bibliography{classic}\n\\GlsXtrLoadResources[\nfoo,src={one,two}\n]\n\\glsbibdata[selection=all]{three}'
            )
            const getBibPath = sandbox.stub(lw.file, 'getBibPath').callsFake(bib => Promise.resolve([`/bib/${bib}.bib`]))

            assert.deepStrictEqual(await discover(fileCache, '/owner'), [
                {kind: 'bibtex', filePath: '/bib/classic.bib'},
                {kind: 'glossary', filePath: '/bib/one.bib'},
                {kind: 'glossary', filePath: '/bib/two.bib'},
                {kind: 'glossary', filePath: '/bib/three.bib'}
            ])
            for (const call of getBibPath.args) {
                assert.deepStrictEqual(call.slice(1), ['/owner', '/source'])
            }
        })

        it('should resolve an empty glossary macro and yield empty resolved paths', async () => {
            const fileCache = createFileCache('/project/main.tex', '\\glsbibdata{}')
            const getBibPath = sandbox.stub(lw.file, 'getBibPath').resolves([''])

            assert.deepStrictEqual(await discover(fileCache, '/owner'), [{kind: 'glossary', filePath: ''}])
            sinon.assert.calledOnceWithExactly(getBibPath, '', '/owner', '/project')
        })

        it('should apply earlier yields before a later resolution rejects and skip glossary scanning', async () => {
            const source = {filePath: '/project/main.tex', contentTrimmed: '\\bibliography{one,two}\n\\glsbibdata{three}'}
            const first = deferred<string[]>()
            const failure = new Error('resolution failed')
            const getBibPath = sandbox.stub(lw.file, 'getBibPath')
            getBibPath.onFirstCall().returns(first.promise)
            getBibPath.onSecondCall().rejects(failure)
            const generator = discoverBibliography(source, '/project')

            const firstResult = generator.next()
            await Promise.resolve()
            sinon.assert.calledOnceWithExactly(getBibPath, 'one', '/project', '/project')
            first.resolve(['/bib/one.bib'])
            assert.deepStrictEqual(await firstResult, {done: false, value: {kind: 'bibtex', filePath: '/bib/one.bib'}})
            await assert.rejects(generator.next(), failure)
            assert.deepStrictEqual(getBibPath.args.map(args => args[0]), ['one', 'two'])
        })
    })

    describe('included bibliography graph queries', () => {
        const lookup = (filePath: string) => caches.get(filePath)

        it('should return empty results without a cached starting file', () => {
            assert.deepStrictEqual(getIncludedBib(undefined, lookup), [])
            assert.deepStrictEqual(getIncludedBib('/missing.tex', lookup), [])
            assert.deepStrictEqual(getIncludedGlossaryBib(undefined, lookup), [])
            assert.deepStrictEqual(getIncludedGlossaryBib('/missing.tex', lookup), [])
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
            first.children.push({filePath: root.filePath, index: 0}, {filePath: shared.filePath, index: 1})
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

            assert.deepStrictEqual(getIncludedBib(root.filePath, lookup), [
                '/bib/root.bib', '/bib/shared.bib', '/bib/first.bib', '/bib/deep.bib', '/bib/second.bib'
            ])
            assert.deepStrictEqual(getIncludedGlossaryBib(root.filePath, lookup), [
                '/glossary/root.bib', '/glossary/shared.bib', '/glossary/deep.bib', '/glossary/second.bib'
            ])
        })

        it('should normalize TeX and bibliography identity while preserving first paths', () => {
            const root = createFileCache('C:\\Project\\root.tex')
            const child = createFileCache('C:\\Project\\child.tex')
            const firstChildPath = 'c:/Project/nested/../child.tex'
            const firstBibPath = 'C:\\Project\\refs\\..\\main.bib'
            root.children.push(
                {filePath: firstChildPath, index: 0},
                {filePath: child.filePath, index: 1}
            )
            child.children.push({filePath: 'c:/Project/root.tex', index: 0})
            root.bibfiles.add(firstBibPath)
            child.bibfiles.add('c:/Project/main.bib')
            caches.set(CacheStore.normalizePath(root.filePath), root)
            caches.set(CacheStore.normalizePath(child.filePath), child)
            const normalizedLookup = (filePath: string) => caches.get(CacheStore.normalizePath(filePath))

            assert.deepStrictEqual(getIncludedBib(root.filePath, normalizedLookup), [firstBibPath])
        })
    })
})
