import { RiArrowUpSLine, RiArrowDownSLine } from 'react-icons/ri'
import type { FileSort, FileSortKey } from '../../lib/fileSort'

interface Column {
  key: FileSortKey
  label: string
  className: string
  remoteOnly?: boolean
}

// Same order and width classes as the cells in each file row
const COLUMNS: Column[] = [
  { key: 'name', label: '이름', className: 'col-name' },
  { key: 'owner', label: '소유자', className: 'col-owner', remoteOnly: true },
  { key: 'permissions', label: '권한', className: 'col-permissions', remoteOnly: true },
  { key: 'modifyTime', label: '수정일', className: 'col-mtime' },
  { key: 'size', label: '크기', className: 'col-size' }
]

interface FileListHeaderProps {
  type: 'local' | 'remote'
  sort: FileSort
  onSort: (key: FileSortKey) => void
}

/** Column headers for the SFTP file list; clicking one sorts by it, clicking again reverses. */
export function FileListHeader({ type, sort, onSort }: FileListHeaderProps) {
  const columns = COLUMNS.filter(column => type === 'remote' || !column.remoteOnly)
  return (
    // Keys pressed on a header button belong to the button: the list's Enter/Backspace/arrow
    // shortcuts would otherwise cancel the click or navigate to the parent folder
    <div className="file-list-header" role="row" onKeyDown={(e) => e.stopPropagation()}>
      {columns.map(column => {
        const isActive = sort.key === column.key
        const SortIcon = sort.direction === 'asc' ? RiArrowUpSLine : RiArrowDownSLine
        return (
          <button
            key={column.key}
            type="button"
            role="columnheader"
            aria-sort={isActive ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
            className={`file-list-header-cell ${column.className} ${isActive ? 'is-sorted' : ''}`}
            // Keep focus on the list so its keyboard shortcuts keep working after sorting
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onSort(column.key)}
            title={`${column.label} 기준 정렬`}
          >
            <span className="file-list-header-label">{column.label}</span>
            {isActive && <SortIcon size={14} aria-hidden="true" />}
          </button>
        )
      })}
    </div>
  )
}
