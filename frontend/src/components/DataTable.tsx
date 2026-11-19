/** Render a semantic, bounded data table without owning feature queries. */
import type { ReactNode } from 'react';
interface Column<T> { label: string; render: (row: T) => ReactNode; numeric?: boolean }
interface Props<T> {
  rows: T[]; columns: Column<T>[]; rowKey: (row: T) => string;
  page: number; pageSize: number; total: number; onPage: (page: number) => void;
}

/** Display caller-provided rows with accessible empty feedback and paging controls. */
export function DataTable<T>({ rows, columns, rowKey, page, pageSize, total, onPage }: Props<T>) {
  return (
    <div className="card">
      <div className="table-scroll">
        <table>
          <thead>
            <tr>{columns.map(column => <th key={column.label} scope="col">{column.label}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={rowKey(row)}>
                {columns.map(column => (
                  <td key={column.label} className={column.numeric ? 'numeric' : ''}>{column.render(row)}</td>
                ))}
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={columns.length}>No records match these filters.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="actions pager">
        <span>Showing {total ? (page - 1) * pageSize + 1 : 0}–{Math.min(page * pageSize, total)} of {total}</span>
        <button className="secondary" disabled={page === 1} onClick={() => onPage(page - 1)}>Previous</button>
        <button className="secondary" disabled={page * pageSize >= total} onClick={() => onPage(page + 1)}>Next</button>
      </div>
    </div>
  );
}
