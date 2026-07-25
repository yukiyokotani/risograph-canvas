import { useCallback, useEffect, useState } from "react";
import type { StencilSettings } from "../lib/settings";

export interface VisualHistoryEntry {
  /** 設定内容から導出した識別子（重複判定に使用） */
  id: string;
  settings: StencilSettings;
  /** 縮小スナップショット（dataURL, メモリ内のみ） */
  thumb: string;
  savedAt: number;
}

const MAX = 48;
const CAPTURE_DELAY = 2500;
const THUMB_W = 140;

/**
 * 現在のキャンバスを縮小して dataURL に。網点の規則パターンが一気に縮小すると
 * モアレ（エイリアシング）になるため、半分ずつ段階的に縮小して平均化してから
 * 最終サイズへ落とす。tainted 等で失敗したら null。
 */
function snapshot(canvas: HTMLCanvasElement): string | null {
  try {
    if (!canvas.width || !canvas.height) return null;
    let src: HTMLCanvasElement = canvas;
    let w = canvas.width;
    let h = canvas.height;
    // 目標の2倍より大きい間は半分ずつ縮小（各段で 2x2 平均 → 網点の高周波を除去）
    while (w > THUMB_W * 2) {
      const nw = Math.max(THUMB_W, Math.round(w / 2));
      const nh = Math.max(1, Math.round((h * nw) / w));
      const tmp = document.createElement("canvas");
      tmp.width = nw;
      tmp.height = nh;
      const tctx = tmp.getContext("2d");
      if (!tctx) return null;
      tctx.imageSmoothingEnabled = true;
      tctx.imageSmoothingQuality = "high";
      tctx.drawImage(src, 0, 0, nw, nh);
      src = tmp;
      w = nw;
      h = nh;
    }
    const finalH = Math.max(1, Math.round((h * THUMB_W) / w));
    const off = document.createElement("canvas");
    off.width = THUMB_W;
    off.height = finalH;
    const ctx = off.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, THUMB_W, finalH);
    return off.toDataURL("image/webp", 0.85);
  } catch {
    return null;
  }
}

/**
 * 「見た目つき履歴」。設定が一定時間落ち着くたびに、現在の
 * キャンバスを縮小スナップショットしてメモリに控える（GPU の再描画は不要）。
 * localStorage は使わずセッション内のみ・多め（{@link MAX}）に保持し、スクロールで
 * 結構遡れるようにする。画像を変えたら履歴はリセットする。
 */
export function useVisualHistory(
  current: StencilSettings,
  getCanvas: () => HTMLCanvasElement | null,
  resetKey: string,
) {
  const [history, setHistory] = useState<VisualHistoryEntry[]>([]);
  const currentId = JSON.stringify(current);

  // 画像が変わったら履歴を破棄する。effect で setState すると余計な再レンダーが
  // 1 往復増える（マウント時にも走る）ので、レンダー中に検知して捨てる
  // （React 公式の「レンダー中に state を調整する」パターン）。
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (prevResetKey !== resetKey) {
    setPrevResetKey(resetKey);
    setHistory([]);
  }

  // 初期表示（デフォルト値）を含め、設定が一定時間落ち着くたびにスナップショットを控える。
  useEffect(() => {
    const settings = JSON.parse(currentId) as StencilSettings;
    const t = setTimeout(() => {
      const canvas = getCanvas();
      if (!canvas) return;
      const thumb = snapshot(canvas);
      if (!thumb) return;
      setHistory((prev) => {
        if (prev[0]?.id === currentId) return prev; // 直近と同一なら積まない
        return [
          { id: currentId, settings, thumb, savedAt: Date.now() },
          ...prev.filter((e) => e.id !== currentId),
        ].slice(0, MAX);
      });
    }, CAPTURE_DELAY);
    return () => clearTimeout(t);
  }, [currentId, getCanvas, resetKey]);

  const remove = useCallback((id: string) => {
    setHistory((prev) => prev.filter((e) => e.id !== id));
  }, []);

  return { history, remove };
}
