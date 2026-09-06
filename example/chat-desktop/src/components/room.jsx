import { useState, useEffect, useRef } from 'react'
import * as cero from '@cero-base/cero/client'
import { useCero, useRoom } from '../hooks/use-cero'
import { useQuery } from '../hooks/use-query'
import { Button, Input } from './ui'
import { Toast } from './toast'
import { useToast } from '../hooks/use-toast'

function MessageGroup({ messages, mine, sender }) {
  return (
    <div className={mine ? 'text-right' : ''}>
      {!mine && <div className='text-xs text-accent mb-0.5'>{sender}</div>}
      <div className={`flex flex-col gap-0.5 ${mine ? 'items-end' : 'items-start'}`}>
        {messages.map((m) => (
          <div
            key={m.id}
            className={`px-3 py-1.5 rounded-lg text-sm ${mine ? 'bg-primary text-primary-foreground' : 'bg-card text-card-foreground'}`}
          >
            {m.text}
          </div>
        ))}
      </div>
    </div>
  )
}

function ChatInput({ onSend }) {
  const [text, setText] = useState('')

  const submit = () => {
    if (!text.trim()) return
    onSend(text)
    setText('')
  }

  return (
    <div className='p-3 bg-card border-t border-border flex gap-2'>
      <Input
        className='flex-1'
        placeholder='Message...'
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      <Button onClick={submit}>Send</Button>
    </div>
  )
}

function groupMessages(messages, myId) {
  const groups = []
  for (const m of messages) {
    const last = groups[groups.length - 1]
    if (last && last.memberId === m.memberId) {
      last.messages.push(m)
    } else {
      groups.push({ memberId: m.memberId, mine: m.memberId === myId, messages: [m] })
    }
  }
  return groups
}

export function Room({ onClose }) {
  const me = useCero()
  const room = useRoom()
  const { data: messages } = useQuery(room.messages)
  const { data: members } = useQuery(room.members)
  const toast = useToast()
  const [invite, setInvite] = useState('')
  const ref = useRef(null)

  useEffect(() => {
    ref.current?.scrollTo(0, ref.current.scrollHeight)
  }, [messages])

  const sorted = [...messages].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  const groups = groupMessages(sorted, me.id)
  const send = (text) => cero.put(room.messages, { text })

  return (
    <div className='h-screen flex flex-col'>
      <div className='px-3 py-2 bg-card border-b border-border flex items-center gap-3 text-xs'>
        <Button onClick={onClose} variant='ghost'>
          ←
        </Button>
        <span className='text-muted'>{members.length} members</span>
        <div className='flex-1' />
        {invite ? (
          <div className='flex items-center gap-2'>
            <span className='font-mono text-muted max-w-48 truncate'>{invite}</span>
            <Button
              onClick={() => {
                navigator.clipboard.writeText(invite)
                toast.show('Copied to clipboard')
              }}
              variant='ghost'
              className='text-accent'
            >
              Copy
            </Button>
          </div>
        ) : (
          <Button onClick={() => room.invite().then(setInvite)}>Invite</Button>
        )}
      </div>

      <div ref={ref} className='flex-1 overflow-y-auto p-3 space-y-2'>
        {groups.map((g, i) => (
          <MessageGroup
            key={i}
            messages={g.messages}
            mine={g.mine}
            sender={members.find((x) => x.id === g.memberId)?.name || g.memberId?.slice(0, 8)}
          />
        ))}
      </div>

      <ChatInput onSend={send} />
      <Toast message={toast.message} />
    </div>
  )
}
