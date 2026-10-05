// Reads a text PDF into lines with x positions, so tables can be rebuilt from where each piece of text sits.
// Scanned (image-only) PDFs have no text layer; they come back with no lines and go to a person.
import { getDocumentProxy } from 'unpdf';

export interface PdfItem {
  x: number;
  text: string;
}
export interface PdfLine {
  page: number;
  line: number; // 1-based, top to bottom on the page
  y: number;
  text: string; // items joined left to right
  items: PdfItem[];
}

export async function readPdf(buf: Buffer): Promise<{ pages: number; lines: PdfLine[] }> {
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const lines: PdfLine[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items = (content.items as { str?: string; transform?: number[] }[])
      .filter((it) => typeof it.str === 'string' && it.str.trim() !== '' && Array.isArray(it.transform))
      .map((it) => ({ x: Math.round(it.transform![4] * 10) / 10, y: Math.round(it.transform![5] * 10) / 10, text: it.str!.trim() }))
      .sort((a, b) => b.y - a.y || a.x - b.x);
    const groups: { y: number; items: PdfItem[] }[] = [];
    for (const it of items) {
      const g = groups.find((x) => Math.abs(x.y - it.y) <= 2);
      if (g) g.items.push({ x: it.x, text: it.text });
      else groups.push({ y: it.y, items: [{ x: it.x, text: it.text }] });
    }
    groups.forEach((g, i) => {
      const sorted = g.items.sort((a, b) => a.x - b.x);
      lines.push({ page: p, line: i + 1, y: g.y, text: sorted.map((x) => x.text).join(' '), items: sorted });
    });
  }
  return { pages: pdf.numPages, lines };
}
