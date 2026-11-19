import { motion } from 'framer-motion'
import { RiTerminalBoxFill, RiAddFill } from 'react-icons/ri'
import { welcomeContainerVariants, welcomeItemVariants, floatVariants } from '../../lib/animation/variants'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import { SPRINGS } from '../../lib/animation/config'

interface WelcomeScreenProps {
  showNewConnection: boolean
  onNewConnection: () => void
}

export function WelcomeScreen({ showNewConnection, onNewConnection }: WelcomeScreenProps) {
  const reducedMotion = useReducedMotion()

  return (
    <motion.div
      className="welcome-screen"
      variants={welcomeContainerVariants}
      initial="hidden"
      animate="visible"
    >
      <motion.div
        className="welcome-icon"
        variants={welcomeItemVariants}
      >
        <motion.div
          variants={reducedMotion ? undefined : floatVariants}
          animate={reducedMotion ? undefined : "animate"}
        >
          <RiTerminalBoxFill size={64} />
        </motion.div>
      </motion.div>
      <motion.h1 variants={welcomeItemVariants}>ezShell</motion.h1>
      {showNewConnection && (
        <motion.button
          type="button"
          className="btn-primary"
          onClick={onNewConnection}
          variants={welcomeItemVariants}
          whileHover={reducedMotion ? undefined : { scale: 1.02 }}
          whileTap={reducedMotion ? undefined : { scale: 0.98 }}
          transition={SPRINGS.snappy}
        >
          <RiAddFill size={20} aria-hidden="true" />
          <span>새 연결</span>
        </motion.button>
      )}
    </motion.div>
  )
}
