import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // firebase-admin / googleapis は Node専用の重いライブラリ。
  // Next.js 16(Turbopack)のサーバーバンドルに取り込ませず外部化する
  // (取り込むと本番で「Failed to load external module」になる)
  serverExternalPackages: ["firebase-admin", "googleapis"],
  // 外部化しただけでは firebase-admin の実体が /api/settings の関数バンドルに
  // トレースされず本番でロード失敗するため、実体を明示的に同梱する
  outputFileTracingIncludes: {
    "/api/settings": ["./node_modules/firebase-admin/**/*"],
  },
};

export default nextConfig;
