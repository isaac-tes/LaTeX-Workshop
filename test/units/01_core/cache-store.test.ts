import * as path from 'path'
import { assert } from '../utils'
import type { FileCache } from '../../../src/types'
import { CacheStore } from '../../../src/core/cache/store'

describe(path.basename(__filename).split('.')[0] + ':', () => {
    function createFileCache(filePath: string): FileCache {
        return {
            filePath,
            content: '',
            contentTrimmed: '',
            elements: {},
            children: [],
            bibfiles: new Set(),
            glossarybibfiles: new Set(),
            external: {}
        }
    }

    it('should store, list, delete, and clear cache entries', () => {
        const store = new CacheStore()
        const first = createFileCache('/first.tex')
        const second = createFileCache('/second.tex')

        assert.strictEqual(store.get(first.filePath), undefined)
        store.set(first.filePath, first)
        store.set(second.filePath, second)

        assert.strictEqual(store.get(first.filePath), first)
        assert.listStrictEqual(store.paths(), [first.filePath, second.filePath])
        assert.strictEqual(store.delete(first.filePath), true)
        assert.strictEqual(store.delete(first.filePath), false)

        store.clear()
        assert.listStrictEqual(store.paths(), [])
    })

    it('should keep in-flight maps independent and separate from cache clearing', () => {
        const first = new CacheStore()
        const second = new CacheStore()
        const task = Promise.resolve()

        first.promises.set('/first.tex', task)
        first.clear()

        assert.strictEqual(first.promises.get('/first.tex'), task)
        assert.strictEqual(second.promises.get('/first.tex'), undefined)
        assert.notStrictEqual(first.promises, second.promises)
    })
})
