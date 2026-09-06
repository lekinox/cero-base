import './global.css'
import './hooks/use-theme'
import { createRoot } from 'react-dom/client'
import { CeroContext } from './context'
import { useChat } from './hooks/use-chat'
import { ErrorBoundary } from './components/error'
import { Router } from './components/router'
import { Setup } from './components/setup'

function App() {
  const { status, me, error, init } = useChat()

  if (status === 'error') {
    return (
      <div className='h-screen bg-background flex items-center justify-center text-error p-8'>
        {error}
      </div>
    )
  }
  if (status === 'setup') {
    return <Setup onCreate={(name) => init({ name })} onRecover={(phrase) => init({ phrase })} />
  }
  if (status !== 'ready') {
    return (
      <div className='h-screen bg-background flex items-center justify-center text-muted'>
        Loading...
      </div>
    )
  }

  return (
    <CeroContext.Provider value={me}>
      <div className='h-screen bg-background text-foreground'>
        <Router />
      </div>
    </CeroContext.Provider>
  )
}

createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
