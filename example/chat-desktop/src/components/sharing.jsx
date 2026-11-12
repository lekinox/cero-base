import { useState } from 'react'
import { cero } from '@cero-base/cero/client'
import { useCero, useRoom } from '../hooks/use-cero'
import { useQuery } from '../hooks/use-query'
import { Button, Input, Section } from './ui'

const roles = ['member', 'reader', 'admin']

// cero.revoke takes the code, and a room.invites row keeps only its id
const codes = new Map()

function describe(invite) {
  const kind = invite.reuse ? 'reusable' : 'single use'
  return `${invite.role}, ${kind}${invite.confirm ? ', needs approval' : ''}`
}

export function Sharing() {
  const me = useCero()
  const room = useRoom()
  const { data: members } = useQuery(room.members)
  const { data: requests } = useQuery(room.requests, { admitted: false })
  const { data: invites } = useQuery(room.invites)
  const [confirm, setConfirm] = useState(false)
  const [role, setRole] = useState('member')
  const [reuse, setReuse] = useState(false)
  const [code, setCode] = useState('')
  const [reasons, setReasons] = useState({})
  const [error, setError] = useState(null)
  const mine = members.find((m) => m.id === me.id)?.role
  const moderator = mine === 'owner' || mine === 'admin'

  const run = (fn) => {
    setError(null)
    fn().catch((err) => setError(err.message))
  }

  const mint = async () => {
    const { data: before } = await cero.get(room.invites)
    const invite = await cero.invite(room, { role, reuse, confirm })
    const { data: after } = await cero.get(room.invites)
    const known = new Set(before.map((i) => i.id))
    for (const row of after) if (!known.has(row.id)) codes.set(row.id, invite)
    setCode(invite)
  }

  if (mine === 'reader') {
    return (
      <div className='px-3 py-2 border-b border-border text-xs text-muted'>
        Read only: readers cannot write here
      </div>
    )
  }

  return (
    <div className='px-3 py-2 border-b border-border space-y-3 max-h-72 overflow-y-auto text-xs'>
      <div className='flex items-center gap-3 flex-wrap'>
        <label className='flex items-center gap-1 text-muted'>
          <input type='checkbox' checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
          Needs approval
        </label>
        <select
          aria-label='Role'
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className='px-2 py-1 bg-input border border-border rounded text-foreground'
        >
          {roles.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
        <label className='flex items-center gap-1 text-muted'>
          <input type='checkbox' checked={reuse} onChange={(e) => setReuse(e.target.checked)} />
          Reusable
        </label>
        <Button onClick={() => run(mint)}>Create code</Button>
      </div>
      {code && <Input readOnly aria-label='Code' value={code} className='w-full font-mono' />}
      {error && <div className='text-error'>{error}</div>}

      <Section title='Requests'>
        {requests.map((r) => (
          <div key={r.id} className='flex items-center gap-2'>
            <span className='flex-1 text-muted font-mono'>{`${r.role} · ${r.id.slice(0, 8)}`}</span>
            <Button onClick={() => run(() => cero.accept(room, r))}>Approve</Button>
            <Input
              className='w-28'
              placeholder='Reason'
              value={reasons[r.id] ?? ''}
              onChange={(e) => setReasons({ ...reasons, [r.id]: e.target.value })}
            />
            <Button
              onClick={() => run(() => cero.deny(room, r, reasons[r.id] ?? ''))}
              variant='secondary'
            >
              Deny
            </Button>
          </div>
        ))}
      </Section>

      <Section title='Invites'>
        {invites.map((i) => (
          <div key={i.id} className='flex items-center gap-2'>
            <span className='flex-1 text-muted'>{describe(i)}</span>
            {moderator && codes.has(i.id) && (
              <Button onClick={() => run(() => cero.revoke(room, codes.get(i.id)))} variant='ghost'>
                Revoke
              </Button>
            )}
          </div>
        ))}
      </Section>

      <Section title='Members'>
        {members.map((m) => (
          <div key={m.id} className='flex items-center gap-2'>
            <span className='flex-1 text-card-foreground'>{`${m.name || m.id.slice(0, 8)} · ${m.role}`}</span>
            {moderator && m.id !== me.id && (
              <Button onClick={() => run(() => cero.del(room.members, m.id))} variant='ghost'>
                Remove
              </Button>
            )}
          </div>
        ))}
      </Section>
    </div>
  )
}
