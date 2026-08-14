import * as vscode from 'vscode'
import * as path from 'path'
import * as sinon from 'sinon'

import { assert, get, mock, set } from '../utils'
import { lw } from '../../../src/lw'
import type { FileCache } from '../../../src/types'
import {
    type DependencyContext,
    getIncludedTeX,
    updateDependencies
} from '../../../src/core/cache/dependencies'

describe(path.basename(__filename).split('.')[0] + ':', () => {
    const fixture = get.path('01_core', 'cache')
    let caches: Map<string, FileCache>
    let watchSource: sinon.SinonSpy
    let refreshSource: sinon.SinonSpy
    let context: DependencyContext

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

    before(() => {
        mock.init(lw, 'watcher', 'cache')
    })

    beforeEach(() => {
        caches = new Map()
        watchSource = sinon.spy()
        refreshSource = sinon.spy()
        context = {
            getCache: filePath => caches.get(filePath),
            watchSource,
            refreshSource
        }
    })

    after(() => {
        sinon.restore()
    })

    describe('updateDependencies inputs', () => {
        it('should leave children empty when there are no dependencies', async () => {
            const fileCache = await readFileCache('main.tex')

            await updateDependencies(fileCache, fileCache.filePath, context)

            assert.listStrictEqual(fileCache.children, [])
            sinon.assert.notCalled(watchSource)
            sinon.assert.notCalled(refreshSource)
        })

        it('should stop scanning when an input cannot be resolved', async () => {
            const fileCache = createFileCache(
                get.path(fixture, 'update_children', 'virtual.tex'),
                '\\input{missing.tex}\\input{../main.tex}'
            )

            await updateDependencies(fileCache, fileCache.filePath, context)

            assert.listStrictEqual(fileCache.children, [])
            sinon.assert.notCalled(watchSource)
        })

        it('should ignore an input that resolves to the root', async () => {
            const rootPath = get.path(fixture, 'main.tex')
            const fileCache = await readFileCache('update_children', 'input_main.tex')

            await updateDependencies(fileCache, rootPath, context)

            assert.listStrictEqual(fileCache.children, [])
        })

        it('should add, watch, and schedule an input with the inherited root', async () => {
            const inputPath = get.path(fixture, 'main.tex')
            const rootPath = get.path(fixture, 'another.tex')
            const fileCache = await readFileCache('update_children', 'input_main.tex')

            await updateDependencies(fileCache, rootPath, context)

            assert.pathListStrictEqual(fileCache.children.map(child => child.filePath), [inputPath])
            sinon.assert.calledOnceWithExactly(watchSource, inputPath)
            sinon.assert.calledOnceWithExactly(refreshSource, inputPath, rootPath)
        })

        it('should preserve input order when scheduling multiple children', async () => {
            const mainPath = get.path(fixture, 'main.tex')
            const anotherPath = get.path(fixture, 'another.tex')
            const fileCache = await readFileCache('update_children', 'two_inputs.tex')

            await updateDependencies(fileCache, fileCache.filePath, context)

            assert.pathListStrictEqual(
                fileCache.children.map(child => child.filePath),
                [mainPath, anotherPath]
            )
            assert.deepStrictEqual(refreshSource.args, [
                [mainPath, fileCache.filePath],
                [anotherPath, fileCache.filePath]
            ])
        })

        it('should keep the first source index for duplicate inputs', async () => {
            const inputPath = get.path(fixture, 'main.tex')
            const fileCache = await readFileCache('update_children', 'two_same_inputs.tex')
            const firstIndex = fileCache.contentTrimmed.indexOf('\\input')

            await updateDependencies(fileCache, fileCache.filePath, context)

            assert.strictEqual(fileCache.children.length, 1)
            assert.pathStrictEqual(fileCache.children[0].filePath, inputPath)
            assert.strictEqual(fileCache.children[0].index, firstIndex)
            sinon.assert.calledOnce(watchSource)
            sinon.assert.calledOnce(refreshSource)
        })

        it('should add but not reschedule an input that is already watched', async () => {
            const inputPath = get.path(fixture, 'main.tex')
            const fileCache = await readFileCache('update_children', 'input_main.tex')
            lw.watcher.src.add(vscode.Uri.file(inputPath))

            await updateDependencies(fileCache, fileCache.filePath, context)

            assert.pathListStrictEqual(fileCache.children.map(child => child.filePath), [inputPath])
            sinon.assert.notCalled(watchSource)
            sinon.assert.notCalled(refreshSource)
        })

        it('should exhaust input matches before earlier noweb child matches', async () => {
            const inputPath = get.path(fixture, 'main.tex')
            const childPath = get.path(fixture, 'another.tex')
            const fileCache = createFileCache(
                get.path(fixture, 'update_children', 'virtual.tex'),
                "<<child='../another.tex'>>=\n\\input{../main.tex}"
            )

            await updateDependencies(fileCache, fileCache.filePath, context)

            assert.pathListStrictEqual(
                fileCache.children.map(child => child.filePath),
                [inputPath, childPath]
            )
            assert.ok(fileCache.children[0].index > fileCache.children[1].index)
        })
    })

    describe('updateDependencies external documents', () => {
        it('should ignore an external document that cannot be resolved', async () => {
            const fileCache = await readFileCache('update_children_xr', 'file_not_exist.tex')
            caches.set(fileCache.filePath, fileCache)

            await updateDependencies(fileCache, fileCache.filePath, context)

            assert.deepStrictEqual(fileCache.external, {})
            sinon.assert.notCalled(watchSource)
        })

        it('should ignore an external document that resolves to the root', async () => {
            const rootPath = get.path(fixture, 'main.tex')
            const fileCache = await readFileCache('update_children_xr', 'input_main.tex')
            caches.set(rootPath, createFileCache(rootPath))

            await updateDependencies(fileCache, rootPath, context)

            assert.deepStrictEqual(caches.get(rootPath)?.external, {})
            sinon.assert.notCalled(watchSource)
        })

        it('should attach an external document to the root cache', async () => {
            const externalPath = get.path(fixture, 'main.tex')
            const rootPath = get.path(fixture, 'another.tex')
            const rootCache = createFileCache(rootPath)
            const fileCache = await readFileCache('update_children_xr', 'input_main.tex')
            caches.set(rootPath, rootCache)

            await updateDependencies(fileCache, rootPath, context)

            assert.deepStrictEqual(rootCache.external, {[externalPath]: ''})
            assert.deepStrictEqual(fileCache.external, {})
            sinon.assert.calledOnceWithExactly(watchSource, externalPath)
            sinon.assert.calledOnceWithExactly(refreshSource, externalPath, externalPath)
        })

        it('should resolve an external document next to the source', async () => {
            const externalPath = get.path(fixture, 'main.tex')
            const fileCache = await readFileCache('update_children_xr', 'input_main.tex')
            caches.set(fileCache.filePath, fileCache)

            await updateDependencies(fileCache, fileCache.filePath, context)

            assert.deepStrictEqual(fileCache.external, {[externalPath]: ''})
        })

        it('should resolve an external document next to the root', async () => {
            const rootPath = get.path(fixture, 'update_children_xr', 'sub', 'main.tex')
            const externalPath = get.path(fixture, 'update_children_xr', 'sub', 'sub.tex')
            const rootCache = createFileCache(rootPath)
            const fileCache = await readFileCache('update_children_xr', 'input_sub.tex')
            caches.set(rootPath, rootCache)

            await updateDependencies(fileCache, rootPath, context)

            assert.deepStrictEqual(rootCache.external, {[externalPath]: ''})
        })

        it('should resolve an external document from latex.texDirs', async () => {
            const rootPath = get.path(fixture, 'main.tex')
            const externalPath = get.path(fixture, 'update_children_xr', 'sub', 'sub.tex')
            const rootCache = createFileCache(rootPath)
            const fileCache = await readFileCache('update_children_xr', 'input_sub.tex')
            caches.set(rootPath, rootCache)
            set.config('latex.texDirs', [get.path(fixture, 'update_children_xr', 'sub')])

            await updateDependencies(fileCache, rootPath, context)

            assert.deepStrictEqual(rootCache.external, {[externalPath]: ''})
        })

        it('should preserve an external document prefix', async () => {
            const externalPath = get.path(fixture, 'main.tex')
            const fileCache = await readFileCache('update_children_xr', 'input_main_prefix.tex')
            caches.set(fileCache.filePath, fileCache)

            await updateDependencies(fileCache, fileCache.filePath, context)

            assert.deepStrictEqual(fileCache.external, {[externalPath]: 'prefix'})
        })

        it('should not reschedule an external document that is already watched', async () => {
            const externalPath = get.path(fixture, 'main.tex')
            const fileCache = await readFileCache('update_children_xr', 'input_main.tex')
            caches.set(fileCache.filePath, fileCache)
            lw.watcher.src.add(vscode.Uri.file(externalPath))

            await updateDependencies(fileCache, fileCache.filePath, context)

            assert.deepStrictEqual(fileCache.external, {[externalPath]: ''})
            sinon.assert.notCalled(watchSource)
            sinon.assert.notCalled(refreshSource)
        })

        it('should still schedule an external document when the root cache is missing', async () => {
            const externalPath = get.path(fixture, 'main.tex')
            const fileCache = await readFileCache('update_children_xr', 'input_main.tex')

            await updateDependencies(fileCache, fileCache.filePath, context)

            assert.deepStrictEqual(fileCache.external, {})
            sinon.assert.calledOnceWithExactly(watchSource, externalPath)
            sinon.assert.calledOnceWithExactly(refreshSource, externalPath, externalPath)
        })
    })

    describe('getIncludedTeX', () => {
        it('should return the supplied Set unchanged without a starting file', () => {
            const included = new Set(['/seed.tex'])

            const result = getIncludedTeX(undefined, context, included)

            assert.strictEqual(result, included)
            assert.deepStrictEqual([...result], ['/seed.tex'])
        })

        it('should return an empty Set when the starting file is not cached', () => {
            assert.strictEqual(getIncludedTeX('/missing.tex', context).size, 0)
        })

        it('should traverse dependencies depth first in child order', () => {
            const root = createFileCache('/root.tex')
            const first = createFileCache('/first.tex')
            const second = createFileCache('/second.tex')
            root.children.push(
                {filePath: first.filePath, index: 0},
                {filePath: second.filePath, index: 1}
            )
            caches.set(root.filePath, root)
            caches.set(first.filePath, first)
            caches.set(second.filePath, second)

            const result = getIncludedTeX(root.filePath, context)

            assert.deepStrictEqual([...result], [root.filePath, first.filePath, second.filePath])
        })

        it('should prevent cycles and de-duplicate shared descendants', () => {
            const root = createFileCache('/root.tex')
            const first = createFileCache('/first.tex')
            const second = createFileCache('/second.tex')
            const shared = createFileCache('/shared.tex')
            root.children.push(
                {filePath: first.filePath, index: 0},
                {filePath: second.filePath, index: 1}
            )
            first.children.push(
                {filePath: root.filePath, index: 0},
                {filePath: shared.filePath, index: 1}
            )
            second.children.push({filePath: shared.filePath, index: 0})
            for (const cache of [root, first, second, shared]) {
                caches.set(cache.filePath, cache)
            }

            const result = getIncludedTeX(root.filePath, context)

            assert.deepStrictEqual([...result], [root.filePath, first.filePath, shared.filePath, second.filePath])
        })
    })
})
