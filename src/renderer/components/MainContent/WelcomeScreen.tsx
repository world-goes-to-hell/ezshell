import { motion } from 'framer-motion'
import { RiTerminalBoxFill, RiAddFill, RiComputerLine } from 'react-icons/ri'
import { welcomeContainerVariants, welcomeItemVariants, floatVariants } from '../../lib/animation/variants'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import { SPRINGS } from '../../lib/animation/config'

interface WelcomeScreenProps {
  onNewConnection: () => void
  onLocalTerminal: () => void
}

export function WelcomeScreen({ onNewConnection, onLocalTerminal }: WelcomeScreenProps) {
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
      <motion.p variants={welcomeItemVariants}>빠르고 안전한 SSH 연결을 시작하세요</motion.p>
      <motion.button
        className="btn-primary"
        onClick={onNewConnection}
        variants={welcomeItemVariants}
        whileHover={reducedMotion ? undefined : { scale: 1.02 }}
        whileTap={reducedMotion ? undefined : { scale: 0.98 }}
        transition={SPRINGS.snappy}
      >
        <RiAddFill size={20} />
        <span>새 연결</span>
      </motion.button>
      <motion.button className="welcome-local-terminal" onClick={onLocalTerminal} variants={welcomeItemVariants}>
        <RiComputerLine size={16} />
        <span>로컬 터미널 열기</span>
      </motion.button>
    </motion.div>
  )
}
