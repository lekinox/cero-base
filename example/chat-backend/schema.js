import { cero, t } from '@cero-base/cero'

export const schema = cero.schema({
  profile: t.single({
    name: t.string,
    avatar: t.file
  }),

  room: {
    profile: t.single({ name: t.string }),
    messages: t.collection({ text: t.string })
  },

  local: {
    settings: t.collection({
      key: t.string,
      value: t.string
    })
  }
})
