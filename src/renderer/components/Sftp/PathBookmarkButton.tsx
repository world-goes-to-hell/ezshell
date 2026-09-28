import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { RiStarFill, RiStarLine, RiCloseLine, RiFolder3Fill } from 'react-icons/ri'
import type { usePathBookmarks } from '../../hooks/usePathBookmarks'
import './PathBookmarkButton.css'

interface PathBookmarkButtonProps {
  /** Bookmark state owned by the PathBar, which also lists bookmarks under the path input */
  bookmarks: ReturnType<typeof usePathBookmarks>
  currentPath: string
  onNavigate: (path: string) => void
}

export function PathBookmarkButton({ bookmarks: state, currentPath, onNavigate }: PathBookmarkButtonProps) {
  const { isAvailable, isLoading, bookmarks, isBookmarked, toggle, remove } = state
  const current = isBookmarked(currentPath)

  if (!isAvailable) {
    return (
      <button
        type="button"
        className="path-bookmark-btn"
        disabled
        title={isLoading ? '즐겨찾기 불러오는 중' : '저장된 세션으로 연결했을 때만 즐겨찾기를 사용할 수 있습니다'}
        aria-label="경로 즐겨찾기 (사용 불가)"
      >
        <RiStarLine size={18} />
      </button>
    )
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={`path-bookmark-btn ${current ? 'is-bookmarked' : ''}`}
          title="경로 즐겨찾기"
          aria-label="경로 즐겨찾기"
        >
          {current ? <RiStarFill size={18} /> : <RiStarLine size={18} />}
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content className="path-bookmark-menu" align="start" sideOffset={4} collisionPadding={8}>
          <DropdownMenu.Item className="path-bookmark-item path-bookmark-toggle" onSelect={() => toggle(currentPath)}>
            {current ? <RiStarFill size={16} /> : <RiStarLine size={16} />}
            <span>{current ? '현재 경로 즐겨찾기 해제' : '현재 경로 즐겨찾기 추가'}</span>
          </DropdownMenu.Item>

          <DropdownMenu.Separator className="path-bookmark-separator" />

          {bookmarks.length === 0 ? (
            <div className="path-bookmark-empty">
              등록된 경로가 없습니다. 위 항목으로 현재 경로를 추가하세요.
            </div>
          ) : (
            bookmarks.map(bookmark => (
              <DropdownMenu.Item
                key={bookmark}
                className={`path-bookmark-item ${bookmark === currentPath ? 'is-current' : ''}`}
                onSelect={() => onNavigate(bookmark)}
                title={bookmark}
              >
                <RiFolder3Fill size={16} className="path-bookmark-folder" />
                <span className="path-bookmark-path">{bookmark}</span>
                <button
                  type="button"
                  className="path-bookmark-remove"
                  aria-label={`${bookmark} 즐겨찾기 삭제`}
                  title="삭제"
                  // Remove without navigating or closing the menu
                  onPointerDown={e => e.stopPropagation()}
                  onClick={e => {
                    e.preventDefault()
                    e.stopPropagation()
                    remove(bookmark)
                  }}
                >
                  <RiCloseLine size={16} />
                </button>
              </DropdownMenu.Item>
            ))
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
