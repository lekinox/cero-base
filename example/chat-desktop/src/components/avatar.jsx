export function Avatar({ name, src, size = 28 }) {
  if (src) {
    return (
      <img
        src={src}
        alt={name || ''}
        className='rounded-full object-cover'
        style={{ width: size, height: size }}
      />
    )
  }
  return (
    <div
      className='rounded-full bg-accent flex items-center justify-center text-accent-foreground font-medium'
      style={{ width: size, height: size, fontSize: size * 0.45 }}
    >
      {(name || '?')[0].toUpperCase()}
    </div>
  )
}
