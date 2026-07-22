import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;

const clamp = (v: number, min: number, max: number) =>
  Math.max(min, Math.min(max, v));

interface Point {
  x: number;
  y: number;
}

const distance = (a: Point, b: Point) =>
  Math.hypot(a.x - b.x, a.y - b.y);

/**
 * プレビュー領域のズーム/パン操作を扱うフック。
 *
 * - マウスホイール: カーソル位置を中心に拡大縮小
 * - ドラッグ（1本指/マウス）: 拡大時に平行移動
 * - ピンチ（2本指）: 指の中点を中心に拡大縮小＋移動
 * - ボタン用に zoomIn / zoomOut / reset を提供
 *
 * transform は `transformOrigin: center center` の要素に適用する前提。
 * pan はコンテナ中心を原点としたスクリーン座標（px）。
 */
export function usePanZoom(containerRef: RefObject<HTMLElement | null>) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  // 計算用に最新値を ref で保持（イベントハンドラ内で参照）
  const zoomRef = useRef(1);
  const panRef = useRef<Point>({ x: 0, y: 0 });
  const draggingRef = useRef(false);
  const pointersRef = useRef<Map<number, Point>>(new Map());
  const prevPinchRef = useRef<{ dist: number; midX: number; midY: number } | null>(
    null
  );

  const apply = useCallback((z: number, p: Point) => {
    zoomRef.current = z;
    panRef.current = p;
    setZoom(z);
    setPan(p);
  }, []);

  const center = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, [containerRef]);

  /** clientX/Y（コンテナ中心からの相対）を焦点に拡大縮小する */
  const zoomAtPoint = useCallback(
    (nextZoomRaw: number, focalClientX: number, focalClientY: number) => {
      const c = center();
      const fx = focalClientX - c.x;
      const fy = focalClientY - c.y;
      const newZoom = clamp(nextZoomRaw, MIN_ZOOM, MAX_ZOOM);
      const k = newZoom / zoomRef.current;
      let px = fx - (fx - panRef.current.x) * k;
      let py = fy - (fy - panRef.current.y) * k;
      if (newZoom === 1) {
        px = 0;
        py = 0;
      }
      apply(newZoom, { x: px, y: py });
    },
    [apply, center]
  );

  // ホイールは passive:false でないと preventDefault できないため、
  // ネイティブリスナーとして登録する。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0015);
      zoomAtPoint(zoomRef.current * factor, e.clientX, e.clientY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [containerRef, zoomAtPoint]);

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      prevPinchRef.current = {
        dist: distance(a, b),
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
      };
      draggingRef.current = false;
      setDragging(false);
    } else if (pointersRef.current.size === 1) {
      draggingRef.current = true;
      setDragging(true);
    }
  }, []);

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const pointers = pointersRef.current;
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId)!;
      const curr = { x: e.clientX, y: e.clientY };
      pointers.set(e.pointerId, curr);

      const pts = [...pointers.values()];
      if (pts.length >= 2) {
        // ピンチ: 直前フレームからの差分で拡大縮小＋中点移動
        const [a, b] = pts;
        const dist = distance(a, b);
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        const pp = prevPinchRef.current;
        if (pp && pp.dist > 0) {
          const c = center();
          const k = dist / pp.dist;
          const newZoom = clamp(zoomRef.current * k, MIN_ZOOM, MAX_ZOOM);
          const ak = newZoom / zoomRef.current;
          const fx = midX - c.x;
          const fy = midY - c.y;
          let px = fx - (fx - panRef.current.x) * ak + (midX - pp.midX);
          let py = fy - (fy - panRef.current.y) * ak + (midY - pp.midY);
          if (newZoom === 1) {
            px = 0;
            py = 0;
          }
          apply(newZoom, { x: px, y: py });
        }
        prevPinchRef.current = { dist, midX, midY };
      } else if (draggingRef.current && zoomRef.current > 1) {
        // 1本指/マウスドラッグ: 拡大時のみ平行移動
        const dx = curr.x - prev.x;
        const dy = curr.y - prev.y;
        apply(zoomRef.current, {
          x: panRef.current.x + dx,
          y: panRef.current.y + dy,
        });
      }
    },
    [apply, center]
  );

  const endPointer = useCallback((e: ReactPointerEvent) => {
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) prevPinchRef.current = null;
    if (pointersRef.current.size === 0) {
      draggingRef.current = false;
      setDragging(false);
    }
  }, []);

  const zoomBy = useCallback(
    (factor: number) => {
      // 画面中心を焦点に拡大縮小
      const newZoom = clamp(zoomRef.current * factor, MIN_ZOOM, MAX_ZOOM);
      const k = newZoom / zoomRef.current;
      let px = panRef.current.x * k;
      let py = panRef.current.y * k;
      if (newZoom === 1) {
        px = 0;
        py = 0;
      }
      apply(newZoom, { x: px, y: py });
    },
    [apply]
  );

  const zoomIn = useCallback(() => zoomBy(1.25), [zoomBy]);
  const zoomOut = useCallback(() => zoomBy(1 / 1.25), [zoomBy]);
  const reset = useCallback(() => apply(1, { x: 0, y: 0 }), [apply]);

  const isDefault = zoom === 1 && pan.x === 0 && pan.y === 0;
  const transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;

  return {
    zoom,
    pan,
    transform,
    isDefault,
    dragging,
    canZoomIn: zoom < MAX_ZOOM,
    canZoomOut: zoom > MIN_ZOOM,
    zoomIn,
    zoomOut,
    reset,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endPointer,
      onPointerCancel: endPointer,
    },
  };
}
