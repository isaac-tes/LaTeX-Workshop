import * as vscode from 'vscode'
import { lw } from '../lw'
import { getWorkingFolder } from '../utils/utils'
import {
    BIB_MAGIC_PROGRAM_NAME,
    MAGIC_PROGRAM_ARGS_SUFFIX,
    TEX_MAGIC_PROGRAM_NAME
} from './constants'
import type { RecipeConfig, Tool } from './types'

const logger = lw.log('Build', 'Recipe')

export class Recipe {
    readonly name: string
    readonly tools: (string | Tool)[]
    readonly rootFile?: string
    readonly cwd: string
    readonly isExternal: boolean

    private static lastRecipeName: string | undefined
    private static lastLanguageId = ''

    private constructor(
        name: string,
        tools: (string | Tool)[],
        rootFile: string | undefined,
        cwd: string,
        isExternal: boolean
    ) {
        this.name = name
        this.tools = tools.slice()
        this.rootFile = rootFile
        this.cwd = cwd
        this.isExternal = isExternal
    }

    static initialize() {
        Recipe.lastRecipeName = undefined
        Recipe.lastLanguageId = ''
    }

    /**
     * Creates an internal Recipe from magic comments or configured recipes.
     * With magic enabled and no explicit name, TeX magic builds take priority
     * and LW magic selects a config; only resolved config recipes become last-used.
     */
    static async create(
        rootFile: string,
        languageId: string,
        recipeName?: string
    ): Promise<Recipe | undefined> {
        logger.log(`Build root file ${rootFile}`)
        const scope = lw.file.toUri(rootFile)
        const configuration = vscode.workspace.getConfiguration('latex-workshop', scope)
        const magic = await Recipe.findMagicComments(rootFile)

        if (configuration.get('latex.build.enableMagicComments') && recipeName === undefined && magic.tex) {
            return new Recipe(
                'Build',
                Recipe.createMagicTools(magic.tex, magic.bib, configuration),
                rootFile,
                getWorkingFolder(rootFile),
                false
            )
        }
        if (configuration.get('latex.build.enableMagicComments') && recipeName === undefined && magic.recipe) {
            recipeName = magic.recipe
        }

        const config = Recipe.findConfig(configuration, languageId, recipeName)
        if (config === undefined) {
            return
        }

        logger.log(`Preparing to run recipe: ${config.name}.`)
        Recipe.lastRecipeName = config.name
        Recipe.lastLanguageId = languageId
        return new Recipe(config.name, config.tools, rootFile, getWorkingFolder(rootFile), false)
    }

    static createExternal(
        scope: vscode.ConfigurationScope,
        fallbackCwd: string,
        rootFile?: string
    ): Recipe | undefined {
        const configuration = vscode.workspace.getConfiguration('latex-workshop', scope)
        const command = configuration.get('latex.external.build.command', '')
        if (command === '') {
            return
        }
        const args = configuration.get('latex.external.build.args', []) as string[]
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? fallbackCwd
        return new Recipe(
            'External',
            [{name: command, command, args}],
            rootFile,
            cwd,
            true
        )
    }

    private static async findMagicComments(rootFile: string): Promise<{
        tex?: Tool,
        bib?: Tool,
        recipe?: string
    }> {
        const regexTex = /^(?:%\s*!\s*T[Ee]X\s(?:TS-)?program\s*=\s*([^\s]*)$)/m
        const regexBib = /^(?:%\s*!\s*BIB\s(?:TS-)?program\s*=\s*([^\s]*)$)/m
        const regexTexOptions = /^(?:%\s*!\s*T[Ee]X\s(?:TS-)?options\s*=\s*(.*)$)/m
        const regexBibOptions = /^(?:%\s*!\s*BIB\s(?:TS-)?options\s*=\s*(.*)$)/m
        const regexRecipe = /^(?:%\s*!\s*LW\srecipe\s*=\s*(.*)$)/m
        let content = ''
        for (const line of (await lw.file.read(rootFile))?.split('\n') ?? []) {
            if (!line.startsWith('%') && line.trim().length > 0) {
                break
            }
            content += line + '\n'
        }

        const texMatch = content.match(regexTex)
        const texOptions = content.match(regexTexOptions)
        const tex = texMatch
            ? Recipe.createMagicTool(TEX_MAGIC_PROGRAM_NAME, texMatch[1], texOptions?.[1])
            : undefined
        if (tex) {
            logger.log(`Found TeX program by magic comment: ${tex.command}.`)
            if (tex.args) {
                logger.log(`Found TeX options by magic comment: ${tex.args}.`)
            }
        }

        const bibMatch = content.match(regexBib)
        const bibOptions = content.match(regexBibOptions)
        const bib = bibMatch
            ? Recipe.createMagicTool(BIB_MAGIC_PROGRAM_NAME, bibMatch[1], bibOptions?.[1])
            : undefined
        if (bib) {
            logger.log(`Found BIB program by magic comment: ${bib.command}.`)
            if (bib.args) {
                logger.log(`Found BIB options by magic comment: ${bib.args}.`)
            }
        }

        const recipeMatch = content.match(regexRecipe)
        if (recipeMatch?.[1]) {
            logger.log(`Found LW recipe '${recipeMatch[1]}' by magic comment: ${recipeMatch}.`)
        }
        return {tex, bib, recipe: recipeMatch?.[1]}
    }

