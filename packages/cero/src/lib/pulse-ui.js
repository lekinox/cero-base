import { CeroError } from '@cero-base/core/errors'

export function follow() {
  throw CeroError.INVALID('pulse runs in the worker')
}
