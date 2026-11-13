import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { RiCheckLine, RiFilter3Line, RiFlashlightLine, RiArrowRightSLine } from 'react-icons/ri'
import { isDatabaseShown, isSchemaShown, shownCount, withAllDatabases, withDatabase, withSchema, type TreeFilter } from '../../lib/dbTreeFilter'
import type { DbDatabase, DbSchema } from '../../types/db'
import type { ConnectableEngine } from '../../lib/dbChoices'

type Loaded<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; items: T }

interface TreeFilterMenuProps {
  engine: ConnectableEngine
  databases: DbDatabase[]
  /** Schemas the tree already read, by database */
  schemas: Record<string, Loaded<DbSchema[]>>
  filter: TreeFilter
  onFilterChange: (filter: TreeFilter) => void
  onLoadSchemas: (database: string) => void
}

/**
 * The "10/12" next to a database in the tree: a button that opens that database's schema checkboxes
 * (the same choices as in the filter menu), like DataGrip.
 */
export function SchemaCountMenu({ database, loaded, filter, onFilterChange, onOpen }: {
  database: string
  loaded: Loaded<DbSchema[]> | undefined
  filter: TreeFilter
  onFilterChange: (filter: TreeFilter) => void
  onOpen: () => void
}) {
  return (
    <DropdownMenu.Root onOpenChange={(isOpen) => { if (isOpen) onOpen() }}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="db-tree-count-button" title="보일 스키마 고르기" aria-label={`${database} 의 보일 스키마 고르기`}>
          {loaded?.status === 'ready' ? shownCount(filter, database, loaded.items) : '…'}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="db-menu db-filter-menu" align="start" sideOffset={4} collisionPadding={8}>
          <DropdownMenu.Label className="db-menu-label">{database} · 보일 스키마</DropdownMenu.Label>
          {loaded?.status !== 'ready' && <div className="db-menu-empty">{loaded?.status === 'error' ? loaded.message : '읽는 중…'}</div>}
          {loaded?.status === 'ready' && loaded.items.map(schema => (
            <Check key={schema.name} checked={isSchemaShown(filter, database, schema)} isSystem={schema.isSystem}
              onChange={(next) => onFilterChange(withSchema(filter, database, schema.name, next))}>
              {schema.name}
            </Check>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/** A menu item that toggles without closing the menu */
function Check({ checked, onChange, children, isSystem }: { checked: boolean; onChange: (next: boolean) => void; children: React.ReactNode; isSystem?: boolean }) {
  return (
    <DropdownMenu.CheckboxItem className="db-menu-item db-filter-item" checked={checked}
      onSelect={(event) => event.preventDefault()} onCheckedChange={(next) => onChange(next === true)}>
      <span className={`db-filter-box${checked ? ' is-checked' : ''}`} aria-hidden="true">{checked && <RiCheckLine size={11} />}</span>
      <span className="db-filter-label">{children}</span>
      {isSystem && <RiFlashlightLine size={12} className="db-filter-system" aria-label="시스템" />}
    </DropdownMenu.CheckboxItem>
  )
}

/**
 * Which databases (and, for PostgreSQL, which schemas of each) the tree shows. System ones start
 * hidden and carry ⚡. Choices are kept per account on this PC.
 */
export function TreeFilterMenu({ engine, databases, schemas, filter, onFilterChange, onLoadSchemas }: TreeFilterMenuProps) {
  const isAllShown = databases.length > 0 && databases.every(d => isDatabaseShown(filter, d))
  const shownDatabases = databases.filter(d => isDatabaseShown(filter, d))

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="db-icon-button" title="보일 DB·스키마 고르기" aria-label="보일 DB·스키마 고르기">
          <RiFilter3Line size={14} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="db-menu db-filter-menu" align="start" sideOffset={4} collisionPadding={8}>
          <DropdownMenu.Label className="db-menu-label">보일 데이터베이스</DropdownMenu.Label>
          <Check checked={isAllShown} onChange={(next) => onFilterChange(withAllDatabases(filter, databases, next))}>
            <strong>전체 데이터베이스</strong>
          </Check>
          {databases.map(database => (
            <Check key={database.name} checked={isDatabaseShown(filter, database)} isSystem={database.isSystem}
              onChange={(next) => onFilterChange(withDatabase(filter, database.name, next))}>
              {database.name}
            </Check>
          ))}
          {engine !== 'mysql' && shownDatabases.length > 0 && (
            <>
              <DropdownMenu.Separator className="db-menu-separator" />
              <DropdownMenu.Label className="db-menu-label">보일 스키마</DropdownMenu.Label>
              {shownDatabases.map(database => {
                const loaded = schemas[database.name]
                return (
                  <DropdownMenu.Sub key={database.name} onOpenChange={(isOpen) => { if (isOpen) onLoadSchemas(database.name) }}>
                    <DropdownMenu.SubTrigger className="db-menu-item db-filter-item">
                      <span className="db-filter-label">{database.name}</span>
                      {loaded?.status === 'ready' && <span className="db-tree-count">{shownCount(filter, database.name, loaded.items)}</span>}
                      <RiArrowRightSLine size={14} className="db-filter-more" aria-hidden="true" />
                    </DropdownMenu.SubTrigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.SubContent className="db-menu db-filter-menu" sideOffset={4} collisionPadding={8}>
                        {loaded?.status !== 'ready' && (
                          <div className="db-menu-empty">{loaded?.status === 'error' ? loaded.message : '읽는 중…'}</div>
                        )}
                        {loaded?.status === 'ready' && loaded.items.map(schema => (
                          <Check key={schema.name} checked={isSchemaShown(filter, database.name, schema)} isSystem={schema.isSystem}
                            onChange={(next) => onFilterChange(withSchema(filter, database.name, schema.name, next))}>
                            {schema.name}
                          </Check>
                        ))}
                      </DropdownMenu.SubContent>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Sub>
                )
              })}
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
