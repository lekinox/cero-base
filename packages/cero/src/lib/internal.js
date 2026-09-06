// process-wide extension registry: build() folds in schemas, cero() runs setups
import { profileSync } from '../extensions/profile-sync.js'
import { handleSync } from '../extensions/handle-sync.js'

export const internal = { extensions: [profileSync(), handleSync()] }
