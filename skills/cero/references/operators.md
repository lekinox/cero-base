# Operators

```js
// operators/guest.js
import { cero } from '@cero-base/cero/extensions'

export const create = (expo, data) => cero.put(expo.guests, { ...data, id: guestId(data.id) })
export const update = (expo, id, info) => cero.set(expo.guests, { id, ...info })
export const remove = (expo, id) => cero.del(expo.guests, id)
```

```js
const expo = await cero.open(me.expo, { name: 'Health 2026' })
await expo.guest.create({ name: 'Ana' })
```

An operator is a function of a handle, composed from the ordinary operators.
Bound on the handle it reads as `expo.guest.create(data)`, and it runs in
whichever process calls it, the backend or the UI, because both sides have the
same `put`, `set` and `get`.

## The map

Operators are keyed by namespace. A bare key binds on the root handle. A key
naming a handle type holds that type's namespaces, bound on every handle of that
type and never on the root.

```js
// operators.js
import * as settings from './operators/settings.js'
import * as guest from './operators/guest.js'
import * as station from './operators/station.js'

export const operators = {
  settings, // me.settings.update(...)
  expo: { guest, station } // expo.guest.create(...), expo.station.add(...)
}
```

`import * as guest` turns a file of functions into a namespace, so a feature
lives in its own file and the map only composes. A namespace cannot share its
name with a ref or a builtin on the same handle, `profile` and `device` on the
root for instance, since the bound object would shadow it.

## Named once

Tell the build where the map is and every process binds it, nothing registers
anything.

```js
// build.js
await build('./spec', schema, { operators: '../operators.js' })
```

The path is written into `spec/index.js` as given, so it is relative to the spec
directory and names the file as it exists at runtime. `cero('./data', spec)`
binds the map on the root and on every handle it opens, `connect(ipc, spec)`
binds it on the stubs. The module is bundled into the UI, so it imports from
`@cero-base/cero/extensions`, never from `@cero-base/cero`.

A map can also be passed directly, `cero(dir, spec, { operators })` or
`connect(ipc, spec, { operators })`, and it replaces the spec's for that process.
That is the hatch for tests and for a map decided at runtime.

## Operators and extensions

Operators are functions your app calls. An [extension](extensions.md) changes
what cero is for your app: fields and refs in the schema, and behaviour that runs
inside the backend. The two never mix. An operator adds nothing to the schema and
runs no setup, an extension binds nothing on a handle.

## Next

- [Extensions](extensions.md) for schema and behaviour named the same way.
- [Apps](apps.md) for which process runs what.
