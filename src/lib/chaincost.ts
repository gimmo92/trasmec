import * as XLSX from "xlsx";

/** Riga del foglio calcolo costo catene: disegno distinta → codice che inizia con TK. */
export interface ChainCostRow {
  drawing: string;
  tkCode: string;
}

/** CT2013 è una catena TKK. 012.25.04.12.02.13 è il disegno di una catena TK. */
export function chainAssemblyKind(code: string): "tk" | "tkk" | null {
  const value = code.trim();
  if (/^CT\d+/i.test(value)) return "tkk";
  if (/^\d{3}(?:\.\d{2}){4,6}(?:\.[A-Za-z])?$/.test(value)) return "tk";
  return null;
}

export function drawingKey(value: string): string {
  return value.replace(/\D/g, "");
}

export function readChainCostRows(filePath: string): ChainCostRow[] {
  const listed = XLSX.readFile(filePath, { bookSheets: true });
  const sheet =
    listed.SheetNames.find((name) => /calcolo\s*costo\s*caten/i.test(name)) ??
    listed.SheetNames[0];
  if (!sheet) return [];
  const wb = XLSX.readFile(filePath, { sheets: [sheet], cellDates: false });
  const ws = wb.Sheets[sheet];
  if (!ws) return [];
  const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(ws, {
    header: 1,
    raw: false,
    defval: "",
  });

  let header = -1;
  let colDrawing = -1;
  let colCode = -1;
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const cells = (rows[r] ?? []).map((cell) => String(cell ?? "").toLowerCase());
    const drawing = cells.findIndex((cell) => /disegno/.test(cell));
    const code = cells.findIndex((cell) => /sage|codice articolo/.test(cell));
    if (drawing >= 0 && code >= 0) {
      header = r;
      colDrawing = drawing;
      colCode = code;
      break;
    }
  }
  if (header < 0) return [];

  const out: ChainCostRow[] = [];
  for (let r = header + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const drawing = String(row[colDrawing] ?? "").trim();
    const tkCode = String(row[colCode] ?? "").trim();
    if (!drawing || drawing === "-") continue;
    if (!/^TK/i.test(tkCode)) continue;
    out.push({ drawing, tkCode });
  }
  return out;
}

/** Codice TK della riga con lo stesso numero disegno del chain assembly code. */
export function tkCodeForDrawing(rows: ChainCostRow[], drawing: string): string | null {
  const key = drawingKey(drawing);
  if (key.length < 8) return null;
  const hit = rows.find((row) => drawingKey(row.drawing) === key);
  return hit?.tkCode ?? null;
}
