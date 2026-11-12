import { useCero } from '../hooks/use-cero'
import { useQuery } from '../hooks/use-query'
import { Section } from './ui'

function why(row) {
  if (row.state === 'asking' || row.state === 'joining') return 'Waiting to be let in'
  if (row.state === 'denied') return `Turned away: ${row.reason || 'no reason given'}`
  if (row.state === 'expired') return 'The invite expired'
  return `Removed by ${row.by?.slice(0, 8)}`
}

// the joins on their way and the ones that ended, which a list of rooms leaves out
export function Joins() {
  const me = useCero()
  const { data: asking } = useQuery(me.room, { state: 'asking' })
  const { data: joining } = useQuery(me.room, { state: 'joining' })
  const { data: denied } = useQuery(me.room, { state: 'denied' })
  const { data: expired } = useQuery(me.room, { state: 'expired' })
  const { data: removed } = useQuery(me.room, { state: 'removed' })
  const rows = [...asking, ...joining, ...denied, ...expired, ...removed]

  if (rows.length === 0) return null
  return (
    <Section title='Joins'>
      {rows.map((r) => (
        <div key={r.id} className='p-2 bg-card border border-border rounded text-xs text-muted'>
          {why(r)}
        </div>
      ))}
    </Section>
  )
}
