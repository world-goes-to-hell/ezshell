interface ChatLinkPreviewMetadata {
  path: string
  name: string
  size: number | null
  modifiedAt: number
  line: number | null
}

export type ChatLinkPreviewData = ChatLinkPreviewMetadata & (
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'image' | 'pdf'; mime: string; data: Uint8Array<ArrayBuffer> }
  | { kind: 'directory'; entries: { name: string; kind: 'directory' | 'file' | 'link' | 'other' }[]; truncated: boolean }
  | { kind: 'unavailable'; reason: 'too-large' | 'unsupported' }
)

export type ChatLinkPreviewResult = { ok: true; preview: ChatLinkPreviewData } | { ok: false; error: string }
