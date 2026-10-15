/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // exceljs e xlsx sono pacchetti server-side pesanti: li teniamo esterni al bundle.
  // pdfjs va esterno, altrimenti il worker non parte; il file del worker non è
  // importato in modo statico e Vercel lo esclude dal bundle della funzione.
  // libredwg-web carica il proprio .wasm da node_modules: va esterno e incluso a mano.
  serverExternalPackages: [
    "exceljs",
    "xlsx",
    "pdf-parse",
    "pdfjs-dist",
    "@napi-rs/canvas",
    "@mlightcad/libredwg-web",
  ],
  experimental: {
    // Il middleware gira anche sul caricamento file: il default da 10 MB taglia i listini.
    middlewareClientMaxBodySize: "40mb",
  },
  outputFileTracingIncludes: {
    "/api/generate": [
      "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
      "./node_modules/@mlightcad/libredwg-web/wasm/**",
    ],
    "/api/generate/route": [
      "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
      "./node_modules/@mlightcad/libredwg-web/wasm/**",
    ],
    "/api/documenti": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
    "/api/documenti/route": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
  },
};

export default nextConfig;
