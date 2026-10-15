/** Codice commessa Trasmec: due lettere che iniziano per B e quattro cifre (BE0806, BF0509…). */
const SOURCE = "(?<![A-Z0-9])B[A-Z]\\d{4}(?!\\d)";

export function jobCodeRegex(flags = "gi"): RegExp {
  return new RegExp(SOURCE, flags);
}

export function jobCode(text: string): string | undefined {
  return text.match(jobCodeRegex("i"))?.[0].toUpperCase();
}

export function jobCodes(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(jobCodeRegex())) {
    const code = match[0].toUpperCase();
    if (!found.includes(code)) found.push(code);
  }
  return found;
}

export function isJobCode(value: string): boolean {
  return /^B[A-Z]\d{4}$/i.test(value.trim());
}

/** Job della distinta con eventuale lettera finale (BE0806C, BF0514). */
export function isJobNr(value: string): boolean {
  return /^B[A-Z]\d{4}[A-Z]?$/i.test(value.trim());
}
