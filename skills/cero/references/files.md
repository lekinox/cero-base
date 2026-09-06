# Files

```js
const { data: file } = await cero.put(me.files, {
  data: bytes, // Buffer or Readable
  name: 'cat.jpg',
  type: 'image/jpeg'
})

img.src = file.url
```

Every handle has a `files` collection. `put` on it uploads the bytes and returns a row with a `url` you can render right away.

## Reading them back

```js
const { data: files } = await cero.get(me.files)
const { data: one } = await cero.get(me.files, file.id)
cero.watch(me.files).on('data', ({ data }) => render(data))
```

Every row comes back as `{ id, name, type, size, url }`. The bytes live in a blob store owned by the handle, replicated to members on demand and never inlined in the log, so a row is small and a room with many files stays fast to open.

## A file on a row

Declare the field as `t.file`, store the file's id, and read it back resolved.

```js
// schema.js
profile: t.single({ name: t.string, avatar: t.file })
```

```js
const { data: pic } = await cero.put(me.files, { data: bytes, type: 'image/png' })
await cero.set(me.profile, { avatar: pic.id })

const { data: profile } = await cero.get(me.profile)
img.src = profile.avatar.url // { id, type, size, url }, no extra lookup
```

## URLs are local and ephemeral

```js
const { data: file } = await cero.get(me.files, id) // a fresh url every read
img.src = file.url
img.src = me.getLink(id) // the same, from an id you already hold
```

A `url` points at a server on this device with a token that changes on every start. It is not shareable and it must not be stored. Store the id, which cero does for you, and read the row again to get a current url. Each member derives their own url from the same id, and the bytes download the first time the url is fetched. `handle.getLink(id)` gives the url for an id you already hold.

## In a child handle

```js
const { data: photo } = await cero.put(room.files, { data: bytes, type: 'image/jpeg' })
await cero.put(room.messages, { text: 'look', attachment: photo.id }) // attachment: t.file
```

Files uploaded to a child handle replicate with it and follow its encryption: a member removed before a key rotation cannot read files uploaded after it. See [Encryption](encryption.md).

Over RPC an upload crosses the wire as one message, and the url the client receives points at the backend's file server.

## Next

- [Network](network.md) for mirrors, which keep files available while you are offline.
- [Encryption](encryption.md) for what a removed member can still read.
- [Handles](handles.md) for who may write to a room.
