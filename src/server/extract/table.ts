// Finds the line-item table in a spreadsheet or a PDF and reads its rows. Header words come from
// config/quotedesk.yaml; a few fallbacks catch headers like "HPV Part #" or "Docs Required".
import type { Config } from '@/lib/config';
import type { PdfLine } from '@/server/ingest/pdf';
import type { Sheet } from '@/server/ingest/xlsx';

export type Field = 'line' | 'part' | 'description' | 'qty' | 'uom' | 'due' | 'certs' | 'export';
const FIELDS: Field[] = ['line', 'part', 'description', 'qty', 'uom', 'due', 'certs', 'export'];

export function headerField(cell: string, cols: Config['extraction']['columns']): Field | null {
  const h = cell.trim().toLowerCase().replace(/\s+/g, ' ').replace(/:$/, '');
  if (!h) return null;
  for (const f of FIELDS) if (cols[f].includes(h)) return f;
  if (/\bexport\b/.test(h)) return 'export';
  if (/\bpart\b|p\/n/.test(h)) return 'part';
  if (/^qty\b|quantity/.test(h)) return 'qty';
  if (/^desc/.test(h)) return 'description';
  if (/cert|\bdocs?\b|documentation/.test(h)) return 'certs';
  if (/\bdate\b|\bneed\b|\bdue\b|deliver/.test(h)) return 'due';
  if (/^u\/?m$|^uom$|^units?$/.test(h)) return 'uom';
  return null;
}

export interface GridRow {
  sheet?: string;
  page?: number;
  row: number;
  cells: string[];
}

export interface TableRow extends GridRow {
  index: number; // 0-based data row inside the table
  values: Record<Field, string>;
  quote: string;
}

function headerMap(cells: string[], cols: Config['extraction']['columns']): Partial<Record<Field, number>> | null {
  const map: Partial<Record<Field, number>> = {};
  cells.forEach((c, i) => {
    const f = headerField(c, cols);
    if (f && map[f] === undefined) map[f] = i;
  });
  return map.qty !== undefined && (map.part !== undefined || map.description !== undefined) ? map : null;
}

/** The first header row with a quantity column and a part or description column, then its data rows. */
export function readTable(rows: GridRow[], cfg: Config, contiguous: boolean): { header: GridRow; columns: Partial<Record<Field, number>>; rows: TableRow[] } | null {
  const stop = cfg.extraction.stop_rows;
  for (let h = 0; h < rows.length; h++) {
    const columns = headerMap(rows[h].cells, cfg.extraction.columns);
    if (!columns) continue;
    const out: TableRow[] = [];
    for (let i = h + 1; i < rows.length; i++) {
      const r = rows[i];
      if (contiguous && r.row !== rows[i - 1].row + 1 && out.length) break; // a blank row ends the table
      const first = r.cells.find((c) => c.trim() !== '')?.trim().toLowerCase() ?? '';
      if (stop.some((w) => first.startsWith(w))) break;
      const values = Object.fromEntries(FIELDS.map((f) => [f, columns[f] === undefined ? '' : (r.cells[columns[f]!] ?? '').trim()])) as Record<Field, string>;
      if (!values.part && !values.description) break;
      out.push({ ...r, index: out.length, values, quote: r.cells.filter(Boolean).join(' | ') });
    }
    return { header: rows[h], columns, rows: out };
  }
  return null;
}

export function sheetGrid(sheet: Sheet): GridRow[] {
  return sheet.rows.map((r) => ({ sheet: sheet.name, row: r.row, cells: r.cells }));
}

/** Rebuilds a PDF table from x positions: each piece of text goes to the header it sits under. */
export function pdfGrid(lines: PdfLine[], cfg: Config): GridRow[] | null {
  const header = lines.find((l) => headerMap(l.items.map((i) => i.text), cfg.extraction.columns));
  if (!header) return null;
  const xs = header.items.map((i) => i.x);
  return lines
    .filter((l) => l.page === header.page && l.y <= header.y)
    .map((l) => {
      const cells = xs.map(() => '');
      for (const it of l.items) {
        let col = 0;
        xs.forEach((x, i) => {
          if (it.x + 3 >= x) col = i;
        });
        cells[col] = cells[col] ? `${cells[col]} ${it.text}` : it.text;
      }
      return { page: l.page, row: l.line, cells };
    });
}
