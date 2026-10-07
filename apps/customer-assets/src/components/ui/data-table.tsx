/**
 * Reusable dense data table (contracts.md §8 presentation layer) on
 * @tanstack/react-table: sortable headers (aria-sort), compact column filter,
 * pagination, Spanish labels and the shared empty state. No client data or
 * fetch logic lives here — every listing passes columns + rows.
 */

import { useState } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { EmptyState } from './primitives';

function SortingMark({ sorted }: { sorted: false | 'asc' | 'desc' }) {
  if (sorted === false) return <span className="sort-mark" aria-hidden="true">↕</span>;
  return (
    <span className="sort-mark" aria-hidden="true">
      {sorted === 'asc' ? '▲' : '▼'}
    </span>
  );
}

export function DataTable<T>({
  columns,
  data,
  getRowId,
  initialSorting = [],
  pageSize = 10,
  tableTestId,
  rowTestId,
  ariaLabel,
  emptyTitle,
  emptyHint,
  filterPlaceholder = 'Buscar…',
}: {
  columns: ColumnDef<T, unknown>[];
  data: T[];
  getRowId?: (row: T) => string;
  initialSorting?: SortingState;
  pageSize?: number;
  tableTestId?: string;
  rowTestId?: string;
  ariaLabel?: string;
  emptyTitle: string;
  emptyHint?: string;
  filterPlaceholder?: string;
}) {
  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const [globalFilter, setGlobalFilter] = useState('');

  const table = useReactTable({
    columns,
    data,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getRowId,
    globalFilterFn: 'includesString',
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
  });

  const rows = table.getRowModel().rows;
  const pageCount = Math.max(1, table.getPageCount());
  const pageIndex = table.getState().pagination.pageIndex;
  const filteredCount = table.getFilteredRowModel().rows.length;

  if (data.length === 0) {
    return <EmptyState title={emptyTitle} hint={emptyHint} />;
  }

  return (
    <div>
      <div className="table-toolbar">
        <input
          type="search"
          className="field-input table-filter"
          value={globalFilter}
          onChange={(event) => {
            setGlobalFilter(event.target.value);
            table.setPageIndex(0);
          }}
          placeholder={filterPlaceholder}
          aria-label={filterPlaceholder}
        />
        <span className="table-count">
          {filteredCount === 1 ? '1 fila' : `${filteredCount} filas`}
        </span>
      </div>
      <div className="table-scroll">
        <table className="data data-dense" data-testid={tableTestId} aria-label={ariaLabel}>
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const sorted = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      className={canSort ? 'sortable' : undefined}
                      aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
                    >
                      {canSort ? (
                        <button
                          type="button"
                          className="th-sort"
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          <SortingMark sorted={sorted} />
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length}>
                  <EmptyState title="Sin resultados" hint="Ninguna fila coincide con la búsqueda; probá con otro término." />
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} data-testid={rowTestId}>
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {pageCount > 1 && (
        <div className="table-pager">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            Anterior
          </button>
          <span>
            Página {pageIndex + 1} de {pageCount}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            Siguiente
          </button>
        </div>
      )}
    </div>
  );
}
