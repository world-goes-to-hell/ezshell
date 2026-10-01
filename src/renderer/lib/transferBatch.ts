import type { OverwriteAction } from '../components/Sftp/OverwriteModal'

export interface OverwriteAnswer {
  action: OverwriteAction
  applyToAll: boolean
}

export interface TransferBatchSteps<T> {
  /** True when the item's target already exists */
  hasConflict: (item: T) => boolean
  /** Ask the user what to do with a conflict; null means the dialog was cancelled */
  ask: (item: T) => Promise<OverwriteAnswer | null>
  /** Queue one item with the decided action (never called for 'skip') */
  run: (item: T, action: OverwriteAction) => Promise<void>
}

export interface TransferBatchResult {
  /** Items handled (including skipped ones) before the batch ended */
  processed: number
  cancelled: boolean
}

/**
 * Walk a multi-file transfer in order, asking only for conflicting items.
 * "Apply to all" remembers the answer for later conflicts only; items without a conflict always go through.
 * Cancelling the dialog stops the batch at that item.
 */
export async function runTransferBatch<T>(items: readonly T[], steps: TransferBatchSteps<T>): Promise<TransferBatchResult> {
  let rememberedAction: OverwriteAction | null = null
  let processed = 0

  for (const item of items) {
    let action: OverwriteAction = 'overwrite'
    if (steps.hasConflict(item)) {
      if (rememberedAction) {
        action = rememberedAction
      } else {
        const answer = await steps.ask(item)
        if (!answer) return { processed, cancelled: true }
        action = answer.action
        if (answer.applyToAll) rememberedAction = answer.action
      }
    }
    if (action !== 'skip') await steps.run(item, action)
    processed++
  }

  return { processed, cancelled: false }
}

export interface TargetPlan {
  fileName: string
  /** Full target path when the file keeps its name */
  plannedTarget: string
  /** Size of the source file, when known */
  sourceSize?: number
  /** Sizes by name of what is already in the target folder (-1 when unknown) */
  existing: ReadonlyMap<string, number>
}

/**
 * Where one file should go for the decided action, or null when it should not be sent.
 * `reserved` holds names this batch will create in the target folder, so a renamed copy
 * never lands on another file of the same batch.
 */
export function resolveTarget(plan: TargetPlan, action: OverwriteAction, reserved: ReadonlySet<string>): string | null {
  if (action === 'skip') return null
  if (action === 'size-diff') {
    const targetSize = plan.existing.get(plan.fileName)
    const sameSize = plan.sourceSize !== undefined && targetSize !== undefined && targetSize >= 0 && plan.sourceSize === targetSize
    return sameSize ? null : plan.plannedTarget
  }
  if (action === 'rename') {
    const taken = new Set([...plan.existing.keys(), ...reserved])
    return siblingPath(plan.plannedTarget, uniqueName(plan.fileName, taken))
  }
  return plan.plannedTarget
}

/** "name (n).ext" that is not in `taken` */
export function uniqueName(fileName: string, taken: ReadonlySet<string>): string {
  const dotIndex = fileName.lastIndexOf('.')
  const baseName = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName
  const extension = dotIndex > 0 ? fileName.slice(dotIndex) : ''

  let counter = 1
  let newName = `${baseName} (${counter})${extension}`
  while (taken.has(newName)) {
    counter++
    newName = `${baseName} (${counter})${extension}`
  }
  return newName
}

/** Same folder as `filePath`, with the last segment replaced by `newName` */
export function siblingPath(filePath: string, newName: string): string {
  const cut = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return `${filePath.slice(0, cut + 1)}${newName}`
}
