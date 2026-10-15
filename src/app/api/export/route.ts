import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import type { MachineSection, Offer, ProposalLine } from "@/lib/types";
import { COMPOUND_FILLS, compoundFillIndex, isNonSeSensorLine } from "@/lib/highlight";

export const runtime = "nodejs";

// Colori presi dal template "1) SP (mod_TM) OFFER XXX"
const CREAM = "FFFFFFD9"; // banda intestazione tabella
const CREAM2 = "FFFFFFAF"; // colonne "storage" (evidenziate)
const INPUT = "FFFFFFCD"; // celle input (DATE / OFF)
const NOTEF = "FFFFFFC9"; // campo NOTE
const TOTAL = "FFFFFF47"; // totale importo
const REFB = "FFE1F4FF"; // totale storage
const STORAGE_DATA = "FFFFFFD9"; // celle dati SUGGESTED QTY
const SENSOR_YELLOW = "FFFFFF00"; // item SL il cui codice non inizia con SE

const solid = (argb: string): ExcelJS.Fill => ({
  type: "pattern",
  pattern: "solid",
  fgColor: { argb },
});

const thin: Partial<ExcelJS.Border> = {
  style: "thin",
  color: { argb: "FFBFBFBF" },
};
const box: Partial<ExcelJS.Borders> = {
  top: thin,
  left: thin,
  right: thin,
  bottom: thin,
};

function machineDescription(m: MachineSection): string {
  return m.machineType || m.description || m.jobNr || "";
}

const LOGOS_DIR = path.join(process.cwd(), "public", "logos");

