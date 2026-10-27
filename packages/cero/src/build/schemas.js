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
    // the device's proof over the admission, chained to `master`
    proof: required(bytes),
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
    index: uint,
    // the device key its admission proved: rotation seals to it
    key: bytes,
    // the chain to the identity, when a device of the member linked it here
    proof: bytes
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
    index: uint,
    // its rotation epochs, for a device of the identity opening it later
    epochs: bytes
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
    role: string,
    // the accepter's own device attests the joiner's: a device of the member, not a member
    proof: bytes
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
    role: string,
    // the device key the join's proof ends at
    key: bytes
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
  },
  // a join the handle turned away, until the joiner read why. `id` is the joiner's writer
  refusal: {
    id: required(string),
    reply: required(bytes),
    reason: required(string),
    expires: int
  },
  // an invite spent or revoked, kept until it expires so a join with it hears why
  spent: {
    id: required(string),
    reason: required(string),
    expires: int
  },
  deny: {
    id: required(string),
    reason: string
  },
  // a handle's push topic: what a device subscribes to for pushes about it
  topic: {
    id: required(string),
    handle: required(string),
    type: required(string),
    name: string
  }
}

export const local = {
  master: {
    seed: required(bytes)
  },
  // this device's key and its proof, with the identity it chains to and the root encryption key
  device: {
    publicKey: required(bytes),
    secretKey: required(bytes),
    proof: required(bytes),
    identity: required(bytes),
    encryptionKey: required(bytes)
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
  // a handle with invites, reopened at boot so its joins are answered
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
    // the reply, once it landed: the join then opens the handle without joining again
    key: bytes,
    encryptionKey: bytes,
    epochs: bytes,
    // the root's join: this device's secret key, bare until the reply brings its proof
    device: bytes,
    proof: bytes
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
  },
  // the handles rows a cold push process can read without the root: topic → handle and its key
  subscription: {
    id: required(string),
    handle: required(string),
    type: required(string),
    key: required(bytes),
    name: string
  }
}

export const rpc = {
  'req-empty': {
    ok: bool
  },
  'req-restore': {
    phrase: required(string)
  },
  'req-link': {
    invite: required(string)
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
  // an operator by name, run on the handle as in the worker: the args and the result are c.any
  'req-verb': {
    handle: required(string),
    verb: required(string),
    args: required(bytes)
  },
  'req-join': {
    parent: required(string),
    ref: required(string),
    invite: required(string)
  },
  'req-open': {
    parent: required(string),
    row: required(string),
    type: string
  },
  'req-handle': {
    handle: required(string)
  },
  'res-data': {
    data: bytes
  },
  'res-rows': {
    data: required(bytes),
    total: required(int),
    size: required(int)
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
  // a link's frames: the request's id as it is sent, then the identity once linked
  'res-link': {
    request: string,
    id: string,
    deviceId: string,
    deviceName: string,
    fileBase: string,
    fileToken: string
  },
  'res-ok': {
    ok: bool
  },
  'res-error': {
    message: required(string),
    code: string,
    stack: string,
    reason: string
  }
}
