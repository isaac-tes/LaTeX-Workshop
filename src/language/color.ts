
import * as vscode from 'vscode'

function colorParserCMYK(document: vscode.TextDocument, colors: vscode.ColorInformation[], regex: RegExp) {
    const text = document.getText()

    let match: RegExpExecArray | null
    while ((match = regex.exec(text))) {
        const start = document.positionAt(match.index + 12)
        const end = document.positionAt(match.index + match[0].length)
        const hex = match[3].split(',')
        const c = parseFloat(hex[0])
        const m = parseFloat(hex[1])
        const y = parseFloat(hex[2])
        const k = parseFloat(hex[3])
        const r = (1 - c) * (1 - k)
        const g = (1 - m) * (1 - k)
        const b = (1 - y) * (1 - k)

        colors.push(
            new vscode.ColorInformation(
                new vscode.Range(start, end),
                new vscode.Color(r, g, b, 1)
            )
        )
    }
}

function colorParserHTML(document: vscode.TextDocument, colors: vscode.ColorInformation[], regex: RegExp) {
    const text = document.getText()

    let match: RegExpExecArray | null
    while ((match = regex.exec(text))) {
        const start = document.positionAt(match.index + 12)
        const end = document.positionAt(match.index + match[0].length)
        const hex = match[3]
        const r = parseInt(hex.slice(0, 2), 16) / 255
        const g = parseInt(hex.slice(2, 4), 16) / 255
        const b = parseInt(hex.slice(4, 6), 16) / 255

        colors.push(
            new vscode.ColorInformation(
                new vscode.Range(start, end),
                new vscode.Color(r, g, b, 1)
            )
        )
    }
}

function colorParserRGB(document: vscode.TextDocument, colors: vscode.ColorInformation[], regex: RegExp) {
    const text = document.getText()

    let match: RegExpExecArray | null
    while ((match = regex.exec(text))) {
        const start = document.positionAt(match.index + 12)
        const end = document.positionAt(match.index + match[0].length)
        const hex = match[3].split(',')
        const r = parseFloat(hex[0])
        const g = parseFloat(hex[1])
        const b = parseFloat(hex[2])

        colors.push(
            new vscode.ColorInformation(
                new vscode.Range(start, end),
                new vscode.Color(r, g, b, 1)
            )
        )
    }
}

function colorParserGray(document: vscode.TextDocument, colors: vscode.ColorInformation[], regex: RegExp) {
    const text = document.getText()

    let match: RegExpExecArray | null
    while ((match = regex.exec(text))) {
        const start = document.positionAt(match.index + 12)
        const end = document.positionAt(match.index + match[0].length)
        const gray = parseFloat(match[3])

        colors.push(
            new vscode.ColorInformation(
                new vscode.Range(start, end),
                new vscode.Color(gray, gray, gray, 1)
            )
        )
    }
}

export class DocColorProvider implements vscode.DocumentColorProvider {

    provideDocumentColors(document: vscode.TextDocument): vscode.ProviderResult<vscode.ColorInformation[]> {
        const colors: vscode.ColorInformation[] = []

        // type match?
        // text as parameter?
        const handlers = [
            { 'func': colorParserHTML, 'regex': /(\\definecolor\{(HTML)\}\{)([^}]+)/g },
            { 'func': colorParserGray, 'regex': /(\\definecolor\{(gray)\}\{)([^}]+)/g },
            { 'func': colorParserRGB, 'regex': /(\\definecolor\{(rgb)\}\{)([^}]+)/g },
            { 'func': colorParserCMYK, 'regex': /(\\definecolor\{(cmyk)\}\{)([^}]+)/g },
        ]

        handlers.forEach((x) => x['func'](document, colors, x['regex']))

        return colors
    }

    provideColorPresentations(color: vscode.Color, context: { document: vscode.TextDocument, range: vscode.Range }): vscode.ProviderResult<vscode.ColorPresentation[]> {
        const precision = 2
        const line = context.document.lineAt(context.range.start.line).text
        let label = ''
        let type = 'UNKNOWN'

        const regex = /\\definecolor\{([a-zA-Z]+)\}/g
        const match = regex.exec(line)
        if (match) {
            type = match[1]
        }
        else {
            return
        }

        switch (type) {
            case 'HTML': {
                const toHex = (value: number) => Math.round(value * 255).toString(16).padStart(2, '0')
                label = `${toHex(color.red)}${toHex(color.green)}${toHex(color.blue)}`
                break
            }
            case 'rgb': {
                label = `${color.red.toFixed(precision)},${color.green.toFixed(precision)},${color.blue.toFixed(precision)}`
                break
            }
            case 'cmyk': {
                const r = color.red
                const g = color.green
                const b = color.blue
                const k = 1 - Math.max(r, g, b)
                const c = (1 - r - k) / (1 - k)
                const m = (1 - g - k) * (1 - k)
                const y = (1 - b - k) * (1 - k)
                label = `${c.toFixed(precision)},${m.toFixed(precision)},${y.toFixed(precision)},${k.toFixed(precision)}`
                break
            }
            case 'gray': {
                const gray = (color.red + color.green + color.blue) / 3
                label = `${gray.toFixed(precision)}`
                break
            }
            default:
                return
        }

        label = `{${type}}{${label}`
        return [new vscode.ColorPresentation(label)]
    }
}