    private static createMagicTool(name: string, command: string, options?: string): Tool {
        return options === undefined
            ? {name, command}
            : {name, command, args: [options]}
    }

    private static createMagicTools(
        tex: Tool,
        bib: Tool | undefined,
        configuration: vscode.WorkspaceConfiguration
    ): Tool[] {
        const texTool = tex.args
            ? tex
            : {
                ...tex,
                name: TEX_MAGIC_PROGRAM_NAME + MAGIC_PROGRAM_ARGS_SUFFIX,
                args: configuration.get('latex.magic.args') as string[]
            }
        if (bib === undefined) {
            return [texTool]
        }
        const bibTool = bib.args
            ? bib
            : {
                ...bib,
                name: BIB_MAGIC_PROGRAM_NAME + MAGIC_PROGRAM_ARGS_SUFFIX,
                args: configuration.get('latex.magic.bib.args') as string[]
            }
        return [texTool, bibTool, texTool, texTool]
    }

    /**
     * Resolves a configured recipe by explicit/default name, last-used name,
     * then the first language-compatible fallback. Language changes clear
     * last-used state, while empty or unmatched candidate sets report an error.
     */
    private static findConfig(
        configuration: vscode.WorkspaceConfiguration,
        languageId: string,
        recipeName?: string
    ): RecipeConfig | undefined {
        const recipes = configuration.get('latex.recipes', []) as RecipeConfig[]
        const defaultRecipeName = configuration.get<string>('latex.recipe.default', 'first')
        if (recipes.length === 0) {
            logger.log('No recipes defined.')
            void logger.showErrorMessage('[Builder] No recipes defined.')
            return
        }

        if (Recipe.lastLanguageId !== languageId) {
            Recipe.lastRecipeName = undefined
        }
        if (recipeName === undefined && !['first', 'lastUsed'].includes(defaultRecipeName)) {
            recipeName = defaultRecipeName
        }

        let recipe: RecipeConfig | undefined
        if (recipeName) {
            recipe = recipes.find(candidate => candidate.name === recipeName)
            if (recipe === undefined) {
                logger.log(`Failed to resolve build recipe: ${recipeName}.`)
                void logger.showErrorMessage(`[Builder] Failed to resolve build recipe: ${recipeName}.`)
            }
        }
        if (recipe === undefined && defaultRecipeName === 'lastUsed') {
            recipe = recipes.find(candidate => candidate.name === Recipe.lastRecipeName)
        }
        if (recipe !== undefined) {
            return recipe
        }

        const candidates = Recipe.filterByLanguage(recipes, languageId)
        if (candidates.length === 0) {
            logger.log(`Cannot find any recipe for langID \`${languageId}\`.`)
            void logger.showErrorMessage(`[Builder] Cannot find any recipe for langID \`${languageId}\`: ${recipeName}.`)
        }
        return candidates[0]
    }

    private static filterByLanguage(recipes: RecipeConfig[], languageId: string): RecipeConfig[] {
        if (languageId === 'rsweave') {
            return recipes.filter(candidate => candidate.name.toLowerCase().match('rnw|rsweave'))
        }
        if (languageId === 'jlweave') {
            return recipes.filter(candidate => candidate.name.toLowerCase().match('jnw|jlweave|weave.jl'))
        }
        if (languageId === 'pweave') {
            return recipes.filter(candidate => candidate.name.toLowerCase().match('pnw|pweave'))
        }
        return recipes
    }
}
