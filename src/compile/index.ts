import {
    autoBuild,
    initializeBuild,
    isFileExcludedFromBuildOnSave,
    manualBuild,
    preventAutoBuild,
    terminate
} from './build'
import { executor } from './executor'
import { Plan } from './plan'
import { Recipe } from './recipe'

Recipe.initialize()
Plan.initialize()
executor.initialize()
initializeBuild()

export const compile = {
    manualBuild,
    autoBuild,
    terminate,
    preventAutoBuild,
    isFileExcludedFromBuildOnSave,
    get backend() {
        return executor.backend
    },
    get compiledPDFPath() {
        return executor.compiledPDFPath
    },
    get compiledPDFWriting() {
        return executor.compiledPDFWriting
    }
}
