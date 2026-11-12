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

function Request({ request, onError }) {
  const room = useRoom()
  const [reason, setReason] = useState('')
  return (
    <div className='flex items-center gap-2'>
      <span className='flex-1 text-muted font-mono'>{`${request.role} · ${request.id.slice(0, 8)}`}</span>
      <Button onClick={() => cero.accept(room, request).catch(onError)}>Approve</Button>
      <Input
        className='w-28'
        placeholder='Reason'
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <Button variant='secondary' onClick={() => cero.deny(room, request, reason).catch(onError)}>
        Deny
      </Button>
    </div>
  )
}

export function People({ seated, onError }) {
  const me = useCero()
  const room = useRoom()
  const { data: status } = useQuery(room.status)
  const { data: members } = useQuery(room.members)
  const { data: requests } = useQuery(room.requests, { admitted: false })
  const { data: invites } = useQuery(room.invites)
  const [confirm, setConfirm] = useState(false)
  const [role, setRole] = useState('member')
  const [reuse, setReuse] = useState(false)
  const [ttl, setTtl] = useState('')
  const [code, setCode] = useState('')
  const writer = seated && status.role !== 'reader'
  const moderator = seated && (status.role === 'owner' || status.role === 'admin')

  const mint = async () => {
    const { data: before } = await cero.get(room.invites)
    const invite = await cero.invite(room, {
      role,
      reuse,
      confirm,
      ...(ttl.trim() && { ttl: ttl.trim() })
    })
    const { data: after } = await cero.get(room.invites)
    const known = new Set(before.map((i) => i.id))
    for (const row of after) if (!known.has(row.id)) codes.set(row.id, invite)
    setCode(invite)
  }

  return (
    <div className='px-3 py-2 bg-card border-b border-border space-y-3 max-h-72 overflow-y-auto text-xs'>
      {writer && (
        <>
          <div className='flex items-center gap-3 flex-wrap'>
            <label className='flex items-center gap-1 text-muted'>
              <input
                type='checkbox'
                checked={confirm}
                onChange={(e) => setConfirm(e.target.checked)}
              />
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
            <Input
              className='w-40'
              placeholder='Expires in, e.g. 10s'
              value={ttl}
              onChange={(e) => setTtl(e.target.value)}
            />
            <Button onClick={() => mint().catch(onError)}>Create code</Button>
          </div>
          {code && <Input readOnly aria-label='Code' value={code} className='w-full font-mono' />}

          {requests.length > 0 && (
            <section aria-label='Requests'>
              <Section title='Requests'>
                {requests.map((r) => (
                  <Request key={r.id} request={r} onError={onError} />
                ))}
              </Section>
            </section>
          )}

          {invites.length > 0 && (
            <section aria-label='Invites'>
              <Section title='Invites'>
                {invites.map((i) => (
                  <div key={i.id} className='flex items-center gap-2'>
                    <span className='flex-1 text-muted'>{describe(i)}</span>
                    {moderator && codes.has(i.id) && (
                      <Button
                        variant='ghost'
                        onClick={() => cero.revoke(room, codes.get(i.id)).catch(onError)}
                      >
                        Revoke
                      </Button>
                    )}
                  </div>
                ))}
              </Section>
            </section>
          )}
        </>
      )}

      <section aria-label='Members'>
        <Section title='Members'>
          <ul className='space-y-1'>
            {members.map((m) => (
              <li key={m.id} className='flex items-center gap-2'>
                <span className='flex-1 text-card-foreground'>{`${m.name || m.id.slice(0, 8)} · ${m.role}`}</span>
                {moderator && m.id !== me.id && (
                  <Button
                    variant='danger'
                    onClick={() => cero.del(room.members, m.id).catch(onError)}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Section>
      </section>
    </div>
  )
}
