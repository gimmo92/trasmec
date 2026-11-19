import MsgReader from "@kenjiuno/msgreader";

/** Testo massimo del corpo mail inviato al server: gli allegati non servono all'offerta. */
export const MAX_MAIL_BODY = 200_000;

/**
 * Legge una mail salvata da Outlook (.msg): oggetto e corpo, senza allegati.
 * Gira sia nel browser sia sul server (niente Buffer).
 */
export function leggiMsg(data: ArrayBuffer): { subject: string; body: string } {
  const info = new MsgReader(data).getFileData();
  if (info.error) throw new Error(`File .msg non leggibile: ${info.error}`);
  const subject = (info.subject ?? "").trim();
  let body = info.body ?? "";
  if (!body.trim()) {
    if (info.bodyHtml) body = info.bodyHtml;
    else if (info.html) body = new TextDecoder("utf-8").decode(info.html);
  }
  return { subject, body: body.slice(0, MAX_MAIL_BODY) };
}
