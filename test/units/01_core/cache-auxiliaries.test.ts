import * as path from 'path'
import * as sinon from 'sinon'

import { assert, collectAsync, get, mock } from '../utils'
import { lw } from '../../../src/lw'
import {
    type AuxiliaryDiscovery,
    discoverFls,
    getFlsChildren,
    parseAuxContent,
    parseFlsContent
} from '../../../src/core/cache/auxiliaries'

describe(path.basename(__filename).split('.')[0] + ':', () => {
    const fixture = get.path('01_core', 'cache')
    const projectDir = path.resolve('/project')
    const absoluteAuxDir = path.resolve('/build')
    const elsewhereDir = path.resolve('/elsewhere')
    const existingFile = {type: 1, ctime: 0, mtime: 0, size: 0}
    let sandbox: sinon.SinonSandbox

    function projectPath(...segments: string[]): string {
        return path.join(projectDir, ...segments)
    }

    async function discover(owner: string): Promise<AuxiliaryDiscovery[]> {
        return collectAsync(discoverFls(owner))
    }

    before(() => {
        mock.init(lw, 'watcher', 'cache')
    })

    beforeEach(() => {
        sandbox = sinon.createSandbox()
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
            ].join('\n')), {bibdata: [['first', 'second'], [], ['third']]})
        })
    })

    describe('discoverFls inputs', () => {
        it('should return without logging when no FLS file exists', async () => {
            assert.deepStrictEqual(await discover(get.path(fixture, 'another.tex')), [])
            assert.notHasLog('Parsing .fls ')
        })

        it('should parse an unreadable FLS file as empty', async () => {
            const owner = get.path(fixture, 'load_fls_file', 'include_main.tex')
            const flsPath = get.path(fixture, 'load_fls_file', 'include_main.fls')
            sandbox.stub(lw.file, 'read').withArgs(flsPath).resolves(undefined)

            assert.deepStrictEqual(await discover(owner), [])
            assert.hasLog(`Parsed .fls ${flsPath} .`)
        })

        it('should filter only output overlap and classify all extensions case-insensitively', async () => {
            const owner = projectPath('main.tex')
            const flsPath = projectPath('main.fls')
            sandbox.stub(lw.file, 'getFlsPath').withArgs(owner).resolves(flsPath)
            sandbox.stub(lw.file, 'read').withArgs(flsPath).resolves([
                'INPUT overlap.tex',
                'INPUT CHILD.TeX',
                'INPUT generated.AUX',
                'INPUT image.pdf',
                'OUTPUT overlap.tex'
            ].join('\n'))

            assert.deepStrictEqual(await discover(owner), [
                {kind: 'input', filePath: projectPath('CHILD.TeX'), flsPath, isTeX: true, ownerPath: owner},
                {kind: 'input', filePath: projectPath('generated.AUX'), flsPath, isTeX: false, ownerPath: owner},
                {kind: 'input', filePath: projectPath('image.pdf'), flsPath, isTeX: false, ownerPath: owner}
            ])
        })
    })

    describe('discoverFls AUX outputs', () => {
        it('should map nested relative AUX directories and pass fixed owner root and source base', async () => {
            const owner = projectPath('main.tex')
            const flsPath = projectPath('main.fls')
            const auxPath = projectPath('build', 'chap', 'main.AuX')
            sandbox.stub(lw.file, 'getFlsPath').resolves(flsPath)
            sandbox.stub(lw.file, 'getAuxDir').returns('build')
            sandbox.stub(lw.file, 'read').callsFake(filePath => Promise.resolve(filePath === flsPath
                ? 'OUTPUT build/chap/main.AuX'
                : '\\bibdata{references}'))
            sandbox.stub(lw.file, 'exists').withArgs(auxPath).resolves(existingFile)
            const getBibPath = sandbox.stub(lw.file, 'getBibPath').resolves(['/bib/references.bib'])

            assert.deepStrictEqual(await discover(owner), [{
                kind: 'bibliography',
                filePath: '/bib/references.bib',
                auxPath,
                ownerPath: owner
            }])
            sinon.assert.calledOnceWithExactly(getBibPath, 'references', projectDir, projectPath('chap'))
        })

        it('should support an absolute AUX root and preserve output directories outside it', async () => {
            const owner = projectPath('main.tex')
            const flsPath = projectPath('main.fls')
            sandbox.stub(lw.file, 'getFlsPath').resolves(flsPath)
            sandbox.stub(lw.file, 'getAuxDir').returns(absoluteAuxDir)
            sandbox.stub(lw.file, 'read').callsFake(filePath => Promise.resolve(filePath === flsPath
                ? [`OUTPUT ${path.join(absoluteAuxDir, 'main.aux')}`, `OUTPUT ${path.join(elsewhereDir, 'other.aux')}`].join('\n')
                : '\\bibdata{references}'))
            sandbox.stub(lw.file, 'exists').resolves(existingFile)
            const getBibPath = sandbox.stub(lw.file, 'getBibPath').resolves([])

            await discover(owner)

            assert.deepStrictEqual(getBibPath.firstCall.args, ['references', projectDir, projectDir])
            assert.deepStrictEqual(getBibPath.secondCall.args, ['references', projectDir, elsewhereDir])
        })

        it('should skip non-AUX and missing AUX outputs', async () => {
            const owner = projectPath('main.tex')
            sandbox.stub(lw.file, 'getFlsPath').resolves(projectPath('main.fls'))
            sandbox.stub(lw.file, 'read').resolves('OUTPUT main.pdf\nOUTPUT missing.aux')
            sandbox.stub(lw.file, 'exists').resolves(false)
            const getBibPath = sandbox.stub(lw.file, 'getBibPath')

            assert.deepStrictEqual(await discover(owner), [])
            sinon.assert.notCalled(getBibPath)
        })

        it('should preserve command and path order while logging empty bibdata', async () => {
            const owner = projectPath('main.tex')
            const flsPath = projectPath('main.fls')
            const auxPath = projectPath('main.aux')
            sandbox.stub(lw.file, 'getFlsPath').resolves(flsPath)
            sandbox.stub(lw.file, 'read').callsFake(filePath => Promise.resolve(filePath === flsPath
                ? 'OUTPUT main.aux'
                : '\\bibdata{ }\n\\bibdata{first,second}'))
            sandbox.stub(lw.file, 'exists').resolves(existingFile)
            sandbox.stub(lw.file, 'getBibPath').callsFake(bib => Promise.resolve([`/bib/${bib}.bib`]))

            assert.deepStrictEqual(await discover(owner), [
                {kind: 'bibliography', filePath: '/bib/first.bib', auxPath, ownerPath: owner},
                {kind: 'bibliography', filePath: '/bib/second.bib', auxPath, ownerPath: owner}
            ])
            assert.hasLog(`Empty \\bibdata in .aux ${auxPath} , skip.`)
        })

        it('should treat an unreadable AUX file as empty', async () => {
            const owner = projectPath('main.tex')
            const flsPath = projectPath('main.fls')
            sandbox.stub(lw.file, 'getFlsPath').resolves(flsPath)
            sandbox.stub(lw.file, 'read').callsFake(filePath => Promise.resolve(filePath === flsPath ? 'OUTPUT main.aux' : undefined))
            sandbox.stub(lw.file, 'exists').resolves(existingFile)

            assert.deepStrictEqual(await discover(owner), [])
        })

        it('should keep earlier events visible when a later bibliography resolution fails', async () => {
            const owner = projectPath('main.tex')
            const flsPath = projectPath('main.fls')
            const auxPath = projectPath('main.aux')
            sandbox.stub(lw.file, 'getFlsPath').resolves(flsPath)
            sandbox.stub(lw.file, 'read').callsFake(filePath => Promise.resolve(filePath === flsPath
                ? 'OUTPUT main.aux'
                : '\\bibdata{first,second}'))
            sandbox.stub(lw.file, 'exists').resolves(existingFile)
            const getBibPath = sandbox.stub(lw.file, 'getBibPath')
            getBibPath.onFirstCall().resolves(['/bib/first.bib'])
            getBibPath.onSecondCall().rejects(new Error('resolution failed'))
            const generator = discoverFls(owner)

            assert.deepStrictEqual(await generator.next(), {
                done: false,
                value: {kind: 'bibliography', filePath: '/bib/first.bib', auxPath, ownerPath: owner}
            })
            await assert.rejects(generator.next(), /resolution failed/)
            assert.notHasLog(`Parsed .fls ${flsPath} .`)
        })
    })

    describe('getFlsChildren', () => {
        it('should return no children without an FLS file', async () => {
            assert.deepStrictEqual(await getFlsChildren(get.path(fixture, 'another.tex')), [])
        })

        it('should return every parsed input without workflow filtering', async () => {
            const owner = projectPath('main.tex')
            sandbox.stub(lw.file, 'getFlsPath').resolves(projectPath('main.fls'))
            sandbox.stub(lw.file, 'read').resolves('INPUT main.tex\nINPUT missing.aux\nINPUT ignored.out\nOUTPUT missing.aux')

            assert.deepStrictEqual(await getFlsChildren(owner), [
                projectPath('main.tex'), projectPath('missing.aux'), projectPath('ignored.out')
            ])
        })

        it('should treat an unreadable FLS file as empty', async () => {
            sandbox.stub(lw.file, 'getFlsPath').resolves(projectPath('main.fls'))
            sandbox.stub(lw.file, 'read').resolves(undefined)
            assert.deepStrictEqual(await getFlsChildren(projectPath('main.tex')), [])
        })
    })
})
