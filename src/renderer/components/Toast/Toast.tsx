import { motion } from 'framer-motion'
import { RiCheckLine, RiCloseLine, RiInformationLine, RiAlertLine } from 'react-icons/ri'
import { Toast as ToastType, useToastStore } from '../../stores/toastStore'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import './Toast.css'

interface ToastProps {
  toast: ToastType
}

const icons = {
  success: RiCheckLine,
  error: RiCloseLine,
  warning: RiAlertLine,
  info: RiInformationLine,
}

export function Toast({ toast }: ToastProps) {
  const removeToast = useToastStore((state) => state.removeToast)
  const reducedMotion = useReducedMotion()
  const Icon = icons[toast.type]

  return (
    <motion.div
      className={`toast toast-${toast.type}`}
      role="alert"
      aria-live="polite"
      aria-atomic="true"
      initial={reducedMotion ? { opacity: 0 } : { opacity: 0, x: 50, scale: 0.9 }}
      animate={reducedMotion ? { opacity: 1 } : { opacity: 1, x: 0, scale: 1 }}
      exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: 50, scale: 0.9 }}
      transition={{ duration: 0.2 }}
      layout
    >
      <div className="toast-icon">
        <Icon size={20} />
      </div>
      <div className="toast-content">
        <div className="toast-title">{toast.title}</div>
        {toast.message && <div className="toast-message">{toast.message}</div>}
      </div>
      {toast.dismissible && (
        <button
          className="toast-close"
          onClick={() => removeToast(toast.id)}
          aria-label="Dismiss"
        >
          <RiCloseLine size={18} />
        </button>
      )}
    </motion.div>
  )
}
