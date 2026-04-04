"use client";

import { useState, useRef, useCallback, useEffect } from "react";

interface PdfEntry {
  id: string;
  file: File;
  objectUrl: string;
  rawText: string;
  extracting: boolean;
  extractedStart: string;
  extractedEnd: string;
  extractedIssue: string;
}

async function extractFromPdf(file: File): Promise<{
  rawText: string;
  extractedStart: string;
  extractedEnd: string;
  extractedIssue: string;
}> {
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
      const pageText = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ");
      text += pageText + "\n";
      console.log(`[PDF:${file.name}] p${i}: ${pageText.length}字`);
    } catch (pageErr) {
      console.warn(`[PDF:${file.name}] p${i} 取得失敗:`, pageErr);
    }
  }
  console.log(`[PDF:${file.name}] 合計:`, text.length, "字");

  // 日付変換
  const jpToISO = (s: string) => {
    const m = s.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : "";
  };
  const slashToISO = (s: string) => {
    const m = s.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : "";
  };
  const anyDateToISO = (s: string) => jpToISO(s) || slashToISO(s);

  const now = new Date();
  let start = "", end = "";

  const jpPairs = [...text.matchAll(/(20\d{2}年\d{1,2}月\d{1,2}日)\s*[～〜~－\-]\s*(20\d{2}年\d{1,2}月\d{1,2}日)/g)];
  const slashPairs = [...text.matchAll(/(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})\s*[～〜~]\s*(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})/g)];
  const jpAdjacent = [...text.matchAll(/(20\d{2}年\d{1,2}月\d{1,2}日)\s{1,10}(20\d{2}年\d{1,2}月\d{1,2}日)/g)];

  const allPairs = [
    ...jpPairs.map((m) => [jpToISO(m[1]), jpToISO(m[2])]),
    ...slashPairs.map((m) => [slashToISO(m[1]), slashToISO(m[2])]),
    ...jpAdjacent
      .map((m) => [jpToISO(m[1]), jpToISO(m[2])])
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
    const startLabels = ["作業期間[（(]?開始[）)]?", "契約期間[（(]?開始[）)]?", "期間[（(]?開始[）)]?", "開始日", "作業開始日", "契約開始日", "FROM", "from"];
    const endLabels = ["作業期間[（(]?終了[）)]?", "契約期間[（(]?終了[）)]?", "期間[（(]?終了[）)]?", "終了日", "作業終了日", "契約終了日", "TO", "to"];
    for (const lbl of startLabels) {
      const m = text.match(new RegExp(lbl + "[：:\\s]*" + DATE_PAT));
      if (m) { start = anyDateToISO(m[1]); break; }
    }
    for (const lbl of endLabels) {
      const m = text.match(new RegExp(lbl + "[：:\\s]*" + DATE_PAT));
      if (m) { end = anyDateToISO(m[1]); break; }
    }
  }

  const issuedJp = text.match(/発行日[：:\s]*(20\d{2}年\d{1,2}月\d{1,2}日)/);
  let issued = issuedJp ? jpToISO(issuedJp[1]) : "";
  if (!issued) {
    const allDates = [...text.matchAll(/((?:\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})|(?:20\d{2}年\d{1,2}月\d{1,2}日))/g)]
      .map((m) => anyDateToISO(m[1])).filter(Boolean);
    const startMs = start ? new Date(start).getTime() : Infinity;
    issued = allDates.find((d) => d !== start && d !== end && new Date(d).getTime() <= startMs)
           ?? allDates.find((d) => d !== start && d !== end)
           ?? "";
  }
  if (issued && start && new Date(issued) > new Date(start)) issued = "";

  console.log(`[PDF:${file.name}] 期間:`, start, "〜", end, "発注日:", issued);

  return { rawText: text, extractedStart: start, extractedEnd: end, extractedIssue: issued };
}

