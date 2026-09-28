import { useState, useCallback } from 'react'
import './Ripple.css'

export function useRipple(color = 'rgba(255, 255, 255, 0.3)', duration = 600) {
  const [ripples, setRipples] = useState<Array<{ x: number; y: number; id: number }>>([])

  const createRipple = useCallback((e: React.MouseEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const id = Date.now()

    setRipples(prev => [...prev, { x, y, id }])
    setTimeout(() => {
      setRipples(prev => prev.filter(r => r.id !== id))
    }, duration)
  }, [duration])

  const RippleContainer = () => (
    <span className="ripple-container">
      {ripples.map(ripple => (
        <span
          key={ripple.id}
          className="ripple"
          style={{
            left: ripple.x,
            top: ripple.y,
            backgroundColor: color,
            animationDuration: `${duration}ms`
          }}
        />
      ))}
    </span>
  )

  return { createRipple, RippleContainer }
}
