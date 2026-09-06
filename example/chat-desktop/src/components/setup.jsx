import { useState } from 'react'
import { Button, Input, Page } from './ui'

export function Setup({ onCreate, onRecover }) {
  const [name, setName] = useState('')
  const [phrase, setPhrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const run = (fn) => {
    setBusy(true)
    setError(null)
    Promise.resolve(fn())
      .catch((err) => setError(err.message || String(err)))
      .finally(() => setBusy(false))
  }

  return (
    <Page className='pt-24 max-w-sm'>
      <h1 className='text-xl font-bold text-accent text-center'>Cero Chat</h1>

      {error && (
        <div className='p-2 bg-error/10 border border-error/30 rounded text-xs text-error'>
          {error}
        </div>
      )}

      <Input
        className='w-full'
        placeholder='Your name'
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && name.trim() && run(() => onCreate(name.trim()))}
        autoFocus
      />
      <Button
        onClick={() => run(() => onCreate(name.trim()))}
        disabled={!name.trim() || busy}
        className='w-full'
      >
        {busy ? '…' : 'Continue'}
      </Button>

      <div className='border-t border-border pt-4 space-y-2'>
        <div className='text-sm text-muted'>Or sign in with a seed from another device</div>
        <textarea
          className='w-full px-3 py-2 bg-input border border-border rounded text-sm text-foreground resize-none'
          rows={3}
          placeholder='Enter your 12-word seed phrase'
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
        />
        <Button
          onClick={() => run(() => onRecover(phrase.trim().replace(/\s+/g, ' ')))}
          disabled={!phrase.trim() || busy}
          variant='secondary'
          className='w-full'
        >
          {busy ? '…' : 'Use Existing Seed'}
        </Button>
      </div>
    </Page>
  )
}
