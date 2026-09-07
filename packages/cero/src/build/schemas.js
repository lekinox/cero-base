// field order is the wire format: append only, never reorder
import { t } from '../lib/spec.js'

const { string, bytes, int, uint, bool, required } = t

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
    invite: required(bytes),
    publicKey: required(bytes),
    data: bytes,
    sig: bytes,
    role: required(string),
    expires: int,
    createdAt: int,
    index: uint,
    seed: bytes,
    reuse: bool
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
    expiresIn: uint,
    reuse: bool
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
  'res-seed': {
    phrase: string
  },
  'res-ok': {
    ok: bool
  },
  'res-epoch': {
    epoch: required(uint)
  }
}
