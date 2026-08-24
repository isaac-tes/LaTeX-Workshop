import * as os from 'os'
import * as path from 'path'
import * as vscode from 'vscode'

/**
 * Returns the short fixture identifier used by the unit-test fixture layout.
 * Use this when a test needs to derive a fixture name from its source path.
 */
export function getFixture(filename: string): string {
    return filename.split(path.sep).slice(-2, -1)[0] + path.sep + path.basename(filename).split('.')[0]
}

/**
 * Finds a named workspace folder from the VS Code test workspace.
 * Use this instead of reaching into `workspaceFolders` directly.
 */
export function getWorkspace(name: string): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.find(folder => folder.name === name)
}

/**
 * Resolves a path relative to the `units` test workspace and normalizes its
 * Windows drive-letter casing. Use this for paths shared with extension code.
 */
export function getPath(...paths: string[]): string {
    const result = path.resolve(
        getWorkspace('units')?.uri.fsPath ?? '',
        ...paths
    )
    if (os.platform() === 'win32') {
        return result.charAt(0).toLowerCase() + result.slice(1)
    } else {
        return result
    }
}
