/** 注文書アップロード前の自動チェック */

export interface OrderRecord {
  manNo: string;
  name: string;
  contractStart: string;
  contractEnd: string;
}

export interface ValidationWarning {
  level: "error" | "warn";
  message: string;
}

/**
 * 注文書登録前のバリデーションチェック
 * @param manNo 対象者のmanNo
 * @param name 対象者の氏名
 * @param startDate 契約開始日 (YYYY-MM-DD)
 * @param endDate 契約終了日 (YYYY-MM-DD)
 * @param existingOrders 既存の注文書レコード一覧
 * @param engineerCustomerCode 稼働一覧上の顧客コード
 * @param inputCustomerCode 入力された顧客コード
 * @param pdfExtractedNames PDF内で検出された名前一覧
 * @param selectedName 選択された対象者の氏名
 */
export function validateOrder(params: {
  manNo: string;
  name: string;
  startDate: string;
  endDate: string;
  existingOrders: OrderRecord[];
  engineerCustomerCode?: string;
  inputCustomerCode?: string;
  pdfExtractedNames?: string[];
  selectedName?: string;
}): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];
  const { manNo, startDate, endDate, existingOrders, engineerCustomerCode, inputCustomerCode, pdfExtractedNames, selectedName } = params;

  const start = new Date(startDate);
  const end = new Date(endDate);

  // 1. 日付の妥当性チェック
  if (start >= end) {
    warnings.push({ level: "error", message: "契約開始日が終了日以降になっています" });
  }

  const diffDays = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
  if (diffDays > 366) {
    warnings.push({ level: "warn", message: `契約期間が${Math.round(diffDays)}日間（約${Math.round(diffDays / 30)}ヶ月）と長期です。正しいか確認してください` });
  }
  if (diffDays > 0 && diffDays < 14) {
    warnings.push({ level: "warn", message: `契約期間が${Math.round(diffDays)}日間と短期です。正しいか確認してください` });
  }

  // 開始日が過去すぎないか
  const now = new Date();
  const daysSinceStart = (now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceStart > 180) {
    warnings.push({ level: "warn", message: "契約開始日が6ヶ月以上前です。正しいか確認してください" });
  }

  // 終了日が過去でないか
  if (end < now) {
    warnings.push({ level: "warn", message: "契約終了日が過去の日付です。正しいか確認してください" });
  }

  // 2. 同一manNoの既存注文書をフィルタ
  const sameManOrders = existingOrders.filter(o => String(o.manNo) === String(manNo));

  // 3. 重複登録チェック
  const isDuplicate = sameManOrders.some(o =>
    o.contractStart === startDate && o.contractEnd === endDate
  );
  if (isDuplicate) {
    warnings.push({ level: "error", message: "同じ契約期間の注文書が既に登録されています" });
  }

  // 4. 期間の重複チェック
  const overlapping = sameManOrders.filter(o => {
    if (o.contractStart === startDate && o.contractEnd === endDate) return false; // 完全一致は上で処理済み
    const oStart = new Date(o.contractStart);
    const oEnd = new Date(o.contractEnd);
    return start <= oEnd && end >= oStart; // 期間が重なる
  });
  if (overlapping.length > 0) {
    const periods = overlapping.map(o => `${o.contractStart}〜${o.contractEnd}`).join("、");
    warnings.push({ level: "warn", message: `既存の注文書（${periods}）と契約期間が重複しています` });
  }

  // 5. 前回注文書との隙間チェック
  if (sameManOrders.length > 0 && !isDuplicate) {
    // 直近の終了日を取得
    const latestEnd = sameManOrders
      .map(o => new Date(o.contractEnd))
      .sort((a, b) => b.getTime() - a.getTime())[0];

    const gapDays = (start.getTime() - latestEnd.getTime()) / (1000 * 60 * 60 * 24);
    if (gapDays > 1 && gapDays <= 90) {
      warnings.push({ level: "warn", message: `前回の注文書終了日から${Math.round(gapDays)}日間の空白期間があります` });
    }
  }

  // 6. 顧客コード不一致チェック
  if (engineerCustomerCode && inputCustomerCode &&
      engineerCustomerCode !== inputCustomerCode) {
    warnings.push({ level: "warn", message: `稼働一覧の顧客コード（${engineerCustomerCode}）と入力された顧客コード（${inputCustomerCode}）が異なります` });
  }

  // 7. PDF内の氏名と選択者の不一致チェック
  if (pdfExtractedNames && pdfExtractedNames.length > 0 && selectedName) {
    const nameFound = pdfExtractedNames.some(n =>
      selectedName.includes(n) || n.includes(selectedName)
    );
    if (!nameFound) {
      warnings.push({ level: "warn", message: `PDFから検出された名前に「${selectedName}」が含まれていません。対象者が正しいか確認してください` });
    }
  }

  return warnings;
}
