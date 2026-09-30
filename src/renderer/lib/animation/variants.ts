import { Variants } from 'framer-motion'
import { TIMING, SPRINGS } from './config'

// Basic fade animation
export const fadeVariants: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: TIMING.base } },
  exit: { opacity: 0, transition: { duration: TIMING.fast } },
}

// Slide up with fade (for modals, panels)
export const slideUpVariants: Variants = {
  hidden: { opacity: 0, y: 10 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { ...SPRINGS.gentle }
  },
  exit: {
    opacity: 0,
    y: 10,
    transition: { duration: TIMING.fast }
  },
}

// Scale animation (for buttons, cards)
export const scaleVariants: Variants = {
  hidden: { opacity: 0, scale: 0.95 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: { ...SPRINGS.snappy }
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    transition: { duration: TIMING.fast }
  },
}

// Modal overlay
export const modalOverlayVariants: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: TIMING.base } },
  exit: { opacity: 0, transition: { duration: TIMING.fast } },
}

// Modal content
export const modalContentVariants: Variants = {
  hidden: { opacity: 0, scale: 0.96, y: 10 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { ...SPRINGS.gentle }
  },
  exit: {
    opacity: 0,
    scale: 0.96,
    y: 10,
    transition: { duration: TIMING.fast }
  },
}

// List item stagger
export const listContainerVariants: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.03,
      delayChildren: 0.05,
    },
  },
}

export const listItemVariants: Variants = {
  hidden: { opacity: 0, x: -10 },
  visible: {
    opacity: 1,
    x: 0,
    transition: { duration: TIMING.base }
  },
}

// Tab animation
export const tabVariants: Variants = {
  hidden: { opacity: 0, scale: 0.9 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: { ...SPRINGS.snappy }
  },
  exit: {
    opacity: 0,
    scale: 0.9,
    transition: { duration: TIMING.fast }
  },
}

// Collapse/expand (for folder trees)
export const collapseVariants: Variants = {
  hidden: {
    height: 0,
    opacity: 0,
    transition: { duration: TIMING.base }
  },
  visible: {
    height: 'auto',
    opacity: 1,
    transition: { duration: TIMING.base }
  },
}

// Drawer (for file explorer)
export const drawerVariants: Variants = {
  hidden: { width: 0, opacity: 0 },
  visible: {
    width: 220,
    opacity: 1,
    transition: { ...SPRINGS.snappy }
  },
  exit: {
    width: 0,
    opacity: 0,
    transition: { duration: TIMING.fast }
  },
}

// Welcome screen stagger container
export const welcomeContainerVariants: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
      delayChildren: 0.1,
    },
  },
}

export const welcomeItemVariants: Variants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { ...SPRINGS.gentle }
  },
}

// Float animation for icons
export const floatVariants: Variants = {
  animate: {
    y: [0, -5, 0],
    transition: {
      duration: 2,
      repeat: Infinity,
      ease: 'easeInOut',
    },
  },
}

// Button hover/tap
export const buttonVariants: Variants = {
  initial: { scale: 1 },
  hover: { scale: 1.02 },
  tap: { scale: 0.98 },
}
