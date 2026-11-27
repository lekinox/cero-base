import { schema, t } from '@cero-base/cero'

const defs = {
  profile: t.single({
    name: t.string,
    avatar: t.file
  }),

  messages: t.collection({
    text: t.string,
    attachment: t.bytes
  }),

  clips: t.collection({
    data: t.string
  }),

  members: t.extend({ avatar: t.bytes }),

  team: {
    messages: t.collection(
      {
        text: t.string
      },
      { push: true }
    ),
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

// the next release of the app: what it adds is held back, so its databases stay where they are
export const next = schema({
  ...defs,
  messages: t.collection({ ...defs.messages.fields, tag: t.later(t.string) }),
  visits: t.later(t.collection({ date: t.string }))
})
