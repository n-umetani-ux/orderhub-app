"use client";

import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { Engineer, SheetsEngineer, DEPTS } from "@/types";
import { useAuth } from "@/lib/auth-context";
import { loadCache } from "@/lib/sheets-cache";
import { validateOrder, ValidationWarning, OrderRecord } from "@/lib/order-validator";

interface UploadPageProps {
  prefill: Engineer | null;
  onBack: () => void;
}

type TargetType = "社員番号" | "BP番号" | "multi(チーム)";

/** PDFファイルごとの抽出結果 */
interface PdfEntry {
  id: string;
  file: File;
  objectUrl: string;
  rawText: string;
  extracting: boolean;
  extractedStart: string;
  extractedEnd: string;
  extractedIssue: string;
  nameMatches: SheetsEngineer[];
  autoSelected: SheetsEngineer | null;
}

/** 命名規約: YYMMDD_部署コード_顧客コード顧客略称_社員番号.pdf
 * 例: 260401_1010_C0105SCSK Minoriソリューションズ_170156.pdf
 * multi例: 260401_1010_C0058CPリンクス_multi.pdf (1枚目)
 *          260401_1010_C0058CPリンクス_multi-1.pdf (2枚目以降)
 */
function buildFileName(
  startDate: string,
  dept: string,
  customerCode: string,
  customerName: string,
  targetType: TargetType,
  manNo: number | null,
  multiSeq?: number
): string {
  const d   = startDate ? startDate.replace(/-/g, "").slice(2) : "YYMMDD";
  const customer = customerCode && customerName
    ? `${customerCode}${customerName}`
    : customerCode || customerName || "（顧客未入力）";
  let tid: string;
  if (targetType === "multi(チーム)") {
    tid = multiSeq != null && multiSeq > 0 ? `multi-${multiSeq}` : "multi";
  } else {
    tid = manNo != null ? String(manNo) : "（番号未入力）";
  }
  return `${d}_${dept}_${customer}_${tid}.pdf`;
}

/** PDF からテキストを抽出し、日付・氏名を解析する純粋関数 */
async function extractFromPdf(
  file: File,
  userEmail: string
): Promise<Omit<PdfEntry, "id" | "file" | "objectUrl" | "extracting">> {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({
    data: arrayBuffer,
    cMapUrl: `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/cmaps/`,
    cMapPacked: true,
  }).promise;

  let text = "";
  console.log(`[PDF:${file.name}] 総ページ数:`, pdf.numPages);
  for (let i = 1; i <= pdf.numPages; i++) {
    try {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
      text += pageText + "\n";
      console.log(`[PDF:${file.name}] p${i}: ${pageText.length}字`);
    } catch (pageErr) {
      console.warn(`[PDF:${file.name}] p${i} 取得失敗:`, pageErr);
    }
  }
  console.log(`[PDF:${file.name}] 合計:`, text.length, "字");

  // 日付変換ユーティリティ
  const jpToISO = (s: string) => {
    const m = s.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    return m ? `${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}` : "";
  };
  const slashToISO = (s: string) => {
    const m = s.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    return m ? `${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}` : "";
  };
  const anyDateToISO = (s: string) => jpToISO(s) || slashToISO(s);

  // ── 1. 契約期間（今日に最も近いペアを選ぶ）
  const now = new Date();
  let start = "", end = "";

  const jpPairs = [...text.matchAll(/(20\d{2}年\d{1,2}月\d{1,2}日)\s*[～〜~－\-]\s*(20\d{2}年\d{1,2}月\d{1,2}日)/g)];
  const slashPairs = [...text.matchAll(/(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})\s*[～〜~]\s*(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})/g)];
  const jpAdjacent = [...text.matchAll(/(20\d{2}年\d{1,2}月\d{1,2}日)\s{1,10}(20\d{2}年\d{1,2}月\d{1,2}日)/g)];

  const allPairs = [
    ...jpPairs.map(m => [jpToISO(m[1]), jpToISO(m[2])]),
    ...slashPairs.map(m => [slashToISO(m[1]), slashToISO(m[2])]),
    ...jpAdjacent.map(m => [jpToISO(m[1]), jpToISO(m[2])])
      .filter(([s, e]) => s && e && new Date(s) <= new Date(e)),
  ].filter(([s, e]) => s && e);

  if (allPairs.length > 0) {
    const best = allPairs.reduce((a, b) =>
      Math.abs(new Date(a[0]).getTime() - now.getTime()) <=
      Math.abs(new Date(b[0]).getTime() - now.getTime()) ? a : b
    );
    [start, end] = best;
  } else {
    const DATE_PAT = "(20\\d{2}年\\d{1,2}月\\d{1,2}日|\\d{4}[/\\-]\\d{1,2}[/\\-]\\d{1,2})";
    const startLabels = [
      "作業期間[（(]?開始[）)]?", "契約期間[（(]?開始[）)]?",
      "期間[（(]?開始[）)]?", "開始日", "作業開始日", "契約開始日",
      "FROM", "from",
    ];
    const endLabels = [
      "作業期間[（(]?終了[）)]?", "契約期間[（(]?終了[）)]?",
      "期間[（(]?終了[）)]?", "終了日", "作業終了日", "契約終了日",
      "TO", "to",
    ];
    for (const lbl of startLabels) {
      const m = text.match(new RegExp(lbl + "[：:\\s]*" + DATE_PAT));
      if (m) { start = anyDateToISO(m[1]); break; }
    }
    for (const lbl of endLabels) {
      const m = text.match(new RegExp(lbl + "[：:\\s]*" + DATE_PAT));
      if (m) { end = anyDateToISO(m[1]); break; }
    }
  }

  // ── 2. 発注日
  const issuedJp = text.match(/発行日[：:\s]*(20\d{2}年\d{1,2}月\d{1,2}日)/);
  let issued = issuedJp ? jpToISO(issuedJp[1]) : "";
  if (!issued) {
    const allDates = [...text.matchAll(/((?:\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})|(?:20\d{2}年\d{1,2}月\d{1,2}日))/g)]
      .map(m => anyDateToISO(m[1])).filter(Boolean);
    const startMs = start ? new Date(start).getTime() : Infinity;
    issued = allDates.find(d => d !== start && d !== end && new Date(d).getTime() <= startMs)
           ?? allDates.find(d => d !== start && d !== end)
           ?? "";
  }
  if (issued && start && new Date(issued) > new Date(start)) issued = "";

  console.log(`[PDF:${file.name}] 期間:`, start, "〜", end, "発注日:", issued);

  // ── 3. エンジニア名照合
  const cache = loadCache(userEmail);
  const engineers = (cache?.engineers ?? []) as SheetsEngineer[];
  const norm = (s: string) => s.replace(/[\s\u3000\u00a0]/g, "");
  const normText = norm(text);

  let nameMatches = engineers.filter(e => {
    const n = norm(e.name);
    return n.length >= 2 && normText.includes(n);
  });
  if (nameMatches.length === 0) {
    nameMatches = engineers.filter(e => {
      const n = norm(e.name);
      const surname = n.slice(0, 3);
      return surname.length >= 3 && normText.includes(surname);
    });
  }
  console.log(`[PDF:${file.name}] 氏名照合結果:`, nameMatches.map(e => e.name));

  return {
    rawText: text,
    extractedStart: start,
    extractedEnd: end,
    extractedIssue: issued,
    nameMatches: nameMatches.slice(0, 8),
    autoSelected: nameMatches.length === 1 ? nameMatches[0] : null,
  };
}

