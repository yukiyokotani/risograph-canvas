import { useCallback, useEffect, useRef, useState } from "react";
import type {
  StencilColor,
  HalftoneMode,
  ColorMode,
  PaperTexture,
} from "../lib/stencil";

/** 復元対象の設定一式（画像は含めない） */
export interface StencilSettings {
  colors: StencilColor[];
  dotSize: number;
  misregistration: number;
  density: number;
  inkOpacity: number;
  paperColor: string;
  halftoneMode: HalftoneMode;
  colorMode: ColorMode;
  gamutCutoff: number;
  highlightCutoff: number;
  paperTexture: PaperTexture;
  paperTextureAmount: number;
  noise: number;
  transparentBg: boolean;
  invert: boolean;
}

export interface RecentEntry {
  /** 設定内容から導出した識別子（重複判定に使用） */
  id: string;
  settings: StencilSettings;
}

const KEY = "stencil-canvas:recent";
const MAX = 6;
/** 設定が落ち着いてから記録するまでの待ち時間 */
const CAPTURE_DELAY = 2500;

function load(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, MAX) : [];
  } catch {
    return [];
  }
}

function persist(list: RecentEntry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // ローカルストレージが使えない/満杯でも致命的ではないので無視
  }
}

/**
 * 「最近使った設定」を localStorage に控えておくフック。
 *
 * 明示的な保存ではなく、設定が一定時間落ち着くたびに現在の内容を控え、
 * 直近の異なる設定を最大 {@link MAX} 件まで（新しい順に）保持する。
 * ユーザーがローカルストレージを消しても失われるだけなので、
 * 「保存」ではなく「最近使った候補」として扱う想定。
 */
export function useRecentSettings(current: StencilSettings) {
  const [recent, setRecent] = useState<RecentEntry[]>(() => load());

  const remember = useCallback((settings: StencilSettings) => {
    const id = JSON.stringify(settings);
    setRecent((prev) => {
      const next = [
        { id, settings },
        ...prev.filter((e) => e.id !== id),
      ].slice(0, MAX);
      persist(next);
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    setRecent((prev) => {
      const next = prev.filter((e) => e.id !== id);
      persist(next);
      return next;
    });
  }, []);

  // 現在の設定が一定時間変化しなくなったら控える。初期状態（マウント時の設定）は
  // 控えない。currentId から設定を復元することでレンダー中の ref 書き込みを避け、
  // 初期 id との比較にすることで StrictMode の二重実行でも誤記録しない。
  const currentId = JSON.stringify(current);
  const initialId = useRef(currentId);
  useEffect(() => {
    if (currentId === initialId.current) return;
    const settings = JSON.parse(currentId) as StencilSettings;
    const t = setTimeout(() => remember(settings), CAPTURE_DELAY);
    return () => clearTimeout(t);
  }, [currentId, remember]);

  return { recent, remove };
}
