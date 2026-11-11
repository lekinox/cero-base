import { schema, t } from '@cero-base/core/schema'

const defs = {
  profile: t.single({
    name: t.string,
    avatar: t.bytes,
    photo: t.file
  }),

  messages: t.collection(
    {
      text: t.string,
      attachment: t.bytes,
      photo: t.file
    },
    { indexes: { 'by-text': ['text'] }, push: true }
  ),

  records: t.collection({ text: t.string }, { own: true }),

  team: {
    messages: t.collection({
      text: t.string
    }),
    notes: t.collection({
      text: t.string
    }),
    promote: t.action({
      memberId: t.string,
      role: t.string
    })
  },

  tasks: t.collection({ title: t.required(t.string), done: t.bool }),

  local: {
    drafts: t.collection({
      text: t.string
    }),
    settings: t.single({
      entropy: t.bytes
    }),
    tasks: t.collection({ title: t.required(t.string) })
  }
}

export default schema(defs)

// the next release of the app: everything it adds is held back, so its databases stay where they are
export const next = schema({
  ...defs,
  profile: t.single({ ...defs.profile.fields, bio: t.later(t.string) }),
  messages: t.collection(
    { ...defs.messages.fields, tag: t.later(t.string), cover: t.later(t.file) },
    { indexes: { 'by-text': ['text'] }, push: true }
  ),
  members: t.extend({ alias: t.later(t.string) }),
  visits: t.later(t.collection({ date: t.string })),
  prefs: t.later(t.single({ theme: t.string })),
  ping: t.later(t.action({ x: t.string }))
})
