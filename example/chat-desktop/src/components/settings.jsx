import { useState } from 'react'
import { cero } from '@cero-base/cero/client'
import { useCero } from '../hooks/use-cero'
import { useQuery } from '../hooks/use-query'
import { useTheme } from '../hooks/use-theme'
import { useToast } from '../hooks/use-toast'
import { Button, Input, Section, Card } from './ui'
import { Avatar } from './avatar'
import { Toast } from './toast'
import { useSeated } from '../hooks/use-seated'

export function Settings() {
  const me = useCero()
  const { data: profile } = useQuery(me.profile)
  const { data: devices } = useQuery(me.devices)
  const { data: requests } = useQuery(me.requests, { admitted: false })
  const { theme, toggle } = useTheme()
  const toast = useToast()
  const seated = useSeated()
  const fail = (err) => toast.show(err.message)
  const [seed, setSeed] = useState(null)
  const [invite, setInvite] = useState(null)

  const reveal = async () => {
    try {
      setSeed(await cero.phrase(me))
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
        <label className={seated ? 'cursor-pointer' : ''}>
          <Avatar name={profile?.name} src={profile?.avatar?.url} size={48} />
          <input
            type='file'
            accept='image/*'
            className='hidden'
            disabled={!seated}
            onChange={async (e) => {
              const file = e.target.files?.[0]
              if (!file) return
              const data = new Uint8Array(await file.arrayBuffer())
              try {
                const { data: row } = await cero.put(me.files, {
                  data,
                  name: file.name,
                  type: file.type
                })
                await cero.set(me.profile, { avatar: row.id })
              } catch (err) {
                fail(err)
              }
            }}
          />
        </label>
        <div className='flex-1 space-y-2'>
          <Input
            className='w-full'
            defaultValue={profile?.name}
            disabled={!seated}
            onBlur={(e) => {
              const v = e.target.value.trim()
              if (v && v !== profile?.name) cero.set(me.profile, { name: v }).catch(fail)
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

      {seated && (
        <Section title='Link a Device'>
          {invite ? (
            <>
              <div className='p-2 bg-input border border-border rounded text-xs font-mono break-all'>
                {invite}
              </div>
              <div className='flex gap-2'>
                <Button onClick={() => copy(invite)}>Copy</Button>
                <Button onClick={() => setInvite(null)} variant='secondary'>
                  Hide
                </Button>
              </div>
            </>
          ) : (
            <Button onClick={() => cero.invite(me).then(setInvite, fail)} className='w-full'>
              Show Device Invite
            </Button>
          )}
          {requests.map((r) => (
            <Card key={r.id}>
              <div className='text-xs text-muted'>
                A device asks to be yours. Approve it only if it shows this id:
              </div>
              <div className='text-xs font-mono text-card-foreground break-all my-1'>{r.id}</div>
              <div className='flex gap-2'>
                <Button onClick={() => cero.accept(me, r).catch(fail)}>Approve</Button>
                <Button onClick={() => cero.deny(me, r, 'denied').catch(fail)} variant='secondary'>
                  Deny
                </Button>
              </div>
            </Card>
          ))}
        </Section>
      )}

      <Section title='Devices'>
        {!seated && (
          <div className='p-2 bg-error/10 border border-error/30 rounded text-xs text-error'>
            This device was removed from your profile
          </div>
        )}
        {devices.map((d) => {
          const current = d.id === me.device?.id
          return (
            <Card key={d.id}>
              <div className='flex items-center gap-2 text-xs'>
                <Input
                  key={d.name}
                  className='flex-1'
                  placeholder='Device name'
                  defaultValue={d.name}
                  disabled={!seated}
                  onBlur={(e) => {
                    const v = e.target.value.trim()
                    if (v && v !== d.name) cero.set(me.devices, { id: d.id, name: v }).catch(fail)
                  }}
                />
                <span className='text-muted font-mono'>{d.id?.slice(0, 8)}</span>
                {current && <span className='text-accent'>(current)</span>}
                {seated && !current && (
                  <Button
                    onClick={() => cero.del(me.devices, d.id).catch(fail)}
                    variant='danger'
                    className='ml-auto'
                  >
                    Remove
                  </Button>
                )}
              </div>
            </Card>
          )
        })}
      </Section>

      <Toast message={toast.message} />
    </div>
  )
}
