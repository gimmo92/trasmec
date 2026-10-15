/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // exceljs e xlsx sono pacchetti server-side pesanti: li teniamo esterni al bundle.
  // pdfjs va esterno, altrimenti il worker non parte; il file del worker non è
  // importato in modo statico e Vercel lo esclude dal bundle della funzione.
  serverExternalPackages: ["exceljs", "xlsx", "pdf-parse", "pdfjs-dist", "@napi-rs/canvas"],
  experimental: {
    // Il middleware gira anche sul caricamento file: il default da 10 MB taglia i listini.
    middlewareClientMaxBodySize: "40mb",
  },
  outputFileTracingIncludes: {
    "/api/generate": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
    "/api/generate/route": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
    "/api/documenti": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
    "/api/documenti/route": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
  },
};

export default nextConfig;
