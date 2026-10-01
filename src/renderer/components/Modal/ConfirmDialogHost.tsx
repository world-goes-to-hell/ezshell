import { useRef } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { motion, AnimatePresence } from 'framer-motion'
import { RiErrorWarningLine, RiQuestionLine } from 'react-icons/ri'
import { modalOverlayVariants, modalContentVariants } from '../../lib/animation/variants'
import { useConfirmStore } from '../../stores/confirmStore'
import './ConfirmDialog.css'

/**
 * Shows the question asked with confirmDialog(). Mount once per window.
 * Focus starts on the confirm button, or on cancel for destructive actions so a habitual Enter does not delete.
 */
export function ConfirmDialogHost() {
  const request = useConfirmStore(state => state.request)
  const answer = useConfirmStore(state => state.answer)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  return (
    <Dialog.Root open={request !== null} onOpenChange={(open) => { if (!open) answer(false) }}>
      <AnimatePresence>
        {request && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div className="modal-overlay confirm-dialog-overlay" variants={modalOverlayVariants} initial="hidden" animate="visible" exit="exit" />
            </Dialog.Overlay>
            <Dialog.Content
              asChild
              onOpenAutoFocus={(e) => {
                e.preventDefault()
                ;(request.danger ? cancelRef : confirmRef).current?.focus()
              }}
            >
              <motion.div
                className="modal-content confirm-dialog"
                variants={modalContentVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
              >
                <Dialog.Title className="modal-title">
                  {request.danger
                    ? <RiErrorWarningLine size={20} className="confirm-dialog-icon is-danger" />
                    : <RiQuestionLine size={20} className="confirm-dialog-icon" />}
                  {request.title}
                </Dialog.Title>
                <Dialog.Description className="confirm-dialog-message">{request.message}</Dialog.Description>
                <div className="modal-actions">
                  <button ref={cancelRef} type="button" className="btn-secondary modal-btn" onClick={() => answer(false)}>
                    {request.cancelLabel ?? '취소'}
                  </button>
                  <button
                    ref={confirmRef}
                    type="button"
                    className={`modal-btn ${request.danger ? 'btn-danger' : 'btn-primary'}`}
                    onClick={() => answer(true)}
                  >
                    {request.confirmLabel}
                  </button>
                </div>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}
