import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // firebase-admin / googleapis は Node専用の重いライブラリ。
  // Next.js 16(Turbopack)のサーバーバンドルに取り込ませず外部化する
  // (取り込むと本番で「Failed to load external module」になる)
  serverExternalPackages: ["firebase-admin", "googleapis"],
};

export default nextConfig;
