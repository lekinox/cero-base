import { useState } from 'react'
import * as cero from '@cero-base/cero/client'
import { useCero } from '../hooks/use-cero'
import { useQuery } from '../hooks/use-query'
import { useTheme } from '../hooks/use-theme'
import { useToast } from '../hooks/use-toast'
import { Button, Input, Section, Card } from './ui'
import { Avatar } from './avatar'
import { Toast } from './toast'

export function Settings() {
  const me = useCero()
  const { data: profile } = useQuery(me.profile)
  const { data: devices } = useQuery(me.devices)
  const { theme, toggle } = useTheme()
  const toast = useToast()
  const [seed, setSeed] = useState(null)
  const [invite, setInvite] = useState('')

  const reveal = async () => {
    try {
      setSeed(await me.identity.toPhrase())
    } catch {
      setSeed('(no seed stored)')
    }
  }

  const copy = (text) => {
    navigator.clipboard.writeText(text)
    toast.show('Copied to clipboard')
  }

  return (
    <div className='space-y-4'>
      <Card className='flex items-center gap-4'>
        <label className='cursor-pointer'>
          <Avatar name={profile?.name} src={profile?.avatar?.url} size={48} />
          <input
            type='file'
            accept='image/*'
            className='hidden'
            onChange={async (e) => {
              const file = e.target.files?.[0]
              if (!file) return
              const data = new Uint8Array(await file.arrayBuffer())
              const { data: row } = await cero.put(me.files, {
                data,
                name: file.name,
                type: file.type
              })
              await cero.set(me.profile, { avatar: row.id })
            }}
          />
        </label>
        <div className='flex-1 space-y-2'>
          <Input
            className='w-full'
            defaultValue={profile?.name}
            onBlur={(e) => {
              const v = e.target.value.trim()
              if (v && v !== profile?.name) cero.set(me.profile, { name: v })
            }}
          />
          <div className='text-xs text-muted font-mono'>{me.id?.slice(0, 16)}...</div>
        </div>
      </Card>

      <Section title='Theme'>
        <Button onClick={toggle} className='w-full'>
          {theme === 'dark' ? 'Switch to Light' : 'Switch to Dark'}
        </Button>
      </Section>

      <Section title='Seed Phrase'>
        {seed ? (
          <>
            <div className='p-2 bg-warning/10 border border-warning/30 rounded text-xs font-mono text-warning break-all'>
              {seed}
            </div>
            <div className='flex gap-2'>
              <Button onClick={() => copy(seed)}>Copy</Button>
              <Button onClick={() => setSeed(null)} variant='secondary'>
                Hide
              </Button>
            </div>
          </>
        ) : (
          <Button onClick={reveal} className='w-full'>
            Show Seed
          </Button>
        )}
      </Section>

      <Section title='Devices'>
        {devices.map((d) => (
          <Card key={d.id}>
            <div className='flex items-center gap-2 text-xs'>
              <span className='text-card-foreground'>{d.name || 'Unnamed'}</span>
              <span className='text-muted font-mono'>{d.id?.slice(0, 8)}</span>
              {d.id === me.device?.id && <span className='text-accent'>(current)</span>}
            </div>
          </Card>
        ))}
        {invite ? (
          <>
            <Card className='text-xs font-mono text-muted break-all'>{invite}</Card>
            <div className='flex gap-2'>
              <Button onClick={() => copy(invite)}>Copy</Button>
              <Button onClick={() => setInvite('')} variant='secondary'>
                Clear
              </Button>
            </div>
          </>
        ) : (
          <Button onClick={() => me.invite().then(setInvite)} className='w-full'>
            Pair New Device
          </Button>
        )}
      </Section>

      <Toast message={toast.message} />
    </div>
  )
}
