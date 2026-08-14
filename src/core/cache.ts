import { lw } from '../lw'
import { Cache } from './cache/cache'

export const cache = new Cache()

// Cache owns its watcher subscriptions; the facade attaches the production
// instance to the extension lifetime.
lw.onDispose(cache)
