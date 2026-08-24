import * as vscode from 'vscode'
import * as sinon from 'sinon'
import { getTestConfig, hasTestConfig } from './configuration'
import { FakeTextDocumentOptions, FakeTextEditorOptions, TextDocument, TextEditor } from './vscode-fakes'

/**
 * Recursively stubs callable members of an object while preserving members
 * explicitly listed in `ignore`. Use to isolate a unit from its collaborators.
 */
export function mockObject(obj: any, ...ignore: string[]): void {
    const items = Object.getPrototypeOf(obj) === Object.prototype
        ? Object.getOwnPropertyNames(obj)
        : Object.getOwnPropertyNames(Object.getPrototypeOf(obj))
    items.forEach(item => {
        // Don't stub the unit to be tested or the logging/external functions.
        if (ignore.includes(item) || ['file', 'log', 'external', 'constant'].includes(item)) {
            return
        }
        if (typeof obj[item] === 'object') {
            mockObject(obj[item])
        } else if (typeof obj[item] === 'function' && obj[item].callCount === undefined) {
            sinon.stub(obj, item)
        }
    })
}

/**
 * Stubs VS Code configuration reads so values recorded by `set.config` are
 * returned while all other configuration reads retain their original behavior.
 * Use this when mocking an extension object before a unit test.
 */
export function mockConfig(): void {
    const original = vscode.workspace.getConfiguration
    sinon.stub(vscode.workspace, 'getConfiguration').callsFake((section?: string, scope?: vscode.ConfigurationScope | null) => {
        function getConfig<T>(configName: string): T | undefined
        function getConfig<T>(configName: string, defaultValue: T): T
        function getConfig<T>(configName: string, defaultValue?: T): T | undefined {
            if (hasTestConfig(configName)) {
                return getTestConfig<T>(configName)
            }
            return originalConfig.get(configName, defaultValue)
        }
        const originalConfig = original(section, scope)
        const configItem: vscode.WorkspaceConfiguration = {
            ...originalConfig,
            get: getConfig
        }
        return configItem
    })
}

/**
 * Stubs an object's collaborators and configuration in one call.
 * Use at the beginning of a test suite that exercises one extension unit in isolation.
 */
export function initMock(obj: any, ...ignore: string[]): void {
    mockObject(obj, ...ignore)
    mockConfig()
}

/**
 * Replaces `workspace.textDocuments` with one fake document.
 * Use when code under test searches the currently opened documents.
 */
export function mockTextDocument(filePath: string, content: string, params: FakeTextDocumentOptions = {}): sinon.SinonStub {
    return sinon.stub(vscode.workspace, 'textDocuments').value([ new TextDocument(filePath, content, params) ])
}

/**
 * Replaces `window.activeTextEditor` with one fake editor.
 * Use when code under test depends on the active editor or its selection.
 */
export function mockActiveTextEditor(filePath: string, content: string, params: FakeTextEditorOptions = {}): sinon.SinonStub {
    return sinon.stub(vscode.window, 'activeTextEditor').value(new TextEditor(filePath, content, params))
}

/**
 * Legacy mock namespace retained so existing unit tests can continue using
 * `mock.init`, `mock.object`, and the other established helpers.
 */
export const mock = {
    init: initMock,
    object: mockObject,
    config: mockConfig,
    textDocument: mockTextDocument,
    activeTextEditor: mockActiveTextEditor
}
