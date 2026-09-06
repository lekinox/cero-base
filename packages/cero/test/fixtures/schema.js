import { schema, t } from '@cero-base/cero'

export default schema({
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

  local: {
    drafts: t.collection({
      text: t.string
    }),
    settings: t.single({
      entropy: t.bytes
    })
  }
})
