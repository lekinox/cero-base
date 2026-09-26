import { schema, t } from '@cero-base/core/schema'

export default schema({
  profile: t.single({
    name: t.string,
    avatar: t.bytes
  }),

  messages: t.collection(
    {
      text: t.string,
      attachment: t.bytes
    },
    { indexes: { 'by-text': ['text'] } }
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
})
