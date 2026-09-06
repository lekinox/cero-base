import { useState } from 'react'
import * as cero from '@cero-base/cero/client'
import { useCero } from '../hooks/use-cero'
import { useQuery } from '../hooks/use-query'
import { Button, Input, Section, Card, Page } from './ui'
import { Avatar } from './avatar'

export function Rooms({ onOpen, onSettings }) {
  const me = useCero()
  const { data: rooms } = useQuery(me.room)
  const { data: profile } = useQuery(me.profile)
  const userName = profile?.name || me.id?.slice(0, 8)
  const [name, setName] = useState('')
  const [invite, setInvite] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const create = async () => {
    setBusy(true)
    try {
      const room = await cero.open(me.room, { name: name.trim() })
      setName('')
      onOpen(room.id)
    } finally {
      setBusy(false)
    }
  }

  const join = async () => {
    setBusy(true)
    try {
      const room = await cero.open(me.room, { invite: invite.trim() })
      setInvite('')
      onOpen(room.id)
    } catch (err) {
      setError(err.message || 'Failed to join room')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Page>
      <div className='flex items-center justify-between'>
        <h1 className='text-xl font-bold text-accent'>Cero Chat</h1>
        <button
          onClick={onSettings}
          className='flex items-center gap-2 px-2 py-1 bg-card hover:bg-card/80 border border-border rounded-full'
        >
          <Avatar name={userName} />
          <span className='text-xs text-muted pr-1'>{userName}</span>
        </button>
      </div>

      {error && (
        <div className='p-2 bg-error/10 border border-error/30 rounded text-xs text-error'>
          {error}
        </div>
      )}

      <div className='flex gap-2'>
        <Input
          className='flex-1'
          placeholder='Room name'
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button onClick={create} disabled={!name.trim() || busy}>
          {busy ? 'Creating...' : 'New'}
        </Button>
      </div>

      <div className='flex gap-2'>
        <Input
          className='flex-1'
          placeholder='Invite code'
          value={invite}
          onChange={(e) => setInvite(e.target.value)}
        />
        <Button onClick={join} disabled={!invite || busy}>
          {busy ? 'Joining...' : 'Join'}
        </Button>
      </div>

      {rooms.length > 0 && (
        <Section title='Rooms'>
          {rooms.map((r) => (
            <Card key={r.id} onClick={() => onOpen(r.id)} className='text-left'>
              <div className='font-medium text-sm text-card-foreground'>{r.name || 'Unnamed'}</div>
              <div className='text-xs text-muted font-mono'>{r.id.slice(0, 12)}...</div>
            </Card>
          ))}
        </Section>
      )}
    </Page>
  )
}
