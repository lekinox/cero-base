import { Component } from 'react'
import { Button } from './ui'

export class ErrorBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    console.error('[CeroChat] Unhandled error:', error)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className='h-screen bg-background flex flex-col items-center justify-center p-8 gap-4'>
        <h1 className='text-xl font-bold text-accent'>CeroChat crashed</h1>
        <p className='text-error text-sm'>{this.state.error.message || String(this.state.error)}</p>
        <pre className='text-xs text-muted max-w-lg overflow-auto'>{this.state.error.stack}</pre>
        <Button
          onClick={() =>
            navigator.clipboard.writeText(this.state.error.stack || this.state.error.message)
          }
          variant='secondary'
        >
          Copy error
        </Button>
      </div>
    )
  }
}
