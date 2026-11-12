import { useState } from 'react'
import { cero } from '@cero-base/cero/client'
import { useCero, useRoom } from '../hooks/use-cero'
import { useQuery } from '../hooks/use-query'
import { Button, Input, Section, Card } from './ui'

function Request({ request, onError }) {
  const room = useRoom()
  const [reason, setReason] = useState('')
  return (
    <Card className='flex items-center gap-2'>
      <div className='flex-1 text-xs text-muted'>
        Asks to join as {request.role} <span className='font-mono'>{request.id.slice(0, 8)}</span>
      </div>
      <Input
        className='w-28'
        placeholder='Reason'
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <Button onClick={() => cero.accept(room, request).catch(onError)}>Accept</Button>
      <Button variant='danger' onClick={() => cero.deny(room, request, reason).catch(onError)}>
        Deny
      </Button>
    </Card>
  )
}

export function People() {
  const me = useCero()
  const room = useRoom()
  const { data: requests } = useQuery(room.requests, { admitted: false })
  const { data: members } = useQuery(room.members)
  const [open, setOpen] = useState(false)
  const [ttl, setTtl] = useState('')
  const [invite, setInvite] = useState('')
  const [error, setError] = useState(null)
  const fail = (err) => setError(err.message)

  const mint = () =>
    cero
      .invite(room, { confirm: true, ...(ttl.trim() && { ttl: ttl.trim() }) })
      .then(setInvite, fail)

  return (
    <div className='px-3 py-2 bg-card border-b border-border space-y-2 text-xs'>
      <Button variant='ghost' onClick={() => setOpen(!open)}>
        People
      </Button>
      {open && (
        <>
          {error && <div className='text-error'>{error}</div>}
          <div className='flex gap-2'>
            <Input
              className='w-40'
              placeholder='Expires in, e.g. 10s'
              value={ttl}
              onChange={(e) => setTtl(e.target.value)}
            />
            <Button onClick={mint}>Invite with approval</Button>
            {invite && (
              <Input
                className='flex-1 font-mono'
                aria-label='Approval invite'
                readOnly
                value={invite}
              />
            )}
          </div>
          {requests.length > 0 && (
            <section aria-label='Requests'>
              <Section title='Requests'>
                {requests.map((r) => (
                  <Request key={r.id} request={r} onError={fail} />
                ))}
              </Section>
            </section>
          )}
          <section aria-label='Members'>
            <Section title='Members'>
              {members.map((m) => (
                <Card key={m.id} className='flex items-center gap-2'>
                  <span className='flex-1 text-card-foreground'>
                    {m.name || m.id.slice(0, 8)} <span className='text-muted'>{m.role}</span>
                  </span>
                  {m.id !== me.id && (
                    <Button
                      variant='ghost'
                      onClick={() => cero.del(room.members, m.id).catch(fail)}
                    >
                      Remove
                    </Button>
                  )}
                </Card>
              ))}
            </Section>
          </section>
        </>
      )}
    </div>
  )
}
