import { cero } from '@cero-base/cero/client'
import { useCero } from '../hooks/use-cero'
import { useQuery } from '../hooks/use-query'
import { Button, Section, Card } from './ui'

const ENDED = {
  denied: (r) => (r.reason ? `Denied: ${r.reason}` : 'Denied'),
  expired: () => 'The invite expired',
  removed: (r) => `Removed by ${r.by?.slice(0, 8)}`
}

function JoinCard({ row, label, action, onAction }) {
  return (
    <Card className='flex items-center gap-2'>
      <div className='flex-1 min-w-0'>
        <div className='font-medium text-sm text-card-foreground'>
          {row.name || `${row.id.slice(0, 12)}...`}
        </div>
        <div className='text-xs text-muted'>{label}</div>
      </div>
      {action && (
        <Button variant='secondary' onClick={onAction}>
          {action}
        </Button>
      )}
    </Card>
  )
}

export function Joins() {
  const me = useCero()
  const { data: asking } = useQuery(me.room, { state: 'asking' })
  const { data: joining } = useQuery(me.room, { state: 'joining' })
  const { data: denied } = useQuery(me.room, { state: 'denied' })
  const { data: expired } = useQuery(me.room, { state: 'expired' })
  const { data: removed } = useQuery(me.room, { state: 'removed' })
  const waiting = [...asking, ...joining]
  const ended = [...denied, ...expired, ...removed]

  return (
    <>
      {waiting.length > 0 && (
        <section aria-label='Waiting'>
          <Section title='Waiting'>
            {waiting.map((r) => (
              <JoinCard
                key={r.id}
                row={r}
                label={r.state === 'asking' ? 'Waiting for a member to let you in' : 'Joining'}
                action={r.state === 'asking' && 'Cancel'}
                onAction={() => cero.cancel(me, r.invite)}
              />
            ))}
          </Section>
        </section>
      )}
      {ended.length > 0 && (
        <section aria-label='Ended'>
          <Section title='Ended'>
            {ended.map((r) => (
              <JoinCard
                key={r.id}
                row={r}
                label={ENDED[r.state](r)}
                action='Dismiss'
                onAction={() => cero.del(me.room, r.id)}
              />
            ))}
          </Section>
        </section>
      )}
    </>
  )
}
