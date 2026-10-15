/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // exceljs e xlsx sono pacchetti server-side pesanti: li teniamo esterni al bundle
  serverExternalPackages: ["exceljs", "xlsx", "pdf-parse", "@napi-rs/canvas"],
};

export default nextConfig;
