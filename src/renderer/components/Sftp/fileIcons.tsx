import {
  RiFileFill, RiFileTextFill, RiFileCodeFill, RiImageFill, RiVideoFill, RiMusicFill,
  RiFilePdfFill, RiFileZipFill, RiDatabase2Fill, RiTerminalBoxFill,
  RiMarkdownFill, RiHtml5Fill, RiCss3Fill
} from 'react-icons/ri'

const ICON_SIZE = 14

export function getFileIcon(fileName: string) {
  const ext = fileName.split('.').pop()?.toLowerCase() || ''

  // Images
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'bmp', 'webp', 'ico'].includes(ext))
    return <RiImageFill size={ICON_SIZE} className="file-icon icon-image" />
  // Videos
  if (['mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm'].includes(ext))
    return <RiVideoFill size={ICON_SIZE} className="file-icon icon-video" />
  // Audio
  if (['mp3', 'wav', 'ogg', 'flac', 'aac', 'wma', 'm4a'].includes(ext))
    return <RiMusicFill size={ICON_SIZE} className="file-icon icon-audio" />
  // Archives
  if (['zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz', 'tgz'].includes(ext))
    return <RiFileZipFill size={ICON_SIZE} className="file-icon icon-archive" />
  // PDF
  if (ext === 'pdf')
    return <RiFilePdfFill size={ICON_SIZE} className="file-icon icon-pdf" />
  // Markdown
  if (['md', 'mdx'].includes(ext))
    return <RiMarkdownFill size={ICON_SIZE} className="file-icon icon-markdown" />
  // HTML
  if (['html', 'htm', 'xhtml'].includes(ext))
    return <RiHtml5Fill size={ICON_SIZE} className="file-icon icon-html" />
  // CSS
  if (['css', 'scss', 'sass', 'less'].includes(ext))
    return <RiCss3Fill size={ICON_SIZE} className="file-icon icon-css" />
  // Code files
  if (['js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'vue', 'svelte'].includes(ext))
    return <RiFileCodeFill size={ICON_SIZE} className="file-icon icon-code" />
  // Config/data
  if (['json', 'yaml', 'yml', 'toml', 'xml', 'ini', 'env', 'conf', 'cfg'].includes(ext))
    return <RiDatabase2Fill size={ICON_SIZE} className="file-icon icon-config" />
  // Shell/scripts
  if (['sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1'].includes(ext))
    return <RiTerminalBoxFill size={ICON_SIZE} className="file-icon icon-shell" />
  // Text files
  if (['txt', 'log', 'csv', 'tsv', 'rtf'].includes(ext))
    return <RiFileTextFill size={ICON_SIZE} className="file-icon icon-text" />
  // Default
  return <RiFileFill size={ICON_SIZE} className="file-icon" />
}
