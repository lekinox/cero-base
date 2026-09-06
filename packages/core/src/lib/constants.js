export const SINGLE = 'single'
export const COLLECTION = 'collection'
export const HANDLE = 'handle'
export const ACTION = 'action'

export const ACTIVE = 'active'
export const PASSIVE = 'passive'

export const ROCKS = 'rocks'
export const BEE = 'bee'

export const OWNER = 'owner'
export const ADMIN = 'admin'
export const MEMBER = 'member'
export const READER = 'reader'

export const READ = 'read'
export const WRITE = 'write'
export const DELETE = 'delete'
export const INVITE = 'invite'
export const REMOVE = 'remove'
export const ASSIGN = 'assign'

export const ROLE_PERMS = {
  [OWNER]: ['*'],
  [ADMIN]: [READ, WRITE, DELETE, INVITE, REMOVE, ASSIGN],
  [MEMBER]: [READ, WRITE, INVITE],
  [READER]: [READ]
}

export const RANK = { [OWNER]: 3, [ADMIN]: 2, [MEMBER]: 1, [READER]: 0 }

export const NAMESPACE = 'cero'

// everything else in a query is an equality field; shared so both backends agree
export const QUERY_RESERVED = new Set([
  'gt',
  'gte',
  'lt',
  'lte',
  'limit',
  'reverse',
  'search',
  'fields',
  'total'
])

// monotonic index per collection
export const COUNTERS = 'counters'
// rotation announcements
export const EPOCHS = 'epochs'
