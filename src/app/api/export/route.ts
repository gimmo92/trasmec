import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import ExcelJS from "exceljs";
import type { MachineSection, Offer, ProposalLine } from "@/lib/types";
import { COMPOUND_FILLS, SUPPORT_FILLS, compoundFillIndex, isNonSeSensorLine, supportFillIndex } from "@/lib/highlight";
import { classifyComponent } from "@/lib/spareclass";

export const runtime = "nodejs";

const TEMPLATE = path.join(process.cwd(), "templates", "offerta.xlsx");

const SENSOR_YELLOW = "FFFFFF00";

const solid = (argb: string): ExcelJS.Fill => ({
  type: "pattern",
  pattern: "solid",
  fgColor: { argb },
});

type RowSnapshot = {
  height?: number;
  styles: Partial<ExcelJS.Style>[];
};

function snapshotRow(row: ExcelJS.Row): RowSnapshot {
  const styles: Partial<ExcelJS.Style>[] = [];
  for (let c = 1; c <= 29; c++) {
    styles.push(JSON.parse(JSON.stringify(row.getCell(c).style ?? {})));
  }
  return { height: row.height, styles };
}

function applySnapshot(row: ExcelJS.Row, snap: RowSnapshot) {
  if (snap.height) row.height = snap.height;
  for (let c = 1; c <= 29; c++) {
    row.getCell(c).style = JSON.parse(JSON.stringify(snap.styles[c - 1] ?? {}));
  }
}

function machineDescription(m: MachineSection): string {
  return m.machineType || m.description || m.jobNr || "";
}

/** Codice macchina e, se c'è nel COC, la posizione: "BF0509 POS. 14.050". */
function projectLabel(m: MachineSection): string {
  const code = m.jobNr || m.itemCode || "";
  const pos = (m.layoutPosition || "").replace(/^POS\.\s*/i, "").trim();
  if (code && pos) return `${code} POS. ${pos}`;
  return code;
}

function paintBlock(row: ExcelJS.Row, from: number, to: number, argb: string) {
  const fill = solid(argb);
  for (let col = from; col <= to; col++) row.getCell(col).fill = fill;
}

async function buildOfferWorkbook(offer: Offer): Promise<ExcelJS.Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE);
  const foglio = wb.getWorksheet("Foglio1");
  if (foglio) wb.removeWorksheet(foglio.id);
  const ws = wb.getWorksheet("SP OFFER");
  if (!ws) throw new Error("Il template non contiene il foglio SP OFFER");

  // La colonna Project del template è stretta; con la POS del COC serve più spazio.
  ws.getColumn("G").width = 24;

  const setValue = (addr: string, value: string) => {
    ws.getCell(addr).value = value;
  };
  setValue("O3", offer.header.orderDate || "");
  setValue("O4", offer.header.orderNumber || "");
  setValue("H7", offer.header.customer || "");
  setValue("N7", offer.header.orderNumber || "");
  setValue("H8", offer.header.projectName || "");

  const proto = snapshotRow(ws.getRow(13));
  const internal = ws as ExcelJS.Worksheet & { _rows: unknown[] };
  internal._rows.length = 12;

  let r = 13;
  let machineIndex = 0;

  const writeLine = (m: MachineSection, l: ProposalLine, pos: number) => {
    const row = ws.getRow(r);
    applySnapshot(row, proto);

    row.getCell(6).value = pos;
    row.getCell(7).value = projectLabel(m);
    row.getCell(8).value = machineDescription(m);
    row.getCell(9).value = l.code;
    row.getCell(11).value = l.descriptionEN || l.descriptionIT || "";
    const um = !l.um || l.um.toUpperCase() === "NR" ? "PZ" : l.um;
    row.getCell(16).value = um;
    row.getCell(17).value = l.installedQty;
    const sug = row.getCell(19);
    sug.value =
      l.recommendedQty === null || l.recommendedQty === undefined
        ? null
        : l.recommendedQty;
    const unitFmt = `General" ${um.toUpperCase()}"`;
    row.getCell(17).numFmt = unitFmt;
    sug.numFmt = unitFmt;
    row.getCell(22).value = { formula: `(T${r}-(T${r}*U${r}))*S${r}` };

    const info = classifyComponent(l);
    if (info.deliveryDays != null) row.getCell(23).value = info.deliveryDays;
    if (info.priority) row.getCell(24).value = info.priority;
    if (info.kind) row.getCell(25).value = info.kind;

    const hue = compoundFillIndex(l.compoundHue);
    const supportHue = l.highlightGroup === "cuscinetti" ? supportFillIndex(l.compoundHue) : undefined;
    if (isNonSeSensorLine(l)) {
      paintBlock(row, 5, 25, SENSOR_YELLOW);
    } else if (supportHue !== undefined) {
      paintBlock(row, 9, 15, SUPPORT_FILLS[supportHue].argb);
    } else if (hue !== undefined) {
      paintBlock(row, 9, 15, COMPOUND_FILLS[hue].argb);
    }
    r++;
  };

  for (const m of offer.machines ?? []) {
    machineIndex += 1;
    const lines: ProposalLine[] = [...m.spares, ...m.motors, ...m.sensors];
    if (!lines.length) {
      const row = ws.getRow(r);
      applySnapshot(row, proto);
      row.getCell(6).value = machineIndex;
      row.getCell(7).value = projectLabel(m);
      row.getCell(8).value = machineDescription(m);
      row.getCell(11).value = "\u2014 nessun componente \u2014";
      row.getCell(11).font = { ...row.getCell(11).font, italic: true, color: { argb: "FF999999" } };
      row.getCell(17).numFmt = "General";
      row.getCell(19).numFmt = "General";
      r++;
    } else {
      for (const l of lines) writeLine(m, l, machineIndex);
    }
  }

  const lastDataRow = r - 1;
  ws.getCell("V9").value =
    lastDataRow >= 13 ? { formula: `SUM(V13:V${lastDataRow})` } : 0;

  return wb.xlsx.writeBuffer();
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const offer: Offer | undefined = body?.offer;
    if (!offer) {
      return NextResponse.json({ error: "Offerta mancante" }, { status: 400 });
    }

    const buffer = await buildOfferWorkbook(offer);
    const filename = `Offerta_Ricambi_${offer.header.orderNumber || "draft"}.xlsx`;

    return new NextResponse(buffer as ArrayBuffer, {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Errore di export" },
      { status: 500 }
    );
  }
}