export default function TestPdfPage() {
  const [entries, setEntries] = useState<PdfEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeEntry = entries.find((e) => e.id === activeId) ?? null;

  useEffect(() => {
    return () => { entries.forEach((e) => URL.revokeObjectURL(e.objectUrl)); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    const pdfFiles = Array.from(files).filter((f) => f.type.includes("pdf"));
    if (pdfFiles.length === 0) return;

    const newEntries: PdfEntry[] = pdfFiles.map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      objectUrl: URL.createObjectURL(file),
      rawText: "",
      extracting: true,
      extractedStart: "",
      extractedEnd: "",
      extractedIssue: "",
    }));

    setEntries((prev) => [...prev, ...newEntries]);
    setActiveId(newEntries[0].id);

    for (const entry of newEntries) {
      try {
        const result = await extractFromPdf(entry.file);
        setEntries((prev) =>
          prev.map((e) => (e.id === entry.id ? { ...e, ...result, extracting: false } : e))
        );
      } catch (err) {
        console.error(`[PDF:${entry.file.name}] 抽出失敗:`, err);
        setEntries((prev) =>
          prev.map((e) =>
            e.id === entry.id ? { ...e, extracting: false, rawText: "（テキスト抽出に失敗しました）" } : e
          )
        );
      }
    }
  }, []);

  const removeEntry = useCallback((id: string) => {
    setEntries((prev) => {
      const target = prev.find((e) => e.id === id);
      if (target) URL.revokeObjectURL(target.objectUrl);
      const next = prev.filter((e) => e.id !== id);
      if (activeId === id) setActiveId(next.length > 0 ? next[0].id : null);
      return next;
    });
  }, [activeId]);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
  };

  return (
    <div className="min-h-screen bg-slate-100 p-8">
      <div className="max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold text-slate-900 mb-1">PDF 読み込みテスト</h1>
        <p className="text-sm text-slate-500 mb-6">認証不要 — pdf.js テキスト抽出の動作確認用</p>

        {/* Drop zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition-all mb-6
            ${dragging ? "border-blue-400 bg-blue-50" : "border-slate-300 bg-white hover:border-slate-400"}`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            multiple
            className="hidden"
            onChange={(e) => e.target.files && handleFiles(e.target.files)}
          />
          <div className="text-3xl mb-2 opacity-40">📄</div>
          <p className="text-sm text-slate-700 mb-3">
            {entries.length > 0 ? "さらにPDFを追加（複数可）" : "ここに注文書PDFをドロップ（複数可）"}
          </p>
          <span className="px-5 py-2 rounded-xl bg-slate-800 text-white text-xs font-semibold">
            ファイルを選択
          </span>
        </div>

        {entries.length > 0 && (
          <div className="grid grid-cols-3 gap-6">
            {/* File list */}
            <div className="col-span-1 space-y-1.5">
              <p className="text-xs font-semibold text-slate-500 mb-2">{entries.length} 件のPDF</p>
              {entries.map((entry) => (
                <div
                  key={entry.id}
                  className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border cursor-pointer transition-all group
                    ${activeId === entry.id
                      ? "border-blue-400 bg-blue-50 ring-1 ring-blue-200"
                      : "border-slate-200 bg-white hover:border-slate-300"
                    }`}
                  onClick={() => setActiveId(entry.id)}
                >
                  <span className="text-base flex-shrink-0">
                    {entry.extracting ? (
                      <span className="inline-block w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                    ) : "📄"}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-slate-800 truncate">{entry.file.name}</p>
                    <p className="text-[10px] text-slate-500">
                      {entry.extracting ? "抽出中…" : `${entry.rawText.length}字`}
                    </p>
                  </div>
                  {/* PDFを開く */}
                  <button
                    onClick={(e) => { e.stopPropagation(); window.open(entry.objectUrl, "_blank"); }}
                    title="PDFを開く"
                    className="flex-shrink-0 w-7 h-7 rounded flex items-center justify-center text-slate-400 hover:text-blue-600 hover:bg-blue-100 transition-colors"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                      <path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />
                      <path fillRule="evenodd" d="M.664 10.59a1.651 1.651 0 010-1.186A10.004 10.004 0 0110 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0110 17c-4.257 0-7.893-2.66-9.336-6.41zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clipRule="evenodd" />
                    </svg>
                  </button>
                  {/* 削除 */}
                  <button
                    onClick={(e) => { e.stopPropagation(); removeEntry(entry.id); }}
                    title="削除"
                    className="flex-shrink-0 w-7 h-7 rounded flex items-center justify-center text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors opacity-0 group-hover:opacity-100"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                      <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>

            {/* Detail panel */}
            <div className="col-span-2">
              {activeEntry ? (
                <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-bold text-slate-900 truncate">{activeEntry.file.name}</h2>
                    <button
                      onClick={() => window.open(activeEntry.objectUrl, "_blank")}
                      className="px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-semibold text-blue-600 hover:bg-blue-50 transition-colors flex items-center gap-1.5"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                        <path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />
                        <path fillRule="evenodd" d="M.664 10.59a1.651 1.651 0 010-1.186A10.004 10.004 0 0110 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0110 17c-4.257 0-7.893-2.66-9.336-6.41zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clipRule="evenodd" />
                      </svg>
                      PDFを開く
                    </button>
                  </div>

                  {activeEntry.extracting ? (
                    <div className="flex items-center gap-3 py-8 justify-center">
                      <span className="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                      <span className="text-sm text-slate-600">テキスト抽出中…</span>
                    </div>
                  ) : (
                    <>
                      {/* 抽出結果サマリー */}
                      <div className="grid grid-cols-3 gap-3">
                        <div className={`p-3 rounded-lg border ${activeEntry.extractedStart ? "bg-emerald-50 border-emerald-200" : "bg-slate-50 border-slate-200"}`}>
                          <p className="text-[10px] text-slate-500 mb-1">契約開始日</p>
                          <p className="text-sm font-bold">{activeEntry.extractedStart || "—（未検出）"}</p>
                        </div>
                        <div className={`p-3 rounded-lg border ${activeEntry.extractedEnd ? "bg-emerald-50 border-emerald-200" : "bg-slate-50 border-slate-200"}`}>
                          <p className="text-[10px] text-slate-500 mb-1">契約終了日</p>
                          <p className="text-sm font-bold">{activeEntry.extractedEnd || "—（未検出）"}</p>
                        </div>
                        <div className={`p-3 rounded-lg border ${activeEntry.extractedIssue ? "bg-emerald-50 border-emerald-200" : "bg-slate-50 border-slate-200"}`}>
                          <p className="text-[10px] text-slate-500 mb-1">発注日</p>
                          <p className="text-sm font-bold">{activeEntry.extractedIssue || "—（未検出）"}</p>
                        </div>
                      </div>

                      {/* 抽出テキスト */}
                      <div>
                        <p className="text-xs font-semibold text-slate-600 mb-2">
                          抽出テキスト — {activeEntry.rawText.length}字
                        </p>
                        <pre className="rounded-lg bg-slate-900 p-4 text-[11px] text-slate-300 whitespace-pre-wrap break-all leading-relaxed max-h-96 overflow-auto">
                          {activeEntry.rawText}
                        </pre>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div className="bg-white border border-slate-200 rounded-xl p-12 text-center text-sm text-slate-400">
                  左のリストからPDFを選択してください
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
