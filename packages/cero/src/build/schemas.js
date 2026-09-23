// field order is the wire format: append only, never reorder
import { t } from '../lib/spec.js'

const { string, bytes, int, uint, bool, required } = t
const array = (m) => ({ ...m, array: true })

export const main = {
  'del-by-id': {
    id: required(string)
  },
  writer: {
    master: required(bytes),
    writer: required(bytes),
    sig: required(bytes),
    isIndexer: bool,
    ts: int,
    // the paired add-member decides the rank in the same transaction; `role` here is unread
    memberId: string,
    role: string
  },
  counter: {
    name: required(string),
    value: required(uint)
  },
  member: {
    id: required(string),
    key: required(bytes),
    role: required(string),
    name: string,
    createdAt: int,
    updatedAt: int,
    sig: bytes,
    index: uint
  },
  device: {
    id: required(string),
    memberId: string,
    name: string,
    isMobile: bool,
    createdAt: int,
    updatedAt: int,
    index: uint
  },
  invite: {
    id: required(string),
    secret: required(bytes),
    role: required(string),
    expires: int,
    reuse: bool,
    createdAt: int,
    index: uint
  },
  handle: {
    id: required(string),
    type: required(string),
    key: required(bytes),
    encryptionKey: bytes,
    name: string,
    createdAt: int,
    updatedAt: int,
    index: uint
  },
  file: {
    id: required(string),
    memberId: string,
    name: string,
    createdAt: int,
    updatedAt: int,
    index: uint,
    stamp: uint
  },
  claim: {
    identity: required(bytes),
    writer: required(bytes),
    sig: required(bytes),
    ts: int
  },
  epoch: {
    epoch: required(uint),
    wrapped: required(bytes),
    createdAt: int,
    commit: bytes,
    stamp: uint
  }
}

export const local = {
  master: {
    seed: required(bytes)
  },
  keypair: {
    publicKey: required(bytes),
    secretKey: required(bytes)
  },
  'handle-keypair': {
    id: required(string),
    publicKey: required(bytes),
    secretKey: required(bytes),
    encryptionKey: bytes
  },
  // a room serving invites, reopened at boot the way the app last opened it
  serving: {
    id: required(string),
    type: required(string),
    accept: bool,
    role: string
  },
  // a join not answered yet: the writer is fixed before the first knock, so a resumed one
  // hears the reply to an earlier knock
  join: {
    id: required(string),
    type: required(string),
    invite: required(string),
    publicKey: required(bytes),
    secretKey: required(bytes),
    // the reply, once it landed: the join then opens the room without knocking again
    key: bytes,
    encryptionKey: bytes,
    epochs: bytes
  },
  // mail the device's mailbox keeps: received until handled, sent until read. `mirrors` are
  // 32-byte keys back to back
  mail: {
    id: required(string),
    address: required(bytes),
    message: required(bytes),
    mirrors: bytes
  },
  environment: {
    channel: required(string)
  }
}

export const rpc = {
  'req-empty': {
    ok: bool
  },
  'req-restore': {
    phrase: required(string)
  },
  'req-row': {
    handle: required(string),
    ref: required(string),
    data: required(bytes),
    local: bool,
    noUpsert: bool
  },
  'req-id': {
    handle: required(string),
    ref: required(string),
    id: required(string),
    local: bool
  },
  'req-query': {
    handle: required(string),
    ref: required(string),
    query: bytes,
    local: bool
  },
  'req-call': {
    handle: required(string),
    op: required(string),
    data: bytes
  },
  'req-invite': {
    handle: required(string),
    role: string,
    // ms, or a duration like '12h'
    ttl: string,
    reuse: bool,
    data: bytes
  },
  'req-revoke': {
    handle: required(string),
    invite: required(string)
  },
  'req-join': {
    parent: required(string),
    ref: required(string),
    invite: required(string)
  },
  'req-cancel': {
    invite: required(string)
  },
  'req-open': {
    parent: required(string),
    row: required(string)
  },
  'req-handle': {
    handle: required(string)
  },
  'req-set-active': {
    handle: required(string),
    active: bool
  },
  'res-data': {
    data: bytes
  },
  'res-rows': {
    data: required(bytes),
    total: required(int),
    size: required(int)
  },
  'res-changes': {
    changes: required(bytes),
    reset: bool
  },
  'res-invite': {
    invite: required(string)
  },
  'res-handle': {
    id: required(string),
    type: required(string),
    name: string
  },
  'req-add-file': {
    handle: required(string),
    data: required(bytes),
    name: string,
    type: string
  },
  'res-identity': {
    id: required(string),
    deviceId: string,
    fileBase: string,
    fileToken: string
  },
  'res-joining': {
    invites: required(array(string))
  },
  'res-seed': {
    phrase: string
  },
  'res-ok': {
    ok: bool
  },
  'res-epoch': {
    epoch: required(uint)
  },
  'res-error': {
    message: required(string),
    code: string,
    stack: string
  }
}
