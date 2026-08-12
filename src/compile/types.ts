import type { Step } from './step'

export type Tool = {
    name: string,
    command: string,
    args?: string[],
    env?: Record<string, string | undefined>,
    cwd?: string
}

export type RecipeConfig = {
    name: string,
    tools: (string | Tool)[]
}

export type StepResult = {
    status: 'succeeded' | 'failed' | 'terminated',
    code: number | null,
    signal: NodeJS.Signals | null,
    stdout: string,
    stderr: string,
    error?: Error,
    skipped: boolean,
    // l3backend expected: pdftex | luatex | xetex | dvips | dvipdfmx | dvisvgm
    backend: string
}

export type PlanResult = {
    status: StepResult['status'],
    step: Step,
    result: StepResult,
    skipped: boolean,
    backend: string
}
