import { profileSync } from './profile-sync.js'
import { handleSync } from './handle-sync.js'

export * from './profile-sync.js'
export * from './handle-sync.js'

// process-wide: build() folds in each schema, cero() runs each setup
export const registry = [profileSync(), handleSync()]
