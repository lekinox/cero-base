import { get, set } from '@cero-base/cero'

export async function promote(handle, memberId, role) {
  const { data: members } = await get(handle.members)
  const m = members.find((x) => x.id === memberId)
  if (m) await set(handle.members, { ...m, role })
}

export const demote = (handle, memberId) => promote(handle, memberId, 'read')