function addHeaderLogos(wb: ExcelJS.Workbook, ws: ExcelJS.Worksheet) {
  const trasmec = path.join(LOGOS_DIR, "trasmec.png");
  const tuv = path.join(LOGOS_DIR, "tuv-iso9001.png");
  if (fs.existsSync(trasmec)) {
    const id = wb.addImage({ filename: trasmec, extension: "png" });
    // Posizione come nel template: F3 → H6
    ws.addImage(id, {
      tl: { nativeCol: 5, nativeColOff: 304800, nativeRow: 2, nativeRowOff: 66675 } as ExcelJS.Anchor,
      br: { nativeCol: 7, nativeColOff: 1114424, nativeRow: 5, nativeRowOff: 9524 } as ExcelJS.Anchor,
    });
  }
  if (fs.existsSync(tuv)) {
    const id = wb.addImage({ filename: tuv, extension: "png" });
    // Posizione come nel template: H3 → J5
    ws.addImage(id, {
      tl: { nativeCol: 7, nativeColOff: 1343026, nativeRow: 2, nativeRowOff: 76200 } as ExcelJS.Anchor,
      br: { nativeCol: 9, nativeColOff: 123826, nativeRow: 4, nativeRowOff: 142875 } as ExcelJS.Anchor,
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const offer: Offer | undefined = body?.offer;
    if (!offer) {
      return NextResponse.json({ error: "Offerta mancante" }, { status: 400 });
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = "Trasmec";
    wb.created = new Date();
    const ws = wb.addWorksheet("SP OFFER", {
      views: [{ showGridLines: false, state: "frozen", ySplit: 12 }],
    });

    // Larghezze colonne (come da template)
    const widths: Record<string, number> = {
      A: 3, B: 2.7, C: 3, D: 3.5, E: 17, F: 5.8, G: 15, H: 27.7,
      I: 2.7, J: 19.7, K: 11, L: 3.7, M: 13.7, N: 8.7, O: 21.2, P: 5.7,
      Q: 6.7, R: 8.5, S: 8.5, T: 12.8, U: 10.8, V: 14, W: 5, X: 10.2, Y: 7,
    };
    for (const [col, w] of Object.entries(widths)) {
      ws.getColumn(col).width = w;
    }

    addHeaderLogos(wb, ws);

    // ---- Blocco intestazione ----
    const label = (
      addr: string,
      value: string,
      opts: Partial<ExcelJS.Alignment> = { horizontal: "right", vertical: "middle" }
    ) => {
      const c = ws.getCell(addr);
      c.value = value;
      c.font = { size: 9 };
      c.alignment = opts;
    };
    const inputCell = (addr: string, value: string, fillArgb = INPUT) => {
      const c = ws.getCell(addr);
      c.value = value;
      c.fill = solid(fillArgb);
      c.font = { size: 10 };
      c.alignment = { horizontal: "center", vertical: "middle" };
      c.border = box;
    };

    label("N3", "DATE");
    ws.mergeCells("O3:Q3");
    inputCell("O3", offer.header.orderDate || "");

    label("N4", "OFF");
    ws.mergeCells("O4:Q4");
    inputCell("O4", offer.header.orderNumber || "");

    ws.getCell("G7").value = "CUSTUMER:";
    ws.getCell("G7").font = { size: 11 };
    ws.getCell("G7").alignment = { horizontal: "right", vertical: "middle" };
    ws.mergeCells("H7:J7");
    ws.getCell("H7").value = offer.header.customer || "";
    ws.getCell("H7").font = { size: 11, bold: true };
    ws.getCell("H7").alignment = { horizontal: "left", vertical: "middle" };

    ws.getCell("M7").value = "COC";
    ws.getCell("M7").font = { size: 11 };
    ws.getCell("M7").alignment = { horizontal: "right", vertical: "middle" };
    ws.mergeCells("N7:O7");
    ws.getCell("N7").value = offer.header.orderNumber || "";
    ws.getCell("N7").font = { size: 10 };
    ws.getCell("N7").alignment = { horizontal: "center", vertical: "middle" };

    ws.getCell("G8").value = "NOTE:";
    ws.getCell("G8").font = { size: 11 };
    ws.getCell("G8").alignment = { horizontal: "right", vertical: "middle" };
    ws.mergeCells("H8:Y8");
    ws.getCell("H8").value = offer.header.projectName || "";
    ws.getCell("H8").fill = solid(NOTEF);
    ws.getCell("H8").alignment = { horizontal: "left", vertical: "middle" };
    ws.getCell("H8").border = box;

    ws.getRow(9).height = 24.8;
    ws.getCell("O9").value = "TOTAL AMMOUNT\n(ONLY MACHINERIES)";
    ws.getCell("O9").font = { size: 9 };
    ws.getCell("O9").alignment = { horizontal: "right", vertical: "middle", wrapText: true };
    ws.mergeCells("P9:S9");
    ws.getCell("P9").fill = solid(TOTAL);
    ws.getCell("P9").alignment = { horizontal: "center", vertical: "middle" };
    ws.getCell("P9").border = box;

    ws.mergeCells("T9:U9");
    ws.getCell("T9").value = "\u20AC/TOTAL REF.\nQTY FOR STORAGE";
    ws.getCell("T9").font = { size: 9 };
    ws.getCell("T9").alignment = { horizontal: "center", vertical: "middle", wrapText: true };

    // ---- Intestazione tabella (riga 11) ----
    const HR = 11;
    ws.getRow(HR).height = 89.2;
    const hdr = (
      addr: string,
      text: string,
      strong = false,
      bold = true
    ) => {
      const c = ws.getCell(addr);
      c.value = text;
      c.fill = solid(strong ? CREAM2 : CREAM);
      c.font = { size: 9, bold };
      c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      c.border = box;
    };

    // Sfondo crema continuo sull'intera banda intestazione (E..Y)
    for (let col = 5; col <= 25; col++) {
      const c = ws.getRow(HR).getCell(col);
      if (!c.fill || (c.fill as ExcelJS.FillPattern).type !== "pattern") {
        c.fill = solid(CREAM);
        c.border = box;
      }
    }

    hdr("E11", "ALTRO\u2026");
    hdr("G11", "PROJECT");
    hdr("H11", "DESCRIPTION");
    hdr("J11", "COD.");
    ws.mergeCells("L11:N11");
    hdr("L11", "DESCRIPTION");
    hdr("P11", "U.M");
    hdr("Q11", "INSTALLED QTY");
    hdr("R11", "START UP");
    hdr("S11", "SUGGESTED\n*QTY FOR STORAGE", true);
    hdr("T11", "\u20AC/EACH");
    hdr("U11", "%  DISCOUNT");
    hdr("V11", "\u20AC/TOTAL\n(NET/PRICE) REF.\n* QTY FOR STORAGE", true);
    hdr("W11", "DELIVERY (DAYS)");
    hdr("X11", "*** NECESSARY\n** RECOMMENDED\n* USEFUL");
    hdr("Y11", "WEAR PART (W)\nSPARE PART (S)");

    // Riga 12: banda crema di continuità
    ws.getRow(12).height = 6;
    for (let col = 5; col <= 25; col++) {
      const c = ws.getRow(12).getCell(col);
      c.fill = solid(CREAM);
      c.border = { left: thin, right: thin, bottom: thin };
    }

    // ---- Righe dati ----
    let r = 13;
    let machineIndex = 0;

    const writeLine = (
      m: MachineSection,
      l: ProposalLine,
      pos: number
    ) => {
      const row = ws.getRow(r);
      row.height = 18;

      row.getCell(7).value = m.jobNr || ""; // G PROJECT
      row.getCell(8).value = machineDescription(m); // H DESCRIPTION macchina
      row.getCell(8).alignment = { horizontal: "left", vertical: "middle" };
      row.getCell(9).value = l.code; // I COD.
      row.getCell(9).font = { size: 10, bold: true };
      row.getCell(9).alignment = { horizontal: "left", vertical: "middle" };
      row.getCell(11).value = l.descriptionEN || l.descriptionIT || ""; // K DESCRIPTION
      row.getCell(11).alignment = { horizontal: "left", vertical: "middle" };
      row.getCell(6).value = pos; // F POS
      row.getCell(6).alignment = { horizontal: "center", vertical: "middle" };
      const um = !l.um || l.um.toUpperCase() === "NR" ? "PZ" : l.um;
      row.getCell(16).value = um; // P U.M
      row.getCell(16).alignment = { horizontal: "center", vertical: "middle" };
      row.getCell(17).value = l.installedQty; // Q INSTALLED QTY
      row.getCell(17).alignment = { horizontal: "center", vertical: "middle" };
      const sug = row.getCell(19); // S SUGGESTED QTY FOR STORAGE
      sug.value =
        l.recommendedQty === null || l.recommendedQty === undefined
          ? null
          : l.recommendedQty;
      sug.fill = solid(STORAGE_DATA);
      sug.alignment = { horizontal: "center", vertical: "middle" };
      const unitFmt = `General" ${um.toUpperCase()}"`;
      row.getCell(17).numFmt = unitFmt;
      sug.numFmt = unitFmt;
      // V €/TOTAL = (T-(T*U))*S
      row.getCell(22).value = { formula: `=(T${r}-(T${r}*U${r}))*S${r}` };
      row.getCell(22).alignment = { horizontal: "center", vertical: "middle" };

      const hue = compoundFillIndex(l.compoundHue);

      // Bordo sottile su tutta la riga (E..Y); i gruppi composti hanno sfondo tenue
      for (let col = 5; col <= 25; col++) {
        const c = row.getCell(col);
        c.border = box;
        if (!c.font) c.font = { size: 10 };
        if (isNonSeSensorLine(l)) {
          c.fill = solid(SENSOR_YELLOW);
        } else if (hue !== undefined && col !== 19) {
          c.fill = solid(COMPOUND_FILLS[hue].argb);
        }
      }
      r++;
    };

    for (const m of offer.machines) {
      machineIndex += 1;
      const lines: ProposalLine[] = [
        ...m.spares,
        ...m.motors,
        ...m.sensors,
      ];
      if (!lines.length) {
        // riga segnaposto se la macchina non ha componenti
        const row = ws.getRow(r);
        row.getCell(7).value = m.jobNr || "";
        row.getCell(8).value = machineDescription(m);
        row.getCell(6).value = machineIndex;
        row.getCell(11).value = "\u2014 nessun componente \u2014";
        row.getCell(11).font = { size: 10, italic: true, color: { argb: "FF999999" } };
        for (let col = 5; col <= 25; col++) row.getCell(col).border = box;
        r++;
      } else {
        for (const l of lines) writeLine(m, l, machineIndex);
      }
      // Linea rossa di fine commessa
      const last = ws.getRow(r - 1);
      for (let col = 5; col <= 25; col++) {
        const c = last.getCell(col);
        c.border = { ...c.border, bottom: { style: "medium", color: { argb: "FFE00000" } } };
      }
    }

    const lastDataRow = r - 1;
    // Totale storage (V9)
    ws.getCell("V9").value =
      lastDataRow >= 13 ? { formula: `=SUM(V13:V${lastDataRow})` } : 0;
    ws.getCell("V9").fill = solid(REFB);
    ws.getCell("V9").font = { size: 11 };
    ws.getCell("V9").alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    ws.getCell("V9").border = box;

    const buffer = await wb.xlsx.writeBuffer();
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
