import * as path from 'path'
import * as sinon from 'sinon'
import * as vscode from 'vscode'
import { autoBuild, manualBuild } from '../../../src/compile/build'
import { Plan } from '../../../src/compile/plan'
import { Recipe } from '../../../src/compile/recipe'
import { Events } from '../../../src/core/event'
import { lw } from '../../../src/lw'
import { assert, get, log, mock, set } from '../utils'

describe(path.basename(__filename).split('.')[0] + ': multiroot', () => {
    const projectA = get.workspace('project_A')!
    const projectB = get.workspace('project_B')!
    const root = path.resolve(projectA.uri.fsPath, 'build/main.tex')
    const tools = [
        {name: 'latexmk', command: 'bash', args: ['-c', 'echo project-latexmk']},
        {name: 'fake', command: 'bash', args: ['-c', 'echo global-fake']}
    ]
    const recipes = [
        {name: 'latexmk', tools: ['latexmk']},
        {name: 'fake', tools: ['fake']}
    ]
    let activeEditor: sinon.SinonStub
    let findRoot: sinon.SinonStub

    before(() => {
        sinon.stub(vscode.workspace, 'saveAll').resolves(true)
        sinon.stub(lw.cache, 'getIncludedTeX').returns(new Set())
        findRoot = sinon.stub(lw.root, 'find').callsFake(() => {
            lw.root.file.path = root
            lw.root.file.langId = 'latex'
            return Promise.resolve(undefined)
        })
    })

    beforeEach(async () => {
        Recipe.initialize()
        Plan.initialize()
        activeEditor = mock.activeTextEditor(root, '', {languageId: 'latex'})
        lw.root.file.path = root
        lw.root.file.langId = 'latex'
        lw.root.subfiles.path = undefined
        lw.root.subfiles.langId = undefined
        findRoot.resetHistory()
        await set.codeConfig('docker.enabled', false)
        await set.codeConfig('latex.external.build.command', '', projectA)
        await set.codeConfig('latex.autoBuild.interval', 0, projectA)
    })

    afterEach(() => {
        activeEditor.restore()
        lw.root.subfiles.path = undefined
        lw.root.subfiles.langId = undefined
    })

    after(() => {
        sinon.restore()
    })

    async function configureBuild() {
        await set.codeConfig('latex.tools', tools)
        await set.codeConfig('latex.recipes', recipes)
    }

    it('uses the root folder default recipe through the production facade', async () => {
        await configureBuild()
        await set.codeConfig('latex.recipe.default', 'fake')
        await set.codeConfig('latex.recipe.default', 'latexmk', projectA)

        log.start()
        await manualBuild()
        log.stop()

        assert.hasCompilerLog('project-latexmk')
        assert.ok(findRoot.calledOnce)
    })

    it('falls back within the root folder recipes if last-used is unavailable', async () => {
        await set.codeConfig('latex.tools', tools)
        await set.codeConfig('latex.recipes', [])
        await set.codeConfig('latex.recipe.default', 'fake')
        await set.codeConfig('latex.recipes', recipes, projectA)
        await set.codeConfig('latex.recipe.default', 'lastUsed', projectA)

        await manualBuild()

        assert.hasCompilerLog('project-latexmk')
    })

    it('resolves outDir from the TeX file workspace folder', async () => {
        const rootB = path.resolve(projectB.uri.fsPath, 'switch/main.tex')
        await set.codeConfig('latex.outDir', '%DIR%')
        await set.codeConfig('latex.outDir', './out', projectA)

        assert.strictEqual(lw.file.getOutDir(root), 'out')
        assert.pathStrictEqual(lw.file.getOutDir(rootB), path.dirname(rootB))
    })

    it('ignores magic comments disabled in the root folder', async () => {
        const magicRoot = path.resolve(projectA.uri.fsPath, 'build/magic.tex')
        await configureBuild()
        await set.codeConfig('latex.build.enableMagicComments', true)
        await set.codeConfig('latex.build.enableMagicComments', false, projectA)
        findRoot.callsFake(() => {
            lw.root.file.path = magicRoot
            lw.root.file.langId = 'latex'
            return Promise.resolve(undefined)
        })

        await manualBuild()

        assert.hasCompilerLog('project-latexmk')
    })

    it('uses changed-file scope and builds the root for a saved subfile', async () => {
        const subfile = path.resolve(projectA.uri.fsPath, 'root/sub/s.tex')
        await configureBuild()
        await set.codeConfig('latex.autoBuild.run', 'onFileChange')
        await set.codeConfig('latex.autoBuild.run', 'onSave', projectA)
        await set.codeConfig('latex.rootFile.useSubFile', true)
        await set.codeConfig('latex.rootFile.useSubFile', false, projectA)
        lw.root.subfiles.path = subfile
        lw.root.subfiles.langId = 'latex'
        activeEditor.restore()
        activeEditor = mock.activeTextEditor(subfile, '', {languageId: 'latex'})
        const fire = sinon.spy(lw.event, 'fire')

        await autoBuild(subfile, 'onSave')
        const eventArgs = fire.firstCall.args
        fire.restore()

        assert.deepStrictEqual(eventArgs, [Events.AutoBuildInitiated, {type: 'onSave', file: subfile}])
        assert.hasCompilerLog('project-latexmk')
        assert.ok(findRoot.notCalled)
    })
})