export default function UploadPage({ prefill, onBack }: UploadPageProps) {
  const { user, accessToken } = useAuth();

  const cachedCount = useMemo(() => {
    const cache = loadCache(user?.email ?? "");
    return cache?.engineers?.length ?? 0;
  }, [user?.email]);

  // ── 複数PDF管理 ──
  const [pdfEntries, setPdfEntries] = useState<PdfEntry[]>([]);
  const [activeId, setActiveId]     = useState<string | null>(null);

  const activeEntry = pdfEntries.find(e => e.id === activeId) ?? null;

  // ObjectURL のクリーンアップ
  useEffect(() => {
    return () => {
      pdfEntries.forEach(e => URL.revokeObjectURL(e.objectUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── フォーム state（選択中のPDFに連動）──
  const [targetType, setTargetType] = useState<TargetType>("社員番号");
  const [searchVal, setSearchVal]   = useState(prefill ? String(prefill.manNo) : "");
  const [selected, setSelected]     = useState<Engineer | SheetsEngineer | null>(prefill ?? null);
  const [suggestions, setSuggestions] = useState<SheetsEngineer[]>([]);
  const [startDate, setStartDate]   = useState("");
  const [endDate, setEndDate]       = useState("");
  const [issueDate, setIssueDate]   = useState("");
  const [multiMembers, setMultiMembers] = useState<SheetsEngineer[]>([]);
  const [multiSearchVal, setMultiSearchVal] = useState("");
  const [multiSuggestions, setMultiSuggestions] = useState<SheetsEngineer[]>([]);
  const [multiSeq, setMultiSeq] = useState(0);
  const [multiCustomerCode, setMultiCustomerCode] = useState("");
  const [multiCustomerName, setMultiCustomerName] = useState("");
  const [dept, setDept]             = useState<string>(
    prefill ? (DEPTS.find(d => d.loc === prefill.loc)?.code ?? "1010") : "1010"
  );
  const [dragging, setDragging]     = useState(false);
  const [uploading, setUploading]   = useState(false);
  const [uploadResult, setUploadResult] = useState<string | null>(null);
  const [uploadError, setUploadError]   = useState<string | null>(null);
  const [existingOrders, setExistingOrders] = useState<OrderRecord[]>([]);
  const [preCheckWarnings, setPreCheckWarnings] = useState<ValidationWarning[]>([]);
  const [showWarningConfirm, setShowWarningConfirm] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 既存注文書を取得（チェック用）
  useEffect(() => {
    if (!accessToken) return;
    fetch("/api/orders", { headers: { "x-google-access-token": accessToken } })
      .then(r => r.json())
      .then(d => setExistingOrders(d.orders ?? []))
      .catch(() => {});
  }, [accessToken]);

  const selectedEng = selected as Engineer | null;

  /** キャッシュから顧客コード＋顧客名のユニークリストを生成 */
  const customerList = useMemo(() => {
    const cache = loadCache(user?.email ?? "");
    const engineers = (cache?.engineers ?? []) as Record<string, unknown>[];
    const map = new Map<string, string>();
    engineers.forEach(e => {
      // Engineer型(code)とSheetsEngineer型(customerCode)の両方に対応
      const code = (e.customerCode as string) || (e.code as string) || "";
      const name = (e.customer as string) || "";
      if (code && name && !map.has(code)) {
        map.set(code, name);
      }
    });
    return Array.from(map.entries())
      .map(([code, name]) => ({ code, name }))
      .sort((a, b) => a.code.localeCompare(b.code));
  }, [user?.email]);

  const fileName = useMemo(() =>
    buildFileName(
      startDate, dept,
      targetType === "multi(チーム)" ? multiCustomerCode : (selectedEng?.code ?? ""),
      targetType === "multi(チーム)" ? multiCustomerName : (selectedEng?.customer ?? ""),
      targetType,
      selectedEng?.manNo ?? null,
      multiSeq
    ),
    [startDate, dept, selectedEng, targetType, multiSeq, multiCustomerCode, multiCustomerName]
  );

  /** PDF選択時にフォームを自動入力する */
  const applyEntry = useCallback((entry: PdfEntry) => {
    setStartDate(entry.extractedStart);
    setEndDate(entry.extractedEnd);
    setIssueDate(entry.extractedIssue);
    if (entry.autoSelected) {
      const hit = entry.autoSelected;
      setSelected(hit as unknown as Engineer);
      setSearchVal(`${hit.name} (${hit.manNo})`);
      setSuggestions([]);
      const d = DEPTS.find(dep => dep.loc === hit.loc);
      if (d) setDept(d.code);
    } else {
      setSelected(prefill ?? null);
      setSearchVal(prefill ? String(prefill.manNo) : "");
      if (entry.nameMatches.length > 1) {
        setSuggestions(entry.nameMatches);
      } else {
        setSuggestions([]);
      }
    }
  }, [prefill]);

  /** ファイル追加処理（複数対応） */
  const handleFiles = useCallback(async (files: FileList | File[]) => {
    const pdfFiles = Array.from(files).filter(f => f.type.includes("pdf"));
    if (pdfFiles.length === 0) return;

    // エントリを先に作成（extracting: true）
    const newEntries: PdfEntry[] = pdfFiles.map(file => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      objectUrl: URL.createObjectURL(file),
      rawText: "",
      extracting: true,
      extractedStart: "",
      extractedEnd: "",
      extractedIssue: "",
      nameMatches: [],
      autoSelected: null,
    }));

    setPdfEntries(prev => [...prev, ...newEntries]);

    // 最初の新しいファイルをアクティブにする
    if (!activeId || pdfFiles.length === 1) {
      setActiveId(newEntries[0].id);
    }

    // 各PDFを並列で抽出
    for (const entry of newEntries) {
      try {
        const result = await extractFromPdf(entry.file, user?.email ?? "");
        setPdfEntries(prev => prev.map(e =>
          e.id === entry.id
            ? { ...e, ...result, extracting: false }
            : e
        ));
        // アクティブなエントリの抽出が完了したらフォームに反映
        setActiveId(currentActive => {
          if (currentActive === entry.id) {
            // 非同期の中でapplyEntryを呼ぶため、更新後のentryを使う
            const updated = { ...entry, ...result, extracting: false };
            applyEntry(updated);
          }
          return currentActive;
        });
      } catch (err) {
        console.error(`[PDF:${entry.file.name}] 抽出失敗:`, err);
        setPdfEntries(prev => prev.map(e =>
          e.id === entry.id ? { ...e, extracting: false, rawText: "（テキスト抽出に失敗しました）" } : e
        ));
      }
    }
  }, [activeId, user?.email, applyEntry]);

  /** ファイルリストからPDFを選択 */
  const selectEntry = useCallback((id: string) => {
    setActiveId(id);
    const entry = pdfEntries.find(e => e.id === id);
    if (entry && !entry.extracting) {
      applyEntry(entry);
    }
  }, [pdfEntries, applyEntry]);

  /** ファイルリストからPDFを削除 */
  const removeEntry = useCallback((id: string) => {
    setPdfEntries(prev => {
      const target = prev.find(e => e.id === id);
      if (target) URL.revokeObjectURL(target.objectUrl);
      const next = prev.filter(e => e.id !== id);
      if (activeId === id) {
        const newActive = next.length > 0 ? next[0].id : null;
        setActiveId(newActive);
        if (newActive) {
          const entry = next.find(e => e.id === newActive);
          if (entry && !entry.extracting) applyEntry(entry);
        } else {
          // リセット
          setStartDate(""); setEndDate(""); setIssueDate("");
          setSelected(null); setSearchVal(""); setSuggestions([]);
        }
      }
      return next;
    });
  }, [activeId, applyEntry]);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
  };

  // オートコンプリート
  const handleSearch = (val: string) => {
    setSearchVal(val);
    setSelected(null);
    if (val.length < 1) { setSuggestions([]); return; }
    const cache = loadCache(user?.email ?? "");
    const engineers = (cache?.engineers ?? []) as SheetsEngineer[];
    const filtered = engineers.filter(e =>
      String(e.manNo).includes(val) || e.name.includes(val)
    ).slice(0, 8);
    setSuggestions(filtered);
  };

  const selectEngineer = (e: SheetsEngineer) => {
    setSelected(e as unknown as Engineer);
    setSearchVal(`${e.name} (${e.manNo})`);
    setSuggestions([]);
    const matchDept = DEPTS.find(d => d.loc === e.loc);
    if (matchDept) setDept(matchDept.code);
  };

  // multi メンバー検索
  const handleMultiSearch = (val: string) => {
    setMultiSearchVal(val);
    if (val.length < 1) { setMultiSuggestions([]); return; }
    const cache = loadCache(user?.email ?? "");
    const engineers = (cache?.engineers ?? []) as SheetsEngineer[];
    const alreadyAdded = new Set(multiMembers.map(m => m.manNo));
    const filtered = engineers.filter(e =>
      !alreadyAdded.has(e.manNo) && (String(e.manNo).includes(val) || e.name.includes(val))
    ).slice(0, 8);
    setMultiSuggestions(filtered);
  };

  const addMultiMember = (e: SheetsEngineer) => {
    const next = [...multiMembers, e];
    setMultiMembers(next);
    setMultiSearchVal("");
    setMultiSuggestions([]);
    // 部署を最初のメンバーから設定
    if (next.length === 1) {
      const matchDept = DEPTS.find(d => d.loc === e.loc);
      if (matchDept) setDept(matchDept.code);
    }
  };

  const removeMultiMember = (manNo: string) => {
    const next = multiMembers.filter(m => m.manNo !== manNo);
    setMultiMembers(next);
  };

  /** バリデーション実行 → 警告があれば確認ダイアログ表示 */
  const handleSubmit = () => {
    if (!activeEntry?.file) { setUploadError("PDFファイルを選択してください"); return; }
    if (!startDate || !endDate) { setUploadError("契約期間を入力してください"); return; }
    if (targetType === "multi(チーム)" && multiMembers.length === 0) { setUploadError("チームメンバーを1名以上追加してください"); return; }
    if (targetType === "multi(チーム)" && !multiCustomerCode) { setUploadError("顧客コードを選択してください"); return; }
    setUploadError(null);

    const pdfNames = activeEntry.nameMatches?.map(n => n.name) ?? [];
    let warnings: ValidationWarning[];

    if (targetType === "multi(チーム)") {
      warnings = [];
      for (const member of multiMembers) {
        const w = validateOrder({
          manNo: member.manNo, name: member.name, startDate, endDate, existingOrders,
          inputCustomerCode: multiCustomerCode, pdfExtractedNames: pdfNames, selectedName: member.name,
        });
        w.forEach(ww => { ww.message = `[${member.name}] ${ww.message}`; });
        warnings.push(...w);
      }
    } else {
      warnings = validateOrder({
        manNo: String(selectedEng?.manNo ?? ""), name: selectedEng?.name ?? "", startDate, endDate, existingOrders,
        engineerCustomerCode: selectedEng?.code, inputCustomerCode: selectedEng?.code,
        pdfExtractedNames: pdfNames, selectedName: selectedEng?.name,
      });
    }

    setPreCheckWarnings(warnings);

    if (warnings.length > 0) {
      setShowWarningConfirm(true);
      return;
    }

    doUpload();
  };

  const doUpload = async () => {
    if (!activeEntry?.file) return;
    setShowWarningConfirm(false);
    setUploading(true);
    setUploadError(null);
    try {
      const form = new FormData();
      form.append("file", activeEntry.file);
      form.append("fileName", fileName);
      const res = await fetch("/api/drive", {
        method: "POST",
        headers: accessToken ? { "x-google-access-token": accessToken } : {},
        body: form,
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      if (targetType === "multi(チーム)") {
        // multiの場合: 全メンバー分の注文書レコードを記録
        for (const member of multiMembers) {
          await fetch("/api/orders", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(accessToken ? { "x-google-access-token": accessToken } : {}),
            },
            body: JSON.stringify({
              manNo:         member.manNo,
              name:          member.name,
              contractStart: startDate,
              contractEnd:   endDate,
              fileName,
              driveLink:     data.link ?? "",
              dept,
              customerCode:  multiCustomerCode,
              customerName:  multiCustomerName,
              targetType,
              uploadedBy:    user?.email ?? "",
            }),
          });
        }
      } else if (selectedEng) {
        await fetch("/api/orders", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(accessToken ? { "x-google-access-token": accessToken } : {}),
          },
          body: JSON.stringify({
            manNo:         selectedEng.manNo,
            name:          selectedEng.name,
            contractStart: startDate,
            contractEnd:   endDate,
            fileName,
            driveLink:     data.link ?? "",
            dept,
            customerCode:  selectedEng.code,
            customerName:  selectedEng.customer,
            targetType,
            uploadedBy:    user?.email ?? "",
          }),
        });
      }

      setUploadResult(data.link);
    } catch (e: unknown) {
      setUploadError(e instanceof Error ? e.message : "アップロードに失敗しました");
    } finally {
      setUploading(false);
    }
  };

  const extractingCount = pdfEntries.filter(e => e.extracting).length;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-3 mb-7">
        <button
          onClick={onBack}
          className="px-3.5 py-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-600 hover:bg-slate-50 transition-colors"
        >
          ← 戻る
        </button>
        <h1 className="text-xl font-bold tracking-tight" style={{ color: "#0f172a" }}>注文書の登録</h1>
        {pdfEntries.length > 0 && (
          <span className="ml-auto text-xs text-slate-500">
            {pdfEntries.length}件のPDF
            {extractingCount > 0 && <span className="ml-1.5 text-amber-600">（{extractingCount}件 抽出中…）</span>}
          </span>
        )}
      </div>

      {uploadResult ? (
        <div className="max-w-lg mx-auto text-center py-16">
          <div className="text-5xl mb-4">✅</div>
          <h2 className="text-lg font-bold text-slate-900 mb-2">アップロード完了</h2>
          <p className="text-sm text-slate-700 mb-6">ファイル名: <code className="bg-slate-100 px-2 py-0.5 rounded text-xs">{fileName}</code></p>
          <a href={uploadResult} target="_blank" rel="noreferrer" className="px-5 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 transition-colors">
            Drive で確認
          </a>
          <a
            href={`https://drive.google.com/drive/folders/${process.env.NEXT_PUBLIC_DRIVE_FOLDER_ID || "1jIhIKa9b-Kzv3niWIsMRw51GS4IVjPFo"}`}
            target="_blank"
            rel="noreferrer"
            className="ml-3 px-5 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 transition-colors"
          >
            📁 保存フォルダを開く
          </a>
          <button onClick={onBack} className="ml-3 px-5 py-2.5 rounded-lg border border-slate-200 bg-white text-sm text-slate-600 hover:bg-slate-50 transition-colors">
            一覧へ戻る
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-7">
          {/* Left: PDF upload + file list */}
          <div>
            <h2 className="text-sm font-bold text-gray-900 mb-3">1. 対象ファイルの登録</h2>
            <div
              onDragOver={e => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition-all
                ${dragging ? "border-blue-400" : "border-slate-300 hover:border-slate-400"}`}
              style={{ backgroundColor: dragging ? "#eff6ff" : "#ffffff" }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf"
                multiple
                className="hidden"
                onChange={e => e.target.files && e.target.files.length > 0 && handleFiles(e.target.files)}
              />
              <div className="text-3xl mb-2 opacity-40">📄</div>
              <p className="text-sm mb-3" style={{ color: "#1e293b" }}>
                {pdfEntries.length > 0 ? "さらにPDFを追加" : "ここに注文書PDFをドロップ"}
              </p>
              <span className="px-5 py-2 rounded-xl text-xs font-semibold" style={{ backgroundColor: "#2563eb", color: "#ffffff" }}>
                ファイルを選択（複数可）
              </span>
            </div>

            {/* ── ファイルリスト ── */}
            {pdfEntries.length > 0 && (
              <div className="mt-4 space-y-1.5">
                <p className="text-xs font-semibold text-slate-500 mb-2">読み込み済みファイル</p>
                {pdfEntries.map((entry) => (
                  <div
                    key={entry.id}
                    className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border cursor-pointer transition-all group
                      ${activeId === entry.id
                        ? "border-blue-400 bg-blue-50 ring-1 ring-blue-200"
                        : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"
                      }`}
                    onClick={() => selectEntry(entry.id)}
                  >
                    <span className="text-lg flex-shrink-0">
                      {entry.extracting ? (
                        <span className="inline-block w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                      ) : "📄"}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-gray-900 truncate">{entry.file.name}</p>
                      <p className="text-[10px] text-gray-500">
                        {entry.extracting
                          ? "テキスト抽出中…"
                          : `${entry.rawText.length}字抽出`
                            + (entry.extractedStart ? ` | ${entry.extractedStart}〜${entry.extractedEnd}` : "")
                            + (entry.autoSelected ? ` | ${entry.autoSelected.name}` : entry.nameMatches.length > 1 ? ` | ${entry.nameMatches.length}名候補` : "")
                        }
                      </p>
                    </div>
                    {/* PDFを開くボタン */}
                    <button
                      onClick={(e) => { e.stopPropagation(); window.open(entry.objectUrl, "_blank"); }}
                      title="PDFを開く"
                      className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-blue-600 hover:bg-blue-100 transition-colors"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                        <path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />
                        <path fillRule="evenodd" d="M.664 10.59a1.651 1.651 0 010-1.186A10.004 10.004 0 0110 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0110 17c-4.257 0-7.893-2.66-9.336-6.41zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clipRule="evenodd" />
                      </svg>
                    </button>
                    {/* 削除ボタン */}
                    <button
                      onClick={(e) => { e.stopPropagation(); removeEntry(entry.id); }}
                      title="削除"
                      className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors opacity-0 group-hover:opacity-100"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                        <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* 抽出テキスト（選択中のPDF） */}
            {activeEntry && activeEntry.rawText && (
              <details className="mt-3">
                <summary className="text-xs text-slate-600 cursor-pointer select-none">
                  抽出テキスト確認（診断用）— {activeEntry.rawText.length}字 — {activeEntry.file.name}
                </summary>
                <pre className="mt-1 rounded-lg bg-slate-900 p-3 text-[11px] text-slate-300 whitespace-pre-wrap break-all leading-relaxed max-h-64 overflow-auto">
                  {activeEntry.rawText}
                </pre>
              </details>
            )}
          </div>

          {/* Right: Form */}
          <div>
            <h2 className="text-sm font-bold text-gray-900 mb-3">2. 契約詳細・送信</h2>
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              {/* Target type */}
              <div>
                <label className="text-xs font-semibold text-gray-800 mb-2 block">対象区分</label>
                <div className="flex gap-1.5">
                  {(["社員番号", "BP番号", "multi(チーム)"] as TargetType[]).map(t => (
                    <button
                      key={t}
                      onClick={() => {
                        setTargetType(t);
                        setSelected(null);
                        setSearchVal("");
                        setMultiCustomerCode("");
                        setMultiCustomerName("");
                        // multi切替時にPDFから検出された候補を自動追加
                        if (t === "multi(チーム)" && activeEntry && activeEntry.nameMatches.length > 0) {
                          const members = activeEntry.nameMatches;
                          setMultiMembers(members);
                          setMultiSeq(0);
                          // 最初のメンバーから部署設定
                          const matchDept = DEPTS.find(d => d.loc === members[0].loc);
                          if (matchDept) setDept(matchDept.code);
                        } else {
                          setMultiMembers([]);
                          setMultiSeq(0);
                        }
                      }}
                      className={`px-4 py-1.5 rounded-lg border text-xs font-semibold transition-all
                        ${targetType === t ? "border-blue-400 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              {/* Target search */}
              {targetType !== "multi(チーム)" && (
                <div className="relative">
                  <label className="text-xs font-semibold text-gray-800 mb-2 block">
                    対象者（manNo. または氏名で検索）
                    {cachedCount > 0
                      ? <span className="ml-2 font-normal text-emerald-600">{cachedCount}件利用可能</span>
                      : <span className="ml-2 font-normal text-amber-600">キャッシュなし — ダッシュボードで同期してください</span>
                    }
                  </label>
                  <input
                    value={searchVal}
                    onChange={e => handleSearch(e.target.value)}
                    onFocus={() => { if (searchVal.length > 0) handleSearch(searchVal); }}
                    onBlur={() => setTimeout(() => setSuggestions([]), 150)}
                    placeholder="例: 170156 または 井上"
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm"
                    style={{ color: "#111827", backgroundColor: "#ffffff" }}
                  />
                  {suggestions.length > 0 && (
                    <div className="absolute top-full left-0 right-0 border border-slate-200 rounded-lg shadow-xl z-50 max-h-48 overflow-auto mt-1" style={{ backgroundColor: "#ffffff" }}>
                      {suggestions.map(s => (
                        <div
                          key={s.manNo}
                          onMouseDown={() => selectEngineer(s)}
                          className="px-4 py-2 text-sm cursor-pointer hover:bg-blue-50 flex justify-between border-b border-slate-100"
                          style={{ color: "#111827" }}
                        >
                          <span style={{ color: "#111827", fontWeight: 600 }}><b>{s.manNo}</b> {s.name}</span>
                          <span style={{ color: "#4b5563", fontSize: "12px" }}>{s.customer} / {s.loc}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Auto-filled customer */}
              {selectedEng && (
                <div className="grid grid-cols-2 gap-2.5 p-3 rounded-lg bg-emerald-50 border border-emerald-200">
                  <div>
                    <p className="text-[10px] text-emerald-700">顧客コード</p>
                    <p className="text-sm font-bold text-emerald-900">{selectedEng.code}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-emerald-700">顧客名</p>
                    <p className="text-sm font-bold text-emerald-900">{selectedEng.customer}</p>
                  </div>
                </div>
              )}

              {/* Contract period */}
              <div>
                <label className="text-xs font-semibold text-gray-800 mb-2 block">注文書に記載の契約期間</label>
                <div className="flex items-center gap-2">
                  <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="flex-1 px-2.5 py-2 rounded-lg border border-slate-300 text-sm" style={{ color: "#111827", backgroundColor: "#fff" }} />
                  <span className="text-slate-600">〜</span>
                  <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="flex-1 px-2.5 py-2 rounded-lg border border-slate-300 text-sm" style={{ color: "#111827", backgroundColor: "#fff" }} />
                </div>
              </div>

              {/* Issue date + dept */}
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="text-xs font-semibold text-gray-800 mb-2 block">発注日（参考）</label>
                  <input type="date" value={issueDate} onChange={e => setIssueDate(e.target.value)} className="w-full px-2.5 py-2 rounded-lg border border-slate-300 text-sm" style={{ color: "#111827", backgroundColor: "#fff" }} />
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-800 mb-2 block">部署</label>
                  <select value={dept} onChange={e => setDept(e.target.value)} className="w-full px-2.5 py-2 rounded-lg border border-slate-300 text-sm" style={{ color: "#111827", backgroundColor: "#fff" }}>
                    {DEPTS.map(d => <option key={d.code} value={d.code}>{d.code}: {d.name}</option>)}
                  </select>
                </div>
              </div>

              {/* multi: メンバー選択 */}
              {targetType === "multi(チーム)" && (
                <div>
                  <label className="text-xs font-semibold text-gray-800 mb-2 block">
                    チームメンバー（注文書の対象者を追加）
                    {cachedCount > 0
                      ? <span className="ml-2 font-normal text-emerald-600">{cachedCount}件利用可能</span>
                      : <span className="ml-2 font-normal text-amber-600">キャッシュなし</span>
                    }
                  </label>
                  {/* 追加済みメンバー一覧 */}
                  {multiMembers.length > 0 && (
                    <div className="mb-2 space-y-1">
                      {multiMembers.map(m => (
                        <div key={m.manNo} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-blue-50 border border-blue-200 text-xs">
                          <span className="font-mono text-slate-700">{m.manNo}</span>
                          <span className="font-semibold text-slate-900">{m.name}</span>
                          <span className="text-slate-500">{m.customer}</span>
                          <button
                            onClick={() => removeMultiMember(m.manNo)}
                            className="ml-auto text-slate-400 hover:text-red-500 transition-colors"
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                      <p className="text-[10px] text-slate-500">{multiMembers.length}名選択</p>
                    </div>
                  )}
                  {/* メンバー検索 */}
                  <div className="relative">
                    <input
                      value={multiSearchVal}
                      onChange={e => handleMultiSearch(e.target.value)}
                      onFocus={() => { if (multiSearchVal.length > 0) handleMultiSearch(multiSearchVal); }}
                      onBlur={() => setTimeout(() => setMultiSuggestions([]), 150)}
                      placeholder="manNo. または氏名でメンバーを追加"
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm"
                      style={{ color: "#111827", backgroundColor: "#fff" }}
                    />
                    {multiSuggestions.length > 0 && (
                      <div className="absolute top-full left-0 right-0 bg-white border border-slate-200 rounded-lg shadow-xl z-50 max-h-48 overflow-auto mt-1">
                        {multiSuggestions.map(s => (
                          <div
                            key={s.manNo}
                            onMouseDown={() => addMultiMember(s)}
                            className="px-4 py-2 text-sm cursor-pointer hover:bg-blue-50 flex justify-between border-b border-slate-100"
                            style={{ color: "#111827" }}
                          >
                            <span style={{ color: "#111827", fontWeight: 600 }}><b>{s.manNo}</b> {s.name}</span>
                            <span style={{ color: "#4b5563", fontSize: "12px" }}>{s.customer} / {s.loc}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {/* 顧客コード選択（multi専用） */}
                  <div className="mt-3 p-3 rounded-lg bg-amber-50 border border-amber-200">
                    <label className="text-xs font-semibold text-amber-800 mb-2 block">
                      📋 顧客コード（multi注文書の顧客を選択）
                    </label>
                    <select
                      value={multiCustomerCode}
                      onChange={e => {
                        const code = e.target.value;
                        setMultiCustomerCode(code);
                        const found = customerList.find(c => c.code === code);
                        setMultiCustomerName(found?.name ?? "");
                      }}
                      className="w-full px-3 py-2 rounded-lg border border-amber-300 text-sm"
                      style={{ color: "#111827", backgroundColor: "#fff" }}
                    >
                      <option value="">-- 顧客を選択してください --</option>
                      {customerList.map(c => (
                        <option key={c.code} value={c.code}>{c.code} {c.name}</option>
                      ))}
                    </select>
                    {multiCustomerCode && (
                      <p className="mt-1.5 text-xs text-amber-700">
                        選択中: <b>{multiCustomerCode}</b> {multiCustomerName}
                      </p>
                    )}
                  </div>
                  {/* 連番（multi専用） */}
                  <div className="mt-3">
                    <label className="text-xs font-semibold text-gray-800 mb-2 block">
                      連番（同一顧客の2枚目以降に設定）
                    </label>
                    <div className="flex items-center gap-2">
                      <select
                        value={multiSeq}
                        onChange={e => setMultiSeq(Number(e.target.value))}
                        className="px-3 py-2 rounded-lg border border-slate-300 text-sm"
                        style={{ color: "#111827", backgroundColor: "#fff" }}
                      >
                        <option value={0}>なし（1枚目: _multi.pdf）</option>
                        {[1,2,3,4,5,6,7,8,9,10].map(n => (
                          <option key={n} value={n}>multi-{n}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {/* File name preview */}
              <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                <p className="text-[10px] text-gray-600 mb-1">生成ファイル名プレビュー</p>
                <p className="text-xs font-bold text-gray-900 font-mono break-all">{fileName}</p>
              </div>

              {uploadError && (
                <div className="px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs">{uploadError}</div>
              )}

              <button
                onClick={handleSubmit}
                disabled={uploading || !activeEntry}
                className="w-full py-3.5 rounded-xl bg-gradient-to-r from-slate-800 to-slate-700 text-white font-bold text-sm tracking-wide hover:from-slate-700 hover:to-slate-600 transition-all disabled:opacity-50"
              >
                {uploading ? "アップロード中…" : "✓ 内容を確定し、期間ステータスを更新する"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* チェック結果の確認ダイアログ */}
      {showWarningConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowWarningConfirm(false)}>
          <div className="bg-white rounded-xl shadow-2xl p-6 w-full max-w-lg mx-4" onClick={ev => ev.stopPropagation()}>
            <h2 className="text-lg font-bold mb-3" style={{ color: "#111827" }}>登録前チェック結果</h2>

            <div className="space-y-2 mb-5 max-h-64 overflow-y-auto">
              {preCheckWarnings.map((w, i) => (
                <div
                  key={i}
                  className="flex items-start gap-2 px-3 py-2 rounded-lg text-sm"
                  style={{
                    backgroundColor: w.level === "error" ? "#fef2f2" : "#fffbeb",
                    border: `1px solid ${w.level === "error" ? "#fecaca" : "#fde68a"}`,
                    color: w.level === "error" ? "#991b1b" : "#92400e",
                  }}
                >
                  <span className="shrink-0 mt-0.5">{w.level === "error" ? "🚫" : "⚠️"}</span>
                  <span>{w.message}</span>
                </div>
              ))}
            </div>

            {preCheckWarnings.some(w => w.level === "error") ? (
              <div>
                <p className="text-sm mb-3" style={{ color: "#dc2626" }}>
                  エラーがあるため登録できません。内容を修正してください。
                </p>
                <button
                  onClick={() => setShowWarningConfirm(false)}
                  className="px-5 py-2.5 rounded-lg border border-slate-300 text-sm font-semibold hover:bg-slate-50 transition-colors"
                  style={{ color: "#374151" }}
                >
                  戻って修正する
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <button
                  onClick={doUpload}
                  className="px-5 py-2.5 rounded-lg bg-amber-500 text-white text-sm font-semibold hover:bg-amber-600 transition-colors"
                >
                  確認済み — このまま登録する
                </button>
                <button
                  onClick={() => setShowWarningConfirm(false)}
                  className="px-5 py-2.5 rounded-lg border border-slate-300 text-sm font-semibold hover:bg-slate-50 transition-colors"
                  style={{ color: "#374151" }}
                >
                  戻って修正する
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
