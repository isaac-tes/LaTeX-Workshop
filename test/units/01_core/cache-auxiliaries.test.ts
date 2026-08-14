import * as vscode from 'vscode'
import * as path from 'path'
import * as sinon from 'sinon'

import { assert, get, mock, set } from '../utils'
import { lw } from '../../../src/lw'
import type { FileCache } from '../../../src/types'
import {
    type AuxiliaryContext,
    getFlsChildren,
    loadFlsFile,
    parseAuxContent,
    parseFlsContent
} from '../../../src/core/cache/auxiliaries'

describe(path.basename(__filename).split('.')[0] + ':', () => {
    const fixture = get.path('01_core', 'cache')
    let sandbox: sinon.SinonSandbox
    let caches: Map<string, FileCache>
    let isExcluded: sinon.SinonStub
    let watchSource: sinon.SinonStub
    let refreshSource: sinon.SinonStub
    let context: AuxiliaryContext
    let watchedSources: Set<string>
    let watchedBibliographies: Set<string>
    let addBibliography: sinon.SinonStub
    const existingFile: vscode.FileStat = {
        type: vscode.FileType.File,
        ctime: 0,
        mtime: 0,
        size: 0
    }

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

    before(() => {
        mock.init(lw, 'watcher', 'cache')
    })

    beforeEach(() => {
        sandbox = sinon.createSandbox()
        caches = new Map()
        isExcluded = sandbox.stub().returns(false)
        watchSource = sandbox.stub()
        refreshSource = sandbox.stub().resolves()
        context = {
            getCache: filePath => caches.get(filePath),
            isExcluded,
            watchSource,
            refreshSource
        }
        watchedSources = new Set()
        watchedBibliographies = new Set()
        sandbox.stub(lw.watcher.src, 'has').callsFake(uri => watchedSources.has(uri.fsPath))
        sandbox.stub(lw.watcher.bib, 'has').callsFake(uri => watchedBibliographies.has(uri.fsPath))
        addBibliography = sandbox.stub(lw.watcher.bib, 'add').callsFake(uri => {
            watchedBibliographies.add(uri.fsPath)
        })
        set.config('latex.watch.files.ignore', [])
    })

    afterEach(() => {
        sandbox.restore()
    })

    after(() => {
        sinon.restore()
    })

    describe('content parsers', () => {
        it('should parse unique FLS entries in first-encounter order', () => {
            const rootDir = get.path(fixture, 'load_fls_file')
            const result = parseFlsContent([
                'INPUT ./one.tex',
                'OUTPUT ./one.aux',
                'INPUT ./one.tex',
                'OUTPUT ./two.aux',
                'ignored'
            ].join('\n'), rootDir)

            assert.pathListStrictEqual(result.input, [path.resolve(rootDir, 'one.tex')])
            assert.pathListStrictEqual(result.output, [
                path.resolve(rootDir, 'one.aux'),
                path.resolve(rootDir, 'two.aux')
            ])
            assert.deepStrictEqual(parseFlsContent('', rootDir), {input: [], output: []})
        })

        it('should preserve AUX command grouping, order, and empty commands', () => {
            assert.deepStrictEqual(parseAuxContent([
                '\\bibdata{ first, second } trailing',
                ' \\bibdata{ignored}',
                '\\bibdata{ , }',
                '\\bibdata{third}'
            ].join('\n')), {
                bibdata: [['first', 'second'], [], ['third']]
            })
        })
    })

    describe('loadFlsFile inputs', () => {
        it('should return before logging when no FLS file exists', async () => {
            const owner = get.path(fixture, 'another.tex')

            await loadFlsFile(owner, context)

            assert.notHasLog('Parsing .fls ')
            sinon.assert.notCalled(watchSource)
        })

        it('should parse an unreadable FLS file as empty', async () => {
            const owner = get.path(fixture, 'load_fls_file', 'include_main.tex')
            const flsPath = get.path(fixture, 'load_fls_file', 'include_main.fls')
            sandbox.stub(lw.file, 'read').withArgs(flsPath).resolves(undefined)

            await loadFlsFile(owner, context)

            assert.hasLog(`Parsed .fls ${flsPath} .`)
            sinon.assert.notCalled(watchSource)
        })

        it('should filter output overlap, exclusions, missing files, self, and watched inputs in order', async () => {
            const owner = '/project/main.tex'
            const flsPath = '/project/main.fls'
            const excluded = '/project/excluded.tex'
            const missing = '/project/missing.tex'
            const watched = '/project/watched.tex'
            sandbox.stub(lw.file, 'getFlsPath').withArgs(owner).resolves(flsPath)
            sandbox.stub(lw.file, 'read').withArgs(flsPath).resolves([
                'INPUT overlap.tex',
                'INPUT excluded.tex',
                'INPUT missing.tex',
                'INPUT main.tex',
                'INPUT watched.tex',
                'OUTPUT overlap.tex'
            ].join('\n'))
            const exists = sandbox.stub(lw.file, 'exists').callsFake(filePath => Promise.resolve(filePath === missing ? false : existingFile))
            isExcluded.withArgs(excluded).returns(true)
            watchedSources.add(watched)

            await loadFlsFile(owner, context)

            sinon.assert.neverCalledWith(exists, '/project/overlap.tex')
            sinon.assert.neverCalledWith(exists, excluded)
            sinon.assert.notCalled(watchSource)
        })

        it('should recover an owner before appending a case-insensitive TeX child at the end', async () => {
            const owner = '/project/main.tex'
            const child = '/project/CHILD.TeX'
            const ownerCache = createFileCache(owner)
            ownerCache.children.push({index: 1, filePath: '/project/source-child.tex'})
            sandbox.stub(lw.file, 'getFlsPath').withArgs(owner).resolves('/project/main.fls')
            sandbox.stub(lw.file, 'read').resolves('INPUT CHILD.TeX')
            sandbox.stub(lw.file, 'exists').resolves(existingFile)
            const neverFinishes = new Promise<void>(() => {})
            refreshSource.callsFake(async (filePath: string) => {
                if (filePath === owner) {
                    caches.set(owner, ownerCache)
                    return
                }
                return neverFinishes
            })

            await loadFlsFile(owner, context)

            assert.deepStrictEqual(ownerCache.children, [
                {index: 1, filePath: '/project/source-child.tex'},
                {index: Number.MAX_VALUE, filePath: child}
            ])
            assert.deepStrictEqual(refreshSource.firstCall.args, [owner])
            assert.deepStrictEqual(refreshSource.secondCall.args, [child, owner])
            sinon.assert.calledOnceWithExactly(watchSource, child)
        })

        it('should stop after an attempted owner refresh still leaves no cache', async () => {
            const owner = '/project/main.tex'
            sandbox.stub(lw.file, 'getFlsPath').resolves('/project/main.fls')
            sandbox.stub(lw.file, 'read').resolves('INPUT child.tex')
            sandbox.stub(lw.file, 'exists').resolves(existingFile)

            await loadFlsFile(owner, context)

            sinon.assert.calledOnceWithExactly(refreshSource, owner)
            sinon.assert.notCalled(watchSource)
            assert.hasLog(`Cache not finished on ${owner} when parsing fls.`)
        })

        it('should watch existing AUX, OUT, and other non-TeX inputs without special cases', async () => {
            const owner = '/project/main.tex'
            sandbox.stub(lw.file, 'getFlsPath').resolves('/project/main.fls')
            sandbox.stub(lw.file, 'read').resolves([
                'INPUT generated.aux',
                'INPUT generated.OUT',
                'INPUT image.pdf'
            ].join('\n'))
            sandbox.stub(lw.file, 'exists').resolves(existingFile)

            await loadFlsFile(owner, context)

            assert.pathListStrictEqual(watchSource.args.map(args => args[0] as string), [
                '/project/generated.aux',
                '/project/generated.OUT',
                '/project/image.pdf'
            ])
        })

        it('should propagate input errors and stop before the final parsed log', async () => {
            const owner = '/project/main.tex'
            sandbox.stub(lw.file, 'getFlsPath').resolves('/project/main.fls')
            sandbox.stub(lw.file, 'read').resolves('INPUT child.tex')
            sandbox.stub(lw.file, 'exists').rejects(new Error('exists failed'))

            await assert.rejects(loadFlsFile(owner, context), /exists failed/)

            assert.notHasLog('Parsed .fls /project/main.fls .')
        })
    })

    describe('loadFlsFile AUX outputs', () => {
        it('should parse AUX extensions case-insensitively and map nested relative AUX directories', async () => {
            const owner = '/project/main.tex'
            const ownerCache = createFileCache(owner)
            const auxPath = '/project/build/chap/main.AuX'
            const bibPath = '/project/chap/references.bib'
            caches.set(owner, ownerCache)
            sandbox.stub(lw.file, 'getFlsPath').resolves('/project/main.fls')
            sandbox.stub(lw.file, 'getAuxDir').returns('build')
            sandbox.stub(lw.file, 'read').callsFake(filePath => Promise.resolve(filePath.endsWith('.fls')
                ? 'OUTPUT build/chap/main.AuX'
                : '\\bibdata{references}'))
            sandbox.stub(lw.file, 'exists').withArgs(auxPath).resolves(existingFile)
            const getBibPath = sandbox.stub(lw.file, 'getBibPath').resolves([bibPath])

            await loadFlsFile(owner, context)

            sinon.assert.calledOnceWithExactly(getBibPath, 'references', '/project/chap')
            assert.deepStrictEqual([...ownerCache.bibfiles], [bibPath])
            assert.strictEqual((addBibliography.firstCall.args[0] as vscode.Uri).fsPath, bibPath)
        })

        it('should support an absolute AUX root and fall back for outputs outside it', async () => {
            const owner = '/project/main.tex'
            const ownerCache = createFileCache(owner)
            caches.set(owner, ownerCache)
            sandbox.stub(lw.file, 'getFlsPath').resolves('/project/main.fls')
            sandbox.stub(lw.file, 'getAuxDir').returns('/build')
            sandbox.stub(lw.file, 'read').callsFake(filePath => Promise.resolve(filePath.endsWith('.fls')
                ? ['OUTPUT /build/main.aux', 'OUTPUT /elsewhere/other.aux'].join('\n')
                : '\\bibdata{references}'))
            sandbox.stub(lw.file, 'exists').resolves(existingFile)
            const getBibPath = sandbox.stub(lw.file, 'getBibPath').resolves([])

            await loadFlsFile(owner, context)

            assert.deepStrictEqual(getBibPath.firstCall.args, ['references', '/project'])
            assert.deepStrictEqual(getBibPath.secondCall.args, ['references', '/elsewhere'])
        })

        it('should skip missing and non-AUX outputs', async () => {
            const owner = '/project/main.tex'
            sandbox.stub(lw.file, 'getFlsPath').resolves('/project/main.fls')
            sandbox.stub(lw.file, 'read').resolves([
                'OUTPUT main.pdf',
                'OUTPUT missing.aux'
            ].join('\n'))
            sandbox.stub(lw.file, 'exists').resolves(false)
            const getBibPath = sandbox.stub(lw.file, 'getBibPath')

            await loadFlsFile(owner, context)

            sinon.assert.notCalled(getBibPath)
        })

        it('should preserve command and resolved-path order while handling empty, excluded, duplicate, and watched bibs', async () => {
            const owner = '/project/main.tex'
            const ownerCache = createFileCache(owner)
            ownerCache.bibfiles.add('/bib/existing.bib')
            caches.set(owner, ownerCache)
            sandbox.stub(lw.file, 'getFlsPath').resolves('/project/main.fls')
            sandbox.stub(lw.file, 'read').callsFake(filePath => Promise.resolve(filePath.endsWith('.fls')
                ? 'OUTPUT main.aux'
                : ['\\bibdata{ }', '\\bibdata{first, existing, excluded}', '\\bibdata{first}'].join('\n')))
            sandbox.stub(lw.file, 'exists').resolves(existingFile)
            const bibPaths: Record<string, string[]> = {
                first: ['/bib/one.bib', '/bib/two.bib'],
                existing: ['/bib/existing.bib'],
                excluded: ['/bib/excluded.bib']
            }
            sandbox.stub(lw.file, 'getBibPath').callsFake(bib => Promise.resolve(bibPaths[bib] ?? []))
            isExcluded.withArgs('/bib/excluded.bib').returns(true)
            watchedBibliographies.add('/bib/two.bib')

            await loadFlsFile(owner, context)

            assert.deepStrictEqual([...ownerCache.bibfiles], [
                '/bib/existing.bib',
                '/bib/one.bib',
                '/bib/two.bib'
            ])
            assert.hasLog('Empty \\bibdata in .aux /project/main.aux , skip.')
            assert.pathListStrictEqual(addBibliography.args.map(args => (args[0] as vscode.Uri).fsPath), [
                '/bib/one.bib',
                '/bib/existing.bib'
            ])
        })

        it('should keep AUX bibliography on the fixed FLS owner when the global root differs', async () => {
            const owner = '/project/owner.tex'
            const otherRoot = '/project/other.tex'
            const ownerCache = createFileCache(owner)
            const otherCache = createFileCache(otherRoot)
            caches.set(owner, ownerCache)
            caches.set(otherRoot, otherCache)
            set.root('/project', 'other.tex')
            sandbox.stub(lw.file, 'getFlsPath').resolves('/project/owner.fls')
            sandbox.stub(lw.file, 'read').callsFake(filePath => Promise.resolve(filePath.endsWith('.fls')
                ? 'OUTPUT owner.aux'
                : '\\bibdata{references}'))
            sandbox.stub(lw.file, 'exists').resolves(existingFile)
            sandbox.stub(lw.file, 'getBibPath').callsFake(() => {
                set.root('/project', 'changed.tex')
                return Promise.resolve(['/project/references.bib'])
            })

            await loadFlsFile(owner, context)

            assert.deepStrictEqual([...ownerCache.bibfiles], ['/project/references.bib'])
            assert.deepStrictEqual([...otherCache.bibfiles], [])
        })

        it('should still watch bibliography files when the fixed owner has no cache', async () => {
            const owner = '/project/main.tex'
            sandbox.stub(lw.file, 'getFlsPath').resolves('/project/main.fls')
            sandbox.stub(lw.file, 'read').callsFake(filePath => Promise.resolve(filePath.endsWith('.fls')
                ? 'OUTPUT main.aux'
                : '\\bibdata{references}'))
            sandbox.stub(lw.file, 'exists').resolves(existingFile)
            sandbox.stub(lw.file, 'getBibPath').resolves(['/project/references.bib'])

            await loadFlsFile(owner, context)

            sinon.assert.calledOnce(addBibliography)
            assert.hasLog('Found .bib /project/references.bib from .aux /project/main.aux .')
        })

        it('should parse unreadable AUX files as empty', async () => {
            const owner = '/project/main.tex'
            caches.set(owner, createFileCache(owner))
            sandbox.stub(lw.file, 'getFlsPath').resolves('/project/main.fls')
            sandbox.stub(lw.file, 'read').callsFake(filePath => Promise.resolve(filePath.endsWith('.fls') ? 'OUTPUT main.aux' : undefined))
            sandbox.stub(lw.file, 'exists').resolves(existingFile)
            const getBibPath = sandbox.stub(lw.file, 'getBibPath')

            await loadFlsFile(owner, context)

            sinon.assert.notCalled(getBibPath)
        })
    })

    describe('getFlsChildren', () => {
        it('should return no children without an FLS file', async () => {
            assert.deepStrictEqual(await getFlsChildren(get.path(fixture, 'another.tex')), [])
        })

        it('should return every parsed input without workflow filtering', async () => {
            const owner = '/project/main.tex'
            sandbox.stub(lw.file, 'getFlsPath').resolves('/project/main.fls')
            sandbox.stub(lw.file, 'read').resolves([
                'INPUT main.tex',
                'INPUT missing.aux',
                'INPUT ignored.out',
                'OUTPUT missing.aux'
            ].join('\n'))

            assert.deepStrictEqual(await getFlsChildren(owner), [
                '/project/main.tex',
                '/project/missing.aux',
                '/project/ignored.out'
            ])
            sinon.assert.notCalled(isExcluded)
        })

        it('should treat an unreadable FLS file as empty', async () => {
            sandbox.stub(lw.file, 'getFlsPath').resolves('/project/main.fls')
            sandbox.stub(lw.file, 'read').resolves(undefined)

            assert.deepStrictEqual(await getFlsChildren('/project/main.tex'), [])
        })
    })
})
