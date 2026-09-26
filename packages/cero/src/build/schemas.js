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
    role: required(string),
    expires: int,
    reuse: bool,
    createdAt: int,
    index: uint,
    // its joins wait for a member to accept them
    confirm: bool
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
    stamp: uint,
    // the file this one was copied from, so a sync copies it once
    from: string
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
  },
  // appended by the joiner's own writer core, sealed to the database's address
  join: {
    box: required(bytes)
  },
  accept: {
    id: required(string),
    role: string
  },
  // a join from its arrival until the joiner has its keys: waiting for a member on a confirm
  // invite, then admitted and owed its reply. `id` is the joiner's writer
  request: {
    id: required(string),
    identity: required(bytes),
    invite: required(string),
    reply: required(bytes),
    createdAt: int,
    index: uint,
    admitted: bool,
    expires: int,
    // what the join asks for, the invite's role; once admitted, the role granted
    role: string
  },
  // a removed member comes back only through an invite minted after `index`
  removal: {
    id: required(string),
    index: required(uint)
  },
  // this device's live view of a context: computed on read, never stored
  status: {
    role: string,
    writable: bool,
    epoch: uint,
    suspended: bool,
    // an app version this one cannot read ops from, 0 when current
    behind: uint,
    // the Bluetooth radio: 'on', 'off', 'waiting', 'unauthorized', 'unsupported', null without it
    nearby: string
  },
  // a join this device still waits on, without its keys
  joining: {
    id: required(string),
    type: required(string),
    invite: required(string)
  },
  // a person linked over Bluetooth, by the identity that signed their device's key, with the name
  // and device type that device told
  peer: {
    id: required(string),
    name: string,
    isMobile: bool,
    device: string
  }
}

export const local = {
  master: {
    seed: required(bytes)
  },
  keypair: {
    publicKey: required(bytes),
    secretKey: required(bytes),
    // 'create' or 'recover' until this device's setup finished: a killed launch resumes it
    setup: string
  },
  'handle-keypair': {
    id: required(string),
    publicKey: required(bytes),
    secretKey: required(bytes),
    encryptionKey: bytes
  },
  // a room with invites, reopened at boot so its joins are answered
  serving: {
    id: required(string),
    type: required(string)
  },
  // a join not answered yet: the writer is fixed before the join is written, so a resumed one
  // hears the reply to it
  join: {
    id: required(string),
    type: required(string),
    invite: required(string),
    publicKey: required(bytes),
    secretKey: required(bytes),
    // the reply, once it landed: the join then opens the room without joining again
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
    noUpsert: bool,
    // the indexes of the fields a set sends: the typed row decodes the others as defaults
    fields: { ...uint, array: true }
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
    data: bytes,
    confirm: bool
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
  'res-invite': {
    invite: required(string)
  },
  'res-handle': {
    id: required(string),
    type: required(string),
    name: string,
    // a join turned away: an error crosses as code and message, without its reason
    denied: bool,
    reason: string
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
    fileToken: string,
    deviceName: string
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
    stack: string,
    reason: string
  },
  // accept, or deny with a reason
  'req-answer': {
    handle: required(string),
    id: required(string),
    accept: bool,
    role: string,
    reason: string
  },
  // the mesh when `on`, one invite's rendezvous when `invite` is set
  'req-nearby': {
    on: bool,
    invite: string
  }
}
