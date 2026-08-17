import * as path from 'path'
import * as sinon from 'sinon'

import { assert, get, mock, set } from '../utils'
import { lw } from '../../../src/lw'
import type { FileCache } from '../../../src/types'
import * as coreUtils from '../../../src/utils/utils'
import {
    type DependencyDiscovery,
    discoverDependencies,
    getIncludedTeX
} from '../../../src/core/cache/dependencies'
import { CacheStore } from '../../../src/core/cache/store'

describe(path.basename(__filename).split('.')[0] + ':', () => {
    const fixture = get.path('01_core', 'cache')
    let caches: Map<string, FileCache>
    let sandbox: sinon.SinonSandbox

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

    async function discover(fileCache: FileCache, rootPath: string): Promise<DependencyDiscovery[]> {
        const discoveries: DependencyDiscovery[] = []
        const source = {
            filePath: fileCache.filePath,
            contentTrimmed: fileCache.contentTrimmed,
            childPaths: fileCache.children.map(child => child.filePath)
        }
        for await (const discovery of discoverDependencies(source, rootPath)) {
            discoveries.push(discovery)
        }
        return discoveries
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

    describe('discoverDependencies inputs', () => {
        it('should return no discoveries without dependencies', async () => {
            const fileCache = await readFileCache('main.tex')

            assert.deepStrictEqual(await discover(fileCache, fileCache.filePath), [])
        })

        it('should stop scanning when an input cannot be resolved', async () => {
            const fileCache = createFileCache(
                get.path(fixture, 'update_children', 'virtual.tex'),
                '\\input{missing.tex}\\input{../main.tex}'
            )

            assert.deepStrictEqual(await discover(fileCache, fileCache.filePath), [])
        })

        it('should ignore missing inputs and inputs that resolve to the root', async () => {
            const rootPath = get.path(fixture, 'main.tex')
            const fileCache = await readFileCache('update_children', 'input_main.tex')
            const exists = sandbox.stub(lw.file, 'exists').resolves(false)

            assert.deepStrictEqual(await discover(fileCache, get.path(fixture, 'another.tex')), [])
            sinon.assert.called(exists)
            exists.restore()
            assert.deepStrictEqual(await discover(fileCache, rootPath), [])
        })

        it('should preserve input order, roots, first indices, and normalized de-duplication', async () => {
            const rootPath = get.path(fixture, 'another.tex')
            const mainPath = get.path(fixture, 'main.tex')
            const fileCache = await readFileCache('update_children', 'two_same_inputs.tex')
            const firstIndex = fileCache.contentTrimmed.indexOf('\\input')

            assert.deepStrictEqual(await discover(fileCache, rootPath), [{
                kind: 'input', filePath: mainPath, index: firstIndex, rootPath
            }])

            fileCache.children.push({
                filePath: path.join(path.dirname(mainPath), 'nested', '..', path.basename(mainPath)),
                index: -1
            })
            assert.deepStrictEqual(await discover(fileCache, rootPath), [])
        })

        it('should exhaust input matches before earlier noweb child matches', async () => {
            const inputPath = get.path(fixture, 'main.tex')
            const childPath = get.path(fixture, 'another.tex')
            const fileCache = createFileCache(
                get.path(fixture, 'update_children', 'virtual.tex'),
                "<<child='../another.tex'>>=\n\\input{../main.tex}"
            )

            const discoveries = await discover(fileCache, fileCache.filePath)

            assert.pathListStrictEqual(discoveries.map(discovery => discovery.filePath), [inputPath, childPath])
            assert.ok((discoveries[0] as Extract<DependencyDiscovery, {kind: 'input'}>).index >
                (discoveries[1] as Extract<DependencyDiscovery, {kind: 'input'}>).index)
        })
    })

    describe('discoverDependencies external documents', () => {
        it('should ignore unresolved, missing, and root external documents', async () => {
            const unresolved = await readFileCache('update_children_xr', 'file_not_exist.tex')
            assert.deepStrictEqual(await discover(unresolved, unresolved.filePath), [])

            const source = await readFileCache('update_children_xr', 'input_main.tex')
            const exists = sandbox.stub(lw.file, 'exists').resolves(false)
            assert.deepStrictEqual(await discover(source, source.filePath), [])
            exists.restore()

            const rootPath = get.path(fixture, 'main.tex')
            assert.deepStrictEqual(await discover(source, rootPath), [])
        })

        it('should describe an external owner, separate refresh root, and prefix', async () => {
            const externalPath = get.path(fixture, 'main.tex')
            const rootPath = get.path(fixture, 'another.tex')
            const source = await readFileCache('update_children_xr', 'input_main_prefix.tex')

            assert.deepStrictEqual(await discover(source, rootPath), [{
                kind: 'external',
                filePath: externalPath,
                prefix: 'prefix',
                ownerPath: rootPath,
                rootPath: externalPath
            }])
        })

        it('should resolve external documents next to the root and in latex.texDirs', async () => {
            const rootPath = get.path(fixture, 'update_children_xr', 'sub', 'main.tex')
            const externalPath = get.path(fixture, 'update_children_xr', 'sub', 'sub.tex')
            const source = await readFileCache('update_children_xr', 'input_sub.tex')

            assert.pathStrictEqual((await discover(source, rootPath))[0].filePath, externalPath)

            set.config('latex.texDirs', [get.path(fixture, 'update_children_xr', 'sub')])
            const otherRoot = get.path(fixture, 'main.tex')
            assert.pathStrictEqual((await discover(source, otherRoot))[0].filePath, externalPath)
        })

        it('should reject an external document equivalent to the normalized root', async () => {
            const source = createFileCache('C:\\Project\\source.tex', '\\externaldocument{root}')
            sandbox.stub(coreUtils, 'resolveFile').resolves('c:/Project/nested/../root.tex')
            sandbox.stub(lw.file, 'exists').resolves({type: 1, ctime: 0, mtime: 0, size: 0})

            assert.deepStrictEqual(await discover(source, 'C:\\Project\\root.tex'), [])
        })
    })

    describe('getIncludedTeX', () => {
        const lookup = (filePath: string) => caches.get(filePath)

        it('should return the supplied Set unchanged without a starting file', () => {
            const included = new Set(['/seed.tex'])
            const result = getIncludedTeX(undefined, lookup, included)
            assert.strictEqual(result, included)
            assert.deepStrictEqual([...result], ['/seed.tex'])
        })

        it('should return an empty Set when the starting file is not cached', () => {
            assert.strictEqual(getIncludedTeX('/missing.tex', lookup).size, 0)
        })

        it('should traverse depth first while preventing cycles and shared duplicates', () => {
            const root = createFileCache('/root.tex')
            const first = createFileCache('/first.tex')
            const second = createFileCache('/second.tex')
            const shared = createFileCache('/shared.tex')
            root.children.push({filePath: first.filePath, index: 0}, {filePath: second.filePath, index: 1})
            first.children.push({filePath: root.filePath, index: 0}, {filePath: shared.filePath, index: 1})
            second.children.push({filePath: shared.filePath, index: 0})
            for (const cache of [root, first, second, shared]) {
                caches.set(cache.filePath, cache)
            }

            assert.deepStrictEqual(
                [...getIncludedTeX(root.filePath, lookup)],
                [root.filePath, first.filePath, shared.filePath, second.filePath]
            )
        })

        it('should traverse and return only the first form of equivalent Windows paths', () => {
            const root = createFileCache('C:\\Project\\root.tex')
            const child = createFileCache('C:\\Project\\child.tex')
            const firstChildPath = 'c:/Project/nested/../child.tex'
            root.children.push(
                {filePath: firstChildPath, index: 0},
                {filePath: child.filePath, index: 1}
            )
            child.children.push({filePath: 'c:/Project/root.tex', index: 0})
            caches.set(CacheStore.normalizePath(root.filePath), root)
            caches.set(CacheStore.normalizePath(child.filePath), child)
            const normalizedLookup = (filePath: string) => caches.get(CacheStore.normalizePath(filePath))

            assert.deepStrictEqual(
                [...getIncludedTeX(root.filePath, normalizedLookup)],
                [root.filePath, firstChildPath]
            )
        })
    })
})
