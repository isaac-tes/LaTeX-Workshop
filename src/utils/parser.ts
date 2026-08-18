import * as fs from 'fs'
import * as path from 'path'
import type * as Ast from '@unified-latex/unified-latex-types'

function macroToStr(macro: Ast.Macro): string {
    if (macro.content === 'texorpdfstring') {
        return (macro.args?.[1].content[0] as Ast.String | undefined)?.content || ''
    }
    return `\\${macro.content}` + (macro.args?.map(arg => `${arg.openMark}${argContentToStr(arg.content)}${arg.closeMark}`).join('') ?? '')
}

function envToStr(env: Ast.Environment | Ast.VerbatimEnvironment): string {
    return `\\environment{${env.env}}`
}

export function argContentToStr(argContent: Ast.Node[], preserveCurlyBrace: boolean = false): string {
    return argContent.map(node => {
        // Verb
        switch (node.type) {
            case 'string':
                return node.content
            case 'whitespace':
            case 'parbreak':
            case 'comment':
                return ' '
            case 'macro':
                return macroToStr(node)
            case 'environment':
            case 'verbatim':
            case 'mathenv':
                return envToStr(node)
            case 'inlinemath':
                return `$${argContentToStr(node.content)}$`
            case 'displaymath':
                return `\\[${argContentToStr(node.content)}\\]`
            case 'group':
                return preserveCurlyBrace ? `{${argContentToStr(node.content)}}` : argContentToStr(node.content)
            case 'verb':
                return node.content
            default:
                return ''
        }
    }).join('')
}

type UnicodeMathSymbol = { command: string, detail: string }

let unicodeMathSymbols: Map<string, string> | undefined

function getUnicodeMathSymbols(): Map<string, string> {
    if (unicodeMathSymbols === undefined) {
        const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../data/unimathsymbols.json'), { encoding: 'utf8' })) as Record<string, UnicodeMathSymbol>
        unicodeMathSymbols = new Map(Object.values(data)
            .filter(symbol => !symbol.detail.startsWith('\\'))
            .map(symbol => [symbol.command, symbol.detail.split(' (')[0]]))
    }
    return unicodeMathSymbols
}

function getUnicodeMathSymbol(command: string): string | undefined {
    const symbols = getUnicodeMathSymbols()
    return symbols.get(command) ?? symbols.get(`up${command}`)
}

const formattingMacros = ['textbf', 'textit', 'text', 'emph', 'textrm', 'textsf', 'texttt', 'textsl', 'textsc', 'textup', 'textnormal']

function macroContentToLabel(macro: Ast.Macro, inMath: boolean): string {
    if (macro.content === 'texorpdfstring') {
        return labelContentToStr(macro.args?.[1]?.content ?? [], inMath)
    }
    if (formattingMacros.includes(macro.content)) {
        return labelContentToStr(macro.args?.[0]?.content ?? [], inMath)
    }
    if (macro.content.startsWith('cite')) {
        return ''
    }
    if (inMath && ['left', 'right', 'middle'].includes(macro.content)) {
        return ''
    }
    if (inMath) {
        const symbol = getUnicodeMathSymbol(macro.content)
        if (symbol !== undefined) {
            return symbol
        }
    }
    return `\\${macro.content}` + (macro.args?.map(arg => `${arg.openMark}${labelContentToStr(arg.content, inMath)}${arg.closeMark}`).join('') ?? '')
}

function labelContentToStr(content: Ast.Node[], inMath: boolean = false): string {
    return content.map(node => {
        switch (node.type) {
            case 'string':
                return node.content
            case 'whitespace':
            case 'parbreak':
            case 'comment':
                return ' '
            case 'macro':
                return macroContentToLabel(node, inMath)
            case 'inlinemath':
            case 'displaymath':
                return labelContentToStr(node.content, true)
            case 'group':
                return labelContentToStr(node.content, inMath)
            case 'verb':
                return node.content
            default:
                return argContentToStr([node])
        }
    }).join('')
}

export function sanitizeLabel(content: Ast.Node[]): string {
    return labelContentToStr(content).replace(/\s+/g, ' ').trim()
}
