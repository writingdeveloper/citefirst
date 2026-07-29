import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pg / pdfjs / mammoth 는 Node 전용이다. 서버 번들에 그대로 남겨야 한다.
  serverExternalPackages: ["pg", "pdfjs-dist", "mammoth"],
};

export default nextConfig;
