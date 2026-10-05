// Reads every sheet of an .xlsx into rows of display strings. Dates become YYYY-MM-DD; formulas use their result.
import ExcelJS from 'exceljs';

export interface SheetRow {
  row: number; // the spreadsheet's own row number, 1-based
  cells: string[];
}
export interface Sheet {
  name: string;
  rows: SheetRow[]; // non-empty rows only; a gap in row numbers means blank rows
}

type Cell = ExcelJS.CellValue;

export function cellText(v: Cell): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((t) => t.text).join('').trim();
    if ('result' in v) return cellText((v as { result?: Cell }).result ?? null);
    if ('text' in v) return String((v as { text: unknown }).text).trim();
    if ('error' in v) return '';
  }
  return String(v).trim();
}

export async function readXlsx(buf: Buffer): Promise<Sheet[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const sheets: Sheet[] = [];
  wb.eachSheet((ws) => {
    const rows: SheetRow[] = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const values = row.values as Cell[];
      const cells: string[] = [];
      for (let c = 1; c < values.length; c++) cells.push(cellText(values[c]));
      while (cells.length && cells[cells.length - 1] === '') cells.pop();
      if (cells.some((x) => x !== '')) rows.push({ row: rowNumber, cells });
    });
    sheets.push({ name: ws.name, rows });
  });
  return sheets;
}
