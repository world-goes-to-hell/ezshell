import './Spinner.css'

interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const sizeMap = {
  sm: 16,
  md: 24,
  lg: 32,
}

export function Spinner({ size = 'md', className = '' }: SpinnerProps) {
  const pixelSize = sizeMap[size]

  return (
    <div
      className={`spinner spinner-${size} ${className}`}
      style={{
        width: pixelSize,
        height: pixelSize
      }}
      role="status"
      aria-label="Loading"
    >
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        {/* Square track: a short segment travels along the edge (perimeter 80) */}
        <rect
          className="spinner-track"
          x="2"
          y="2"
          width="20"
          height="20"
          strokeWidth="3"
        />
        <rect
          className="spinner-indicator"
          x="2"
          y="2"
          width="20"
          height="20"
          strokeWidth="3"
          strokeLinecap="square"
        />
      </svg>
    </div>
  )
}
