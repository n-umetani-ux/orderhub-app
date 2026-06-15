import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // googleapis は Node専用の重いライブラリ。サーバーバンドルに取り込ませず外部化する
  // (firebase-admin は fetchベース検証へ移行し依存削除したため、ここから除外済み)
  serverExternalPackages: ["googleapis"],
};

export default nextConfig;
