import path from 'path'
import * as sinon from 'sinon'
import * as vscode from 'vscode'
import { lw } from '../../../src/lw'
import {
    BIB_MAGIC_PROGRAM_NAME,
    MAGIC_PROGRAM_ARGS_SUFFIX,
    TEX_MAGIC_PROGRAM_NAME
} from '../../../src/compile/constants'
import { Recipe } from '../../../src/compile/recipe'
import type { RecipeConfig, Tool } from '../../../src/compile/types'
import { assert, get, mock, set } from '../utils'

const rootFile = get.path('main.tex')
const firstTool: Tool = {name: 'first-tool', command: 'pdflatex'}
const secondTool: Tool = {name: 'second-tool', command: 'xelatex'}
const firstRecipe: RecipeConfig = {name: 'first', tools: ['first-tool']}
const secondRecipe: RecipeConfig = {name: 'second', tools: ['second-tool']}

describe(path.basename(__filename).split('.')[0] + ':', () => {
    let readStub: sinon.SinonStub

    before(() => {
        mock.init(lw)
        readStub = sinon.stub(lw.file, 'read')
    })

    beforeEach(() => {
        Recipe.initialize()
        readStub.reset()
        readStub.resolves('')
        set.config('latex.recipes', [firstRecipe, secondRecipe])
        set.config('latex.tools', [firstTool, secondTool])
        set.config('latex.recipe.default', 'first')
        set.config('latex.build.enableMagicComments', false)
        set.config('latex.magic.args', ['-synctex=1', '%DOC%'])
        set.config('latex.magic.bib.args', ['%DOCFILE%'])
        set.config('latex.build.fromFolder', '')
        set.config('latex.external.build.command', '')
        set.config('latex.external.build.args', [])
    })

    after(() => {
        sinon.restore()
    })

    describe('Recipe.create configured recipes', () => {
        it('creates the first configured recipe with execution metadata', async () => {
            const recipe = await Recipe.create(rootFile, 'latex')

            assert.ok(recipe)
            assert.strictEqual(recipe.name, 'first')
            assert.deepStrictEqual(recipe.tools, ['first-tool'])
            assert.strictEqual(recipe.rootFile, rootFile)
            assert.pathStrictEqual(recipe.cwd, path.dirname(rootFile))
            assert.strictEqual(recipe.isExternal, false)
        })

        it('copies the recipe tool list', async () => {
            const tools: (string | Tool)[] = ['first-tool']
            set.config('latex.recipes', [{name: 'first', tools}])

            const recipe = await Recipe.create(rootFile, 'latex')
            tools.push('second-tool')

            assert.deepStrictEqual(recipe?.tools, ['first-tool'])
        })

        it('uses an explicitly named recipe', async () => {
            const recipe = await Recipe.create(rootFile, 'latex', 'second')

            assert.strictEqual(recipe?.name, 'second')
        })

        it('uses a configured default recipe', async () => {
            set.config('latex.recipe.default', 'second')

            const recipe = await Recipe.create(rootFile, 'latex')

            assert.strictEqual(recipe?.name, 'second')
        })

        it('returns undefined when no recipes exist', async () => {
            set.config('latex.recipes', [])

            const recipe = await Recipe.create(rootFile, 'latex')

            assert.strictEqual(recipe, undefined)
            assert.hasLog('No recipes defined.')
        })

        it('logs an unknown named recipe and falls back to the first recipe', async () => {
            const recipe = await Recipe.create(rootFile, 'latex', 'missing')

            assert.strictEqual(recipe?.name, 'first')
            assert.hasLog('Failed to resolve build recipe: missing.')
        })

        it('reuses the last configured recipe for the same language', async () => {
            await Recipe.create(rootFile, 'latex', 'second')
            set.config('latex.recipe.default', 'lastUsed')

            const recipe = await Recipe.create(rootFile, 'latex')

            assert.strictEqual(recipe?.name, 'second')
        })

        it('resolves last-used tools from the latest configuration', async () => {
            await Recipe.create(rootFile, 'latex', 'second')
            set.config('latex.recipe.default', 'lastUsed')
            set.config('latex.recipes', [firstRecipe, {name: 'second', tools: ['updated-tool']}])

            const recipe = await Recipe.create(rootFile, 'latex')

            assert.deepStrictEqual(recipe?.tools, ['updated-tool'])
        })

        it('does not reuse the last recipe for another language', async () => {
            await Recipe.create(rootFile, 'latex', 'second')
            set.config('latex.recipe.default', 'lastUsed')

            const recipe = await Recipe.create(rootFile, 'doctex')

            assert.strictEqual(recipe?.name, 'first')
        })

        it('resets last-used state when initialized', async () => {
            await Recipe.create(rootFile, 'latex', 'second')
            set.config('latex.recipe.default', 'lastUsed')
            Recipe.initialize()

            const recipe = await Recipe.create(rootFile, 'latex')

            assert.strictEqual(recipe?.name, 'first')
        })

        it('filters fallback recipes for rsweave', async () => {
            set.config('latex.recipes', [
                firstRecipe,
                {name: 'Rnw to PDF', tools: ['second-tool']}
            ])

            const recipe = await Recipe.create(rootFile, 'rsweave')

            assert.strictEqual(recipe?.name, 'Rnw to PDF')
        })

        it('filters fallback recipes for jlweave', async () => {
            set.config('latex.recipes', [
                firstRecipe,
                {name: 'Weave.jl Recipe', tools: ['second-tool']}
            ])

            const recipe = await Recipe.create(rootFile, 'jlweave')

            assert.strictEqual(recipe?.name, 'Weave.jl Recipe')
        })

        it('filters fallback recipes for pweave', async () => {
            set.config('latex.recipes', [
                firstRecipe,
                {name: 'Pnw Recipe', tools: ['second-tool']}
            ])

            const recipe = await Recipe.create(rootFile, 'pweave')

            assert.strictEqual(recipe?.name, 'Pnw Recipe')
        })

        it('returns undefined when no language-specific recipe matches', async () => {
            const recipe = await Recipe.create(rootFile, 'rsweave')

            assert.strictEqual(recipe, undefined)
            assert.hasLog('Cannot find any recipe for langID `rsweave`.')
        })
    })

    describe('Recipe.create magic recipes', () => {
        beforeEach(() => {
            set.config('latex.build.enableMagicComments', true)
        })

        it('creates a TeX magic recipe with default arguments', async () => {
            readStub.resolves('% !TeX program = xelatex\n')

            const recipe = await Recipe.create(rootFile, 'latex')

            assert.strictEqual(recipe?.name, 'Build')
            assert.deepStrictEqual(recipe?.tools, [{
                name: TEX_MAGIC_PROGRAM_NAME + MAGIC_PROGRAM_ARGS_SUFFIX,
                command: 'xelatex',
                args: ['-synctex=1', '%DOC%']
            }])
            assert.strictEqual(recipe?.isExternal, false)
        })

        it('keeps explicit TeX magic options', async () => {
            readStub.resolves('% !TEX TS-program = lualatex\n% !TEX TS-options = --shell-escape main.tex\n')

            const recipe = await Recipe.create(rootFile, 'latex')

            assert.deepStrictEqual(recipe?.tools, [{
                name: TEX_MAGIC_PROGRAM_NAME,
                command: 'lualatex',
                args: ['--shell-escape main.tex']
            }])
        })

        it('adds a BIB magic program with default arguments', async () => {
            readStub.resolves('% !TeX program = pdflatex\n% !BIB program = bibtex\n')

            const recipe = await Recipe.create(rootFile, 'latex')

            assert.deepStrictEqual(recipe?.tools, [
                {
                    name: TEX_MAGIC_PROGRAM_NAME + MAGIC_PROGRAM_ARGS_SUFFIX,
                    command: 'pdflatex',
                    args: ['-synctex=1', '%DOC%']
                },
                {
                    name: BIB_MAGIC_PROGRAM_NAME + MAGIC_PROGRAM_ARGS_SUFFIX,
                    command: 'bibtex',
                    args: ['%DOCFILE%']
                },
                {
                    name: TEX_MAGIC_PROGRAM_NAME + MAGIC_PROGRAM_ARGS_SUFFIX,
                    command: 'pdflatex',
                    args: ['-synctex=1', '%DOC%']
                },
                {
                    name: TEX_MAGIC_PROGRAM_NAME + MAGIC_PROGRAM_ARGS_SUFFIX,
                    command: 'pdflatex',
                    args: ['-synctex=1', '%DOC%']
                }
            ])
        })

        it('keeps explicit BIB magic options', async () => {
            readStub.resolves([
                '% !TeX program = pdflatex',
                '% !TeX options = -synctex=1',
                '% !BIB TS-program = biber',
                '% !BIB TS-options = --validate-datamodel'
            ].join('\n'))

            const recipe = await Recipe.create(rootFile, 'latex')

            assert.deepStrictEqual(recipe?.tools[1], {
                name: BIB_MAGIC_PROGRAM_NAME,
                command: 'biber',
                args: ['--validate-datamodel']
            })
        })

        it('selects a configured recipe from an LW magic comment', async () => {
            readStub.resolves('% !LW recipe = second\n')

            const recipe = await Recipe.create(rootFile, 'latex')

            assert.strictEqual(recipe?.name, 'second')
        })

        it('updates last-used after selecting an LW magic recipe', async () => {
            readStub.resolves('% !LW recipe = second\n')
            await Recipe.create(rootFile, 'latex')
            readStub.resolves('')
            set.config('latex.recipe.default', 'lastUsed')

            const recipe = await Recipe.create(rootFile, 'latex')

            assert.strictEqual(recipe?.name, 'second')
        })

        it('does not update last-used after creating a TeX magic recipe', async () => {
            await Recipe.create(rootFile, 'latex', 'second')
            readStub.resolves('% !TeX program = xelatex\n')
            await Recipe.create(rootFile, 'latex')
            readStub.resolves('')
            set.config('latex.recipe.default', 'lastUsed')

            const recipe = await Recipe.create(rootFile, 'latex')

            assert.strictEqual(recipe?.name, 'second')
        })

        it('lets an explicit name override magic program and recipe comments', async () => {
            readStub.resolves('% !TeX program = xelatex\n% !LW recipe = first\n')

            const recipe = await Recipe.create(rootFile, 'latex', 'second')

            assert.strictEqual(recipe?.name, 'second')
            assert.deepStrictEqual(recipe?.tools, ['second-tool'])
            assert.hasLog('Found TeX program by magic comment: xelatex.')
        })

        it('ignores magic comments after document content', async () => {
            readStub.resolves('\\documentclass{article}\n% !TeX program = xelatex\n')

            const recipe = await Recipe.create(rootFile, 'latex')

            assert.strictEqual(recipe?.name, 'first')
        })

        it('allows blank lines in the magic comment header', async () => {
            readStub.resolves('\n% !TeX program = xelatex\n')

            const recipe = await Recipe.create(rootFile, 'latex')

            assert.strictEqual(recipe?.name, 'Build')
        })

        it('falls back to configured recipes when the root file is unreadable', async () => {
            readStub.resolves(undefined)

            const recipe = await Recipe.create(rootFile, 'latex')

            assert.strictEqual(recipe?.name, 'first')
        })
    })

    describe('Recipe.createExternal', () => {
        const scope = vscode.Uri.file(rootFile)

        it('returns undefined without an external command', () => {
            assert.strictEqual(Recipe.createExternal(scope, '/fallback', rootFile), undefined)
        })

        it('creates an external recipe with optional root metadata', () => {
            set.config('latex.external.build.command', 'make')
            set.config('latex.external.build.args', ['%DOCFILE_EXT%'])

            const recipe = Recipe.createExternal(scope, '/fallback', rootFile)

            assert.ok(recipe)
            assert.strictEqual(recipe.name, 'External')
            assert.deepStrictEqual(recipe.tools, [{
                name: 'make',
                command: 'make',
                args: ['%DOCFILE_EXT%']
            }])
            assert.strictEqual(recipe.rootFile, rootFile)
            assert.strictEqual(recipe.isExternal, true)
        })

        it('creates an external recipe without root metadata', () => {
            set.config('latex.external.build.command', 'make')

            const recipe = Recipe.createExternal(scope, '/fallback')

            assert.strictEqual(recipe?.rootFile, undefined)
        })

        it('uses the first workspace folder as the external cwd', () => {
            set.config('latex.external.build.command', 'make')

            const recipe = Recipe.createExternal(scope, '/fallback')

            assert.pathStrictEqual(recipe?.cwd, vscode.workspace.workspaceFolders?.[0].uri.fsPath)
        })

        it('uses the fallback cwd without a workspace folder', () => {
            set.config('latex.external.build.command', 'make')
            const workspaceFolders = sinon.stub(vscode.workspace, 'workspaceFolders').value(undefined)

            const recipe = Recipe.createExternal(scope, '/fallback')
            workspaceFolders.restore()

            assert.pathStrictEqual(recipe?.cwd, '/fallback')
        })

        it('does not overwrite normal last-used state', async () => {
            await Recipe.create(rootFile, 'latex', 'second')
            set.config('latex.external.build.command', 'make')
            Recipe.createExternal(scope, '/fallback', rootFile)
            set.config('latex.recipe.default', 'lastUsed')

            const recipe = await Recipe.create(rootFile, 'latex')

            assert.strictEqual(recipe?.name, 'second')
        })
    })

    describe('Recipe configuration scope', () => {
        const projectA = get.workspace('project_A')!
        const scopedRoot = path.resolve(projectA.uri.fsPath, 'build/main.tex')

        function useScopedConfiguration(values: Record<string, unknown>) {
            const getConfiguration = vscode.workspace.getConfiguration as sinon.SinonStub
            const configuration: vscode.WorkspaceConfiguration = {
                get<T>(section: string, defaultValue?: T): T | undefined {
                    return (section in values ? values[section] : defaultValue) as T | undefined
                },
                has(section: string): boolean {
                    return section in values
                },
                inspect: () => undefined,
                update: () => Promise.resolve()
            }
            getConfiguration.withArgs(
                'latex-workshop',
                sinon.match((scope: vscode.Uri) => scope?.fsPath === scopedRoot)
            ).returns(configuration)
        }

        it('uses recipes and defaults from the root workspace folder', async () => {
            useScopedConfiguration({
                'latex.recipes': [{name: 'scoped', tools: ['scoped-tool']}],
                'latex.recipe.default': 'scoped',
                'latex.build.enableMagicComments': false,
                'latex.build.fromFolder': ''
            })

            const recipe = await Recipe.create(scopedRoot, 'latex')

            assert.strictEqual(recipe?.name, 'scoped')
            assert.deepStrictEqual(recipe?.tools, ['scoped-tool'])
        })

        it('uses magic settings from the root workspace folder', async () => {
            useScopedConfiguration({
                'latex.recipes': [{name: 'scoped', tools: ['scoped-tool']}],
                'latex.recipe.default': 'scoped',
                'latex.build.enableMagicComments': false,
                'latex.build.fromFolder': ''
            })
            readStub.resolves('% !TeX program = xelatex\n')

            const recipe = await Recipe.create(scopedRoot, 'latex')

            assert.notStrictEqual(recipe?.name, 'Build')
        })

        it('uses external settings from the provided scope', () => {
            useScopedConfiguration({
                'latex.external.build.command': 'scoped-make',
                'latex.external.build.args': []
            })

            const recipe = Recipe.createExternal(vscode.Uri.file(scopedRoot), '/fallback', scopedRoot)

            assert.deepStrictEqual(recipe?.tools, [{name: 'scoped-make', command: 'scoped-make', args: []}])
        })
    })
})
