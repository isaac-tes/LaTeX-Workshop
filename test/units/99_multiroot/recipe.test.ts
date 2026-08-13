import path from 'path'
import * as sinon from 'sinon'
import { lw } from '../../../src/lw'
import { Recipe } from '../../../src/compile/recipe'
import { assert, get, set } from '../utils'

describe(path.basename(__filename).split('.')[0] + ': multiroot', () => {
    const projectA = get.workspace('project_A')!
    const projectB = get.workspace('project_B')!
    const rootA = path.resolve(projectA.uri.fsPath, 'build/main.tex')
    const rootB = path.resolve(projectB.uri.fsPath, 'switch/main.tex')

    beforeEach(() => {
        Recipe.initialize()
    })

    after(() => {
        sinon.restore()
    })

    it('selects recipes from the root workspace configuration', async () => {
        await set.codeConfig('latex.recipes', [{name: 'global', tools: ['global-tool']}])
        await set.codeConfig('latex.recipe.default', 'global')
        await set.codeConfig('latex.recipes', [{name: 'project-a', tools: ['project-a-tool']}], projectA)
        await set.codeConfig('latex.recipe.default', 'project-a', projectA)

        const recipe = await Recipe.create(rootA, 'latex')

        assert.strictEqual(recipe?.name, 'project-a')
        assert.deepStrictEqual(recipe?.tools, ['project-a-tool'])
    })

    it('keeps resource-scoped recipes separate across workspaces', async () => {
        await set.codeConfig('latex.recipes', [{name: 'project-a', tools: ['project-a-tool']}], projectA)
        await set.codeConfig('latex.recipe.default', 'project-a', projectA)
        await set.codeConfig('latex.recipes', [{name: 'project-b', tools: ['project-b-tool']}], projectB)
        await set.codeConfig('latex.recipe.default', 'project-b', projectB)

        const recipeA = await Recipe.create(rootA, 'latex')
        const recipeB = await Recipe.create(rootB, 'latex')

        assert.strictEqual(recipeA?.name, 'project-a')
        assert.strictEqual(recipeB?.name, 'project-b')
    })

    it('uses magic-comment enablement from the root workspace', async () => {
        await set.codeConfig('latex.recipes', [{name: 'project-a', tools: ['project-a-tool']}], projectA)
        await set.codeConfig('latex.recipe.default', 'project-a', projectA)
        await set.codeConfig('latex.build.enableMagicComments', true)
        await set.codeConfig('latex.build.enableMagicComments', false, projectA)

        const recipe = await Recipe.create(path.resolve(projectA.uri.fsPath, 'build/magic.tex'), 'latex')

        assert.strictEqual(recipe?.name, 'project-a')
    })

    it('uses external configuration from the provided workspace scope', async () => {
        await set.codeConfig('latex.external.build.command', '')
        await set.codeConfig('latex.external.build.command', 'project-a-make', projectA)
        await set.codeConfig('latex.external.build.args', ['all'], projectA)

        const recipe = Recipe.createExternal(lw.file.toUri(rootA), '/fallback', rootA)

        assert.deepStrictEqual(recipe?.tools, [{
            name: 'project-a-make',
            command: 'project-a-make',
            args: ['all']
        }])
    })
})
