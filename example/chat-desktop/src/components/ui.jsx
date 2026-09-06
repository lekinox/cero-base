export function Button({
  children,
  onClick,
  disabled,
  variant = 'primary',
  className = '',
  ...props
}) {
  const styles = {
    primary: 'bg-primary hover:bg-primary/90 text-primary-foreground disabled:opacity-50',
    secondary: 'bg-secondary hover:bg-secondary/80 text-secondary-foreground disabled:opacity-50',
    ghost: 'text-muted hover:text-foreground',
    danger: 'bg-destructive hover:bg-destructive/90 text-primary-foreground disabled:opacity-50'
  }
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-1.5 rounded text-sm font-medium ${styles[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}

export function Input({ className = '', ...props }) {
  return (
    <input
      className={`px-3 py-2 bg-input border border-border rounded text-sm text-foreground ${className}`}
      {...props}
    />
  )
}

export function Section({ title, children }) {
  return (
    <div className='space-y-2'>
      <div className='text-xs text-muted uppercase'>{title}</div>
      {children}
    </div>
  )
}

export function Card({ children, onClick, className = '' }) {
  const interactive = onClick ? 'cursor-pointer hover:bg-card/80' : ''
  return (
    <div
      onClick={onClick}
      className={`p-3 bg-card border border-border rounded ${interactive} ${className}`}
    >
      {children}
    </div>
  )
}

export function Page({ children, className = '' }) {
  return <div className={`max-w-md mx-auto p-4 space-y-4 ${className}`}>{children}</div>
}

export function Header({ onBack, title, children }) {
  return (
    <div className='flex items-center gap-3'>
      {onBack && (
        <button onClick={onBack} className='text-muted hover:text-foreground'>
          ←
        </button>
      )}
      <h1 className='text-lg font-bold text-foreground'>{title}</h1>
      {children && <div className='flex-1' />}
      {children}
    </div>
  )
}
