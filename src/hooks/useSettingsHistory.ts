import { useCallback, useEffect, useRef } from "react";

/**
 * 設定の Undo/Redo 履歴を管理するフック。
 *
 * - `current` が一定時間変化しなくなるたびにスナップショット(JSON)を積む
 *   （スライダー連続操作などで履歴が乱れないよう debounce する）。
 * - `undo`/`redo` は `apply` を通して過去/未来の状態を復元する。
 * - `resetKey`（例: 画像 src）が変わったら履歴をリセットする
 *   （画像の変更は Undo 対象外にする）。
 *
 * 履歴適用（undo/redo）による変化は再度積まないよう applyingRef で抑制する。
 */
export function useSettingsHistory<T>(
  current: T,
  apply: (s: T) => void,
  resetKey: unknown,
  debounceMs = 500,
  max = 100
) {
  const currentKey = JSON.stringify(current);
  const ref = useRef<{ stack: string[]; index: number }>({
    stack: [currentKey],
    index: 0,
  });
  const applyingRef = useRef(false);

  // resetKey（画像など）が変わったら履歴をクリア
  const resetKeyStr = JSON.stringify(resetKey);
  const prevReset = useRef(resetKeyStr);
  useEffect(() => {
    if (prevReset.current === resetKeyStr) return;
    prevReset.current = resetKeyStr;
    ref.current = { stack: [currentKey], index: 0 };
    applyingRef.current = false;
  }, [resetKeyStr, currentKey]);

  // 設定が落ち着いたらスナップショットを積む
  useEffect(() => {
    // undo/redo による変化は積まない
    if (applyingRef.current) {
      applyingRef.current = false;
      return;
    }
    const { stack, index } = ref.current;
    if (stack[index] === currentKey) return; // 現在位置と同じなら何もしない
    const t = setTimeout(() => {
      const cur = ref.current;
      if (cur.stack[cur.index] === currentKey) return;
      const next = cur.stack.slice(0, cur.index + 1); // redo 分を切り捨て
      next.push(currentKey);
      const trimmed = next.length > max ? next.slice(next.length - max) : next;
      ref.current = { stack: trimmed, index: trimmed.length - 1 };
    }, debounceMs);
    return () => clearTimeout(t);
  }, [currentKey, debounceMs, max]);

  const undo = useCallback(() => {
    const { stack, index } = ref.current;
    if (index <= 0) return;
    ref.current = { stack, index: index - 1 };
    applyingRef.current = true;
    apply(JSON.parse(stack[index - 1]) as T);
  }, [apply]);

  const redo = useCallback(() => {
    const { stack, index } = ref.current;
    if (index >= stack.length - 1) return;
    ref.current = { stack, index: index + 1 };
    applyingRef.current = true;
    apply(JSON.parse(stack[index + 1]) as T);
  }, [apply]);

  return { undo, redo };
}
