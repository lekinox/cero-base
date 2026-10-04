# Operators

[Docs](README.md) · Previous: [Apps](apps.md) · Next: [Extensions](extensions.md)

Cero has no recipe for where your business logic lives. Anything that calls the verbs works:
functions, classes, a state store, your UI framework's hooks. Nothing registers your code, and Cero
makes no assumptions about its shape. This page shows the ways we recommend, and why, so you have a
starting point rather than a rule.

The simplest is your own operators: plain functions that take a context first and call Cero's verbs.
Write each feature once, in its own file, and call it from the worker, a terminal app, a test or a
UI.

```js
import { expo, guest } from './operators/index.js'

const fair = await expo.create(me, { name: 'Health 2026', city: 'San José' })
await guest.create(fair, { name: 'Ana' })
```

Most of an app's logic fits here. [Extensions](extensions.md), hooks and actions cover the narrower
case of a rule every device must enforce, [below](#when-every-device-must-enforce-it).

## Contexts

An operator takes a context: the thing its data hangs off. There are two kinds.

| Context        | Is                                                                                           | Its refs                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `me`, the root | the user on this device, from `cero('./data', spec)` in process or `cero(ipc, spec)` in a UI | the schema's top level, such as `me.settings`; a handle ref such as `me.expo` lists your expos |
| a handle       | a space opened from `me`, such as an expo, with its own members, roles and key               | its handle type's entries, such as `fair.guests` and `fair.profile`                            |

Both are plain state with refs hanging off them and no methods, which is why an operator takes one
as its first argument. `me.expo` is a ref on the root, not a handle: `cero.open(me.expo, …)` gives
you one. [Sharing](handles.md) explains handles, [Schema](schema.md#share-a-space-with-other-people)
how a type is declared, and the [API reference](api.md#contexts) lists everything a context holds.

## Write them

Given a schema:

```js
// schema.js
import { cero, t } from '@cero-base/cero'

export const schema = cero.schema({
  settings: t.single({ lang: t.string }),
  expo: {
    profile: t.single({ name: t.string, city: t.string }),
    guests: t.collection({ name: t.required(t.string), seen: t.bool }),
    stations: t.collection({ name: t.string })
  }
})
```

a file per feature works well, with a function for each thing the app does:

```js
// operators/guest.js
import { cero } from '@cero-base/cero/extensions'

export const create = (expo, data) => cero.put(expo.guests, data)
export const seen = (expo, id) => cero.set(expo.guests, { id, seen: true })
export const remove = (expo, id) => cero.del(expo.guests, id)
export const waiting = (expo) => cero.get(expo.guests, { seen: false })
```

```js
// operators/expo.js
import { cero } from '@cero-base/cero/extensions'

// one operator, several verbs: create the expo, then write its profile
export async function create(me, profile) {
  const expo = await cero.open(me.expo, { name: profile.name })
  await cero.set(expo.profile, profile)
  return expo
}
```

```js
// operators/settings.js
import { cero } from '@cero-base/cero/extensions'

export const update = (me, values) => cero.set(me.settings, values)
```

and an index that turns each file into a namespace:

```js
// operators/index.js
import * as expo from './expo.js'
import * as guest from './guest.js'
import * as settings from './settings.js'

export { expo, guest, settings }
```

What has worked well for us:

- **Context first.** `me` for the root's data, a handle for its own: `guest.create(expo, data)`.
  It reads like the verbs, and the same function works on any handle of the type.
- **Return what the caller needs**, often what the verb returns: `{ data }` from `put`, the handle
  from `open`.
- **Import `cero` from `@cero-base/cero/extensions`** when the file should run on both sides. It
  carries the verbs without the runtime, so
  the file runs in the worker and bundles into the UI. `@cero-base/cero` would pull the runtime into
  the UI, and `@cero-base/cero/client` would only run on a client.
- **Anything goes inside**: several verbs, the clock, an HTTP call, a quick check for the UI's
  sake. The determinism rules are for hooks only.

## Call them

The same file serves every process. In the worker, a terminal app or a test:

```js
import { cero } from '@cero-base/cero'
import { spec } from './spec/index.js'
import { expo, guest, settings } from './operators/index.js'

const me = await cero('./data', spec)
const fair = await expo.create(me, { name: 'Health 2026', city: 'San José' })
const { data: ana } = await guest.create(fair, { name: 'Ana' })
await guest.seen(fair, ana.id)
await settings.update(me, { lang: 'es' })
const { data: waiting } = await guest.waiting(fair)
```

In a UI over the worker ([Apps](apps.md)):

```js
import { cero } from '@cero-base/cero/client'
import { spec } from './spec/index.js'
import { guest } from './operators/index.js'

const me = await cero(ipc, spec)
const fair = await cero.open(me.expo, { id })
await guest.create(fair, { name: 'Marta' })
cero.watch(fair.guests, { seen: false }).on('data', ({ data }) => render(data))
```

In the UI the verbs inside the operator travel to the worker, so the checks, errors and results are
the same as in process. `before`, `after` and `tx` take functions and run only in the worker: an
operator that uses them cannot run in a UI.

## As classes

If your app is organised around objects, a class works just as well: a wrapper that holds a
context and puts your methods on top of it.

```js
// operators/guests.js
import { cero } from '@cero-base/cero/extensions'

export class Guests {
  constructor(expo) {
    this.expo = expo
  }

  create(data) {
    return cero.put(this.expo.guests, data)
  }

  seen(id) {
    return cero.set(this.expo.guests, { id, seen: true })
  }

  waiting() {
    return cero.get(this.expo.guests, { seen: false })
  }
}
```

```js
// operators/expo.js
import { cero } from '@cero-base/cero/extensions'
import { Guests } from './guests.js'

export class Expo {
  // a constructor cannot await, so opening goes through static factories
  static async create(me, profile) {
    const handle = await cero.open(me.expo, { name: profile.name })
    await cero.set(handle.profile, profile)
    return new Expo(handle)
  }

  static async open(me, id) {
    return new Expo(await cero.open(me.expo, { id }))
  }

  constructor(handle) {
    this.handle = handle
    this.guests = new Guests(handle)
  }

  get id() {
    return this.handle.id
  }

  rename(name) {
    return cero.set(this.handle.profile, { name })
  }

  close() {
    return cero.close(this.handle)
  }
}
```

```js
const fair = await Expo.create(me, { name: 'Health 2026', city: 'San José' })
const { data: ana } = await fair.guests.create({ name: 'Ana' })
await fair.guests.seen(ana.id)
await fair.rename('Health Fair 2026')

// in a UI, the same class on the client's me
const again = await Expo.open(me, id)
await again.guests.create({ name: 'Marta' })
```

- **Wrap the handle, never extend it.** Keep it in a field, as `this.handle`. A handle is Cero's: do
  not subclass `Handle` or add methods to one.
- **Open through static factories.** A constructor cannot await, so `Expo.create` and `Expo.open`
  open the handle and pass it in.
- **Hand Cero the handle, not the class.** Outside the class, call `cero.watch(fair.handle.guests)`,
  not `cero.watch(fair.guests)`.
- **It runs where it is called**, like a function: only the verbs inside travel to the worker.
  `close()` closes the handle, and every `watch` on it ends with it.

## In TypeScript

Type the context by the refs the operator touches:

```ts
// operators/guest.ts
import { cero } from '@cero-base/cero/extensions'
import type { Ref } from '@cero-base/cero'

type Expo = { guests: Ref }

export const create = (expo: Expo, data: { name: string }) => cero.put(expo.guests, data)
```

## When every device must enforce it

However you shape your code, it runs only where it is called. A check inside it holds for the device
that runs it, not for a peer that writes without it. It is the one case where the place your logic
lives changes what it can do. A rule every device must apply goes in an [extension](extensions.md):

| Logic                                                                        | Where                                                 |
| ---------------------------------------------------------------------------- | ----------------------------------------------------- |
| What the app does: compose verbs, read the clock, call an API, check for UI  | your operators                                        |
| A rule every write must pass, whoever writes it: who may edit, what is valid | a [`before` hook](data.md#react-to-writes)            |
| A write that must follow another on every device                             | an [`after` hook](data.md#react-to-writes)            |
| A named operation every device runs the same way, such as an archive         | an [action](extensions.md#give-an-action-its-handler) |

The operator stays the app's API either way. When its logic moves into an action, it becomes a thin
call and its callers do not change. The clock is read here, never in the hook:

```js
// operators/guest.js, with an `archive` action on expo and its after hook in an extension
export const archive = (expo, until = Date.now()) => cero.call(expo.archive, { until })
```

## Next

- [Extensions](extensions.md): hooks and actions that every device runs.
- [Data](data.md): every verb an operator can call.
