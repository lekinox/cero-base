export function Toast({ message }) {
  if (!message) return null
  return (
    <div className='fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 bg-card border border-border rounded-lg shadow-lg text-sm text-foreground animate-fade-in'>
      {message}
    </div>
  )
}
