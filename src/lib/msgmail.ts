import MsgReader from "@kenjiuno/msgreader";

/** Testo massimo del corpo mail inviato al server: gli allegati non servono all'offerta. */
export const MAX_MAIL_BODY = 200_000;

/** PDF allegati inviati al server: spesso la richiesta del cliente è lì (manuali grandi esclusi). */
const MAX_PDF = 2 * 1024 * 1024;
const MAX_PDF_TOTALE = 3 * 1024 * 1024;

export interface MsgLetto {
  subject: string;
  body: string;
  /** PDF allegati piccoli (richiesta d'offerta, ordine): il server ne legge il testo. */
  pdf: { name: string; data: Uint8Array }[];
  /** Foto allegate (es. targhetta della macchina): il browser le rimpicciolisce prima dell'invio. */
  immagini: { name: string; data: Uint8Array; type: string }[];
}

/** Immagini sotto questa soglia sono loghi e icone della firma, non foto. */
const MIN_FOTO = 60 * 1024;
const MAX_FOTO = 3;

/**
 * Legge una mail salvata da Outlook (.msg): oggetto, corpo e i PDF allegati piccoli.
 * Gira sia nel browser sia sul server (niente Buffer).
 */
export function leggiMsg(data: ArrayBuffer): MsgLetto {
  const reader = new MsgReader(data);
  const info = reader.getFileData();
  if (info.error) throw new Error(`File .msg non leggibile: ${info.error}`);
  const subject = (info.subject ?? "").trim();
  let body = info.body ?? "";
  if (!body.trim()) {
    if (info.bodyHtml) body = info.bodyHtml;
    else if (info.html) body = new TextDecoder("utf-8").decode(info.html);
  }

  const pdf: MsgLetto["pdf"] = [];
  let totale = 0;
  for (const att of info.attachments ?? []) {
    const name = att.fileName || att.fileNameShort || "";
    if (!/\.pdf$/i.test(name)) continue;
    const size = att.contentLength ?? 0;
    if (size > MAX_PDF || totale + size > MAX_PDF_TOTALE) continue;
    try {
      const file = reader.getAttachment(att);
      if (!file.content?.length) continue;
      totale += file.content.length;
      pdf.push({ name, data: file.content });
    } catch {
      // Allegato illeggibile: si va avanti con gli altri.
    }
  }

  const immagini: MsgLetto["immagini"] = [];
  const foto = (info.attachments ?? [])
    .filter((att) => /\.(jpe?g|png)$/i.test(att.fileName || att.fileNameShort || ""))
    .filter((att) => (att.contentLength ?? 0) >= MIN_FOTO)
    .sort((a, b) => (b.contentLength ?? 0) - (a.contentLength ?? 0))
    .slice(0, MAX_FOTO);
  for (const att of foto) {
    const name = att.fileName || att.fileNameShort || "foto.jpg";
    try {
      const file = reader.getAttachment(att);
      if (!file.content?.length) continue;
      immagini.push({ name, data: file.content, type: /\.png$/i.test(name) ? "image/png" : "image/jpeg" });
    } catch {
      // Foto illeggibile: si va avanti.
    }
  }

  return { subject, body: body.slice(0, MAX_MAIL_BODY), pdf, immagini };
}
