import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import {
  loadImage,
  getImageData,
  type StencilOptions,
  type ImageDataLike,
} from "../lib/stencil";
import { renderStencilPixels } from "../lib/stencilRenderer";
import {
  analyzeSource,
  generateCandidates,
  mutate,
  scoreRender,
  candidateSignature,
  paletteKey,
  DISCOVER_FIXED,
  THUMB_RENDER_WIDTH,
  PREVIEW_BASE_WIDTH,
  SCREEN_RENDER_WIDTH,
  MIN_DISTINCTION,
  MIN_VARIATION,
  MAX_PER_PALETTE,
  type Candidate,
  type SourceStats,
} from "../lib/discover";

const PAGE = 48; // 1 回の補充で生成する候補数（この中から重複と潰れを落として採用する）
const MAX_ITEMS = 240; // 実質的なバリエーションは有限なので、この辺りで打ち切る
const OVERSCAN_ROWS = 2;
const CACHE_CAP = 200; // 描画済みサムネの LRU 上限（表示範囲外は解放）
const SIMILAR_COUNT = 12;

/** 描画済みタイル（params + 描画ピクセル）。ピクセルは LRU キャッシュ / strip のみが保持する。 */
type Rendered = Candidate & { pixels: Uint8ClampedArray; w: number; h: number };

export interface DiscoverDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  imageSrc: string;
  onApply: (cand: Candidate) => void;
}

/** 表示幅から列数（広いほど列を増やしてタイルを程よい大きさに保つ）。 */
function colsForWidth(w: number): number {
  return w < 420 ? 3 : w < 620 ? 4 : w < 840 ? 5 : 6;
}

/** Candidate → サムネ描画 options（クリーン固定値＋renderScale でプレビューの見た目に合わせる）。 */
function buildOptions(cand: Candidate, srcWidth: number): StencilOptions {
  return {
    colors: cand.colors,
    dotSize: cand.dotSize,
    misregistration: cand.misregistration,
    grain: 0,
    density: cand.density,
    inkOpacity: cand.inkOpacity,
    paperColor: cand.paperColor,
    halftoneMode: cand.halftoneMode,
    separation: DISCOVER_FIXED.separation,
    blackGeneration: DISCOVER_FIXED.blackGeneration,
    highlightCutoff: cand.highlightCutoff,
    paperTexture: cand.paperTexture,
    paperTextureAmount: DISCOVER_FIXED.paperTextureAmount,
    noise: DISCOVER_FIXED.noise,
    transparentBg: false,
    invert: cand.invert,
    renderScale: srcWidth / PREVIEW_BASE_WIDTH,
  };
}

async function renderCand(src: ImageDataLike, cand: Candidate): Promise<Rendered | null> {
  try {
    const pixels = await renderStencilPixels(src, buildOptions(cand, src.width));
    return { ...cand, pixels, w: src.width, h: src.height };
  } catch {
    return null;
  }
}

/** 描画済みピクセルを canvas に描く（object-cover で正方タイルを埋める）。 */
function Thumb({ pixels, w, h }: { pixels: Uint8ClampedArray; w: number; h: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    cv.width = w;
    cv.height = h;
    cv.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(pixels), w, h), 0, 0);
  }, [pixels, w, h]);
  return <canvas ref={ref} className="h-full w-full object-cover" />;
}

/** 色丸を左下に縦並び（常時）。ホバー時はサムネにスクリムを重ね、各丸の右に白文字で色名。 */
function SwatchLabel({ colors }: { colors: Candidate["colors"] }) {
  return (
    <>
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
      <div className="pointer-events-none absolute bottom-1.5 left-1.5 flex flex-col gap-1">
        {colors.map((c, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span
              className="h-3 w-3 shrink-0 rounded-full ring-1 ring-white/80 shadow-sm"
              style={{ background: c.color }}
            />
            <span className="whitespace-nowrap text-[10px] font-medium leading-tight text-white opacity-0 transition-opacity duration-150 group-hover:opacity-100">
              {c.name}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

/** 選択枠＋チェック（グリッドと strip で共通、角丸なしで統一）。 */
function SelectionMark() {
  return (
    <>
      <span className="pointer-events-none absolute inset-0 ring-2 ring-inset ring-primary" />
      <span className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow">
        <Check className="h-3.5 w-3.5" strokeWidth={3} />
      </span>
    </>
  );
}

export function DiscoverDialog({ open, onOpenChange, imageSrc, onApply }: DiscoverDialogProps) {
  const sourceRef = useRef<ImageDataLike | null>(null);
  // 足切り用の小さいソース（下見レンダの採点に使う）
  const screenSrcRef = useRef<ImageDataLike | null>(null);
  const statsRef = useRef<SourceStats | null>(null);
  const pageRef = useRef(0);
  // 補充の重複排除: 見た目が実質同じ署名と、パレットごとの採用数
  const seenSigRef = useRef<Set<string>>(new Set());
  const paletteCountRef = useRef<Map<string, number>>(new Map());
  // 補充中の世代（-1 = 実行なし）。世代ごとに二重起動を防ぐ。
  const producingRef = useRef(-1);
  const candCountRef = useRef(0);
  // 補充の世代。ダイアログを開き直す/画像が変わると進めて、実行中の補充を捨てる。
  const runRef = useRef(0);
  const cacheRef = useRef<Map<string, Rendered>>(new Map());
  const visRunRef = useRef(0);
  const simRunRef = useRef(0);
  const simSeedRef = useRef(1000);
  const renderChain = useRef<Promise<unknown>>(Promise.resolve());
  const scrollElRef = useRef<HTMLDivElement | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const scrollRaf = useRef(0);

  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [, setTick] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [similar, setSimilar] = useState<Rendered[]>([]);
  const [similarSelectedId, setSimilarSelectedId] = useState<string | null>(null);
  const [similarLoading, setSimilarLoading] = useState(false);

  const candMap = useMemo(() => {
    const m = new Map<string, Candidate>();
    for (const c of candidates) m.set(c.id, c);
    return m;
  }, [candidates]);

  // --- LRU キャッシュ操作 ---
  const cacheTouch = (id: string) => {
    const m = cacheRef.current;
    const v = m.get(id);
    if (v) {
      m.delete(id);
      m.set(id, v);
    }
  };
  const cacheSet = (id: string, v: Rendered) => {
    const m = cacheRef.current;
    m.set(id, v);
    while (m.size > CACHE_CAP) {
      const k = m.keys().next().value as string | undefined;
      if (k === undefined || k === id) break;
      m.delete(k);
    }
  };

  /** すべての描画を1本のキューへ直列化（GPU の共有 densityCache 競合を避ける）。stale はスキップ。 */
  const queueRender = useCallback((cand: Candidate, shouldRun: () => boolean): Promise<Rendered | null> => {
    const run = renderChain.current.then(() => {
      const src = sourceRef.current;
      return src && shouldRun() ? renderCand(src, cand) : null;
    });
    renderChain.current = run.then(
      () => {},
      () => {},
    );
    return run;
  }, []);

  /**
   * 候補を補充する。生成しただけでは
   *   1. 同じ配色・同じ点設定の「実質同じ」候補が何度も出てくる
   *   2. ディテールが潰れて何が写っているか分からない候補が混じる
   * ので、(1) 署名とパレット上限で間引き、(2) 小さく下見レンダして採点し、
   * 基準を満たしたものだけをグリッドへ積む。
   */
  const produce = useCallback(async (want: number) => {
    const stats = statsRef.current;
    const screenSrc = screenSrcRef.current;
    if (!stats || !screenSrc) return;
    const myRun = runRef.current;
    // 同じ世代の二重起動だけを弾く。古い世代がまだ後片付け中でも、新しい世代の
    // 補充は始められるようにする（ここで返してしまうと開き直したとき空のままになる）。
    if (producingRef.current === myRun) return;
    producingRef.current = myRun;
    try {
      let added = 0;
      // 生成→間引き→採点を、必要数が埋まるまで数回まわす（無限ループ防止に上限つき）
      for (let round = 0; round < 8 && added < want; round++) {
        if (myRun !== runRef.current) return;
        if (candCountRef.current + added >= MAX_ITEMS) return;
        const fresh: Candidate[] = [];
        for (const cand of generateCandidates(stats, ++pageRef.current, PAGE)) {
          const sig = candidateSignature(cand);
          if (seenSigRef.current.has(sig)) continue; // 実質同じものは出さない
          const pal = paletteKey(cand);
          const used = paletteCountRef.current.get(pal) ?? 0;
          if (used >= MAX_PER_PALETTE) continue; // 同じ配色で埋め尽くさない
          seenSigRef.current.add(sig);
          paletteCountRef.current.set(pal, used + 1);
          fresh.push(cand);
        }
        const keep: Candidate[] = [];
        for (const cand of fresh) {
          if (myRun !== runRef.current) return;
          if (candCountRef.current + keep.length >= MAX_ITEMS) break;
          let pixels: Uint8ClampedArray;
          try {
            pixels = await renderStencilPixels(screenSrc, buildOptions(cand, screenSrc.width));
          } catch {
            continue;
          }
          if (myRun !== runRef.current) return;
          const s = scoreRender(screenSrc.data, pixels, screenSrc.width, screenSrc.height);
          if (s.distinction < MIN_DISTINCTION || s.variation < MIN_VARIATION) continue;
          keep.push(cand);
        }
        if (keep.length) {
          added += keep.length;
          candCountRef.current += keep.length;
          setCandidates((prev) => [...prev, ...keep]);
        }
      }
    } finally {
      if (producingRef.current === myRun) producingRef.current = -1;
    }
  }, []);

  // --- レイアウト計算（仮想化） ---
  const cols = viewport.w ? colsForWidth(viewport.w) : 3;
  const tile = viewport.w ? viewport.w / cols : 0;
  const stripTile = Math.round(tile) || 128; // similar strip はグリッドのタイルと同サイズに揃える
  const rowCount = Math.ceil(candidates.length / cols);
  const totalH = rowCount * tile;
  const startRow = tile ? Math.max(0, Math.floor(scrollTop / tile) - OVERSCAN_ROWS) : 0;
  const endRow = tile
    ? Math.min(rowCount, Math.ceil((scrollTop + viewport.h) / tile) + OVERSCAN_ROWS)
    : 0;

  const visible = useMemo(() => {
    if (!tile) return [] as { cand: Candidate; row: number; col: number }[];
    const out: { cand: Candidate; row: number; col: number }[] = [];
    for (let row = startRow; row < endRow; row++) {
      for (let col = 0; col < cols; col++) {
        const idx = row * cols + col;
        if (idx >= candidates.length) break;
        out.push({ cand: candidates[idx], row, col });
      }
    }
    return out;
     
  }, [candidates, startRow, endRow, cols, tile]);
  const visibleKey = visible.map((v) => v.cand.id).join(",");

  // 表示範囲のサムネを（未描画のものだけ）順に描画。表示が変わると前パスをキャンセル。
  useEffect(() => {
    const src = sourceRef.current;
    if (!src || visible.length === 0) return;
    const ids = visible.map((v) => v.cand.id);
    for (const id of ids) cacheTouch(id); // 表示中は LRU で守る
    const myRun = ++visRunRef.current;
    (async () => {
      for (const id of ids) {
        if (myRun !== visRunRef.current) return;
        if (cacheRef.current.has(id)) continue;
        const cand = candMap.get(id);
        if (!cand) continue;
        const r = await queueRender(
          cand,
          () => myRun === visRunRef.current && !cacheRef.current.has(id),
        );
        if (myRun !== visRunRef.current) return;
        if (r) {
          cacheSet(id, r);
          setTick((t) => (t + 1) & 0xffff);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey]);

  // 末尾が近づいたら補充する（重複排除と足切りは produce の中）。
  // ダイアログは常にマウントされているので、open を見ないと「閉じた直後に
  // candidates を空にした」変化で再発火し、見えないまま GPU 描画を走らせてしまう。
  useEffect(() => {
    if (!open) return;
    if (!statsRef.current || !viewport.w || !tile) return;
    if (candidates.length >= MAX_ITEMS) return;
    const needRow = Math.ceil((scrollTop + viewport.h) / tile) + OVERSCAN_ROWS + 2;
    if (rowCount < needRow) {
      produce(Math.max(cols * 2, (needRow - rowCount) * cols));
    }
     
  }, [open, scrollTop, viewport.w, viewport.h, tile, rowCount, cols, candidates.length, produce]);

  // 開いたら（画像が変わったら）ソースを読み、初期候補を生成。閉じたら破棄。
  useEffect(() => {
    if (!open) {
      runRef.current++;
      visRunRef.current++;
      simRunRef.current++;
      cacheRef.current.clear();
      candCountRef.current = 0;
      // 実行中の補充を止めるだけでなく、ソースも捨てる（開き直したときに前回の
      // 画像で描いた候補が一瞬見えるのを防ぐ）。
      statsRef.current = null;
      screenSrcRef.current = null;
      sourceRef.current = null;
      setCandidates([]);
      setSelectedId(null);
      setSimilar([]);
      setSimilarSelectedId(null);
      setScrollTop(0);
      return;
    }
    let alive = true;
    loadImage(imageSrc)
      .then((img) => {
        if (!alive) return;
        const w = THUMB_RENDER_WIDTH;
        const h = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * w));
        const id = getImageData(img, w, h);
        sourceRef.current = { data: id.data, width: w, height: h };
        statsRef.current = analyzeSource(id.data, w, h);
        // 足切り採点用の小さいソース
        const sw = SCREEN_RENDER_WIDTH;
        const sh = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * sw));
        const sid = getImageData(img, sw, sh);
        screenSrcRef.current = { data: sid.data, width: sw, height: sh };
        cacheRef.current.clear();
        runRef.current++;
        pageRef.current = 0;
        seenSigRef.current = new Set();
        paletteCountRef.current = new Map();
        candCountRef.current = 0;
        setSelectedId(null);
        setSimilar([]);
        setSimilarSelectedId(null);
        setScrollTop(0);
        if (scrollElRef.current) scrollElRef.current.scrollTop = 0;
        setCandidates([]);
        produce(PAGE);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, imageSrc]);

  // スクロールコンテナの計測（ResizeObserver）。
  const setScrollEl = useCallback((el: HTMLDivElement | null) => {
    scrollElRef.current = el;
    roRef.current?.disconnect();
    if (el) {
      const ro = new ResizeObserver(() => setViewport({ w: el.clientWidth, h: el.clientHeight }));
      ro.observe(el);
      roRef.current = ro;
      setViewport({ w: el.clientWidth, h: el.clientHeight });
    }
  }, []);
  useEffect(() => () => roRef.current?.disconnect(), []);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const st = e.currentTarget.scrollTop;
    if (scrollRaf.current) return;
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = 0;
      setScrollTop(st);
    });
  };

  /** タイルを選択 → 下に similar strip を出す（ベースを左端に固定）。 */
  const selectMain = useCallback(
    async (cand: Candidate) => {
      setSelectedId(cand.id);
      setSimilarSelectedId(cand.id);
      const src = sourceRef.current;
      if (!src) return;
      const myRun = ++simRunRef.current;
      setSimilarLoading(true);
      const baseR = cacheRef.current.get(cand.id) ?? (await renderCand(src, cand));
      if (myRun !== simRunRef.current) return;
      const strip: Rendered[] = baseR ? [baseR] : [];
      setSimilar([...strip]);
      // 近傍は多めに作り、潰れたものと重複を落としながら SIMILAR_COUNT 枚まで並べる。
      const seen = new Set<string>([candidateSignature(cand)]);
      const variations = mutate(cand, simSeedRef.current++, SIMILAR_COUNT * 2);
      for (const v of variations) {
        if (strip.length > SIMILAR_COUNT) break;
        const sig = candidateSignature(v);
        if (seen.has(sig)) continue;
        seen.add(sig);
        if (myRun !== simRunRef.current) return;
        const r = await queueRender(v, () => myRun === simRunRef.current);
        if (myRun !== simRunRef.current) return;
        if (!r) continue;
        // 表示用に描いたサムネをそのまま採点し、ディテールが潰れたものは並べない
        const s = scoreRender(src.data, r.pixels, src.width, src.height);
        if (s.distinction < MIN_DISTINCTION || s.variation < MIN_VARIATION) continue;
        strip.push(r);
        setSimilar([...strip]);
      }
      if (myRun !== simRunRef.current) return;
      setSimilarLoading(false);
    },
    [queueRender],
  );

  const apply = (cand: Candidate) => {
    onApply(cand);
    onOpenChange(false);
  };
  const applyTarget: Candidate | null =
    similar.find((r) => r.id === similarSelectedId) ?? candMap.get(selectedId ?? "") ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[82vh] max-h-[82vh] w-[90vw] max-w-[90vw] flex-col gap-0 overflow-hidden bg-background/70 p-0 backdrop-blur-md sm:max-w-[745px]">
        <DialogHeader className="space-y-0 border-b px-4 py-2.5 pr-12 text-left">
          <DialogTitle className="text-base">Discover</DialogTitle>
        </DialogHeader>

        {/* Main grid — seamless, edge-to-edge, infinite + virtualized. */}
        <div
          ref={setScrollEl}
          onScroll={onScroll}
          className="thin-scroll relative flex-1 overflow-y-auto overscroll-contain"
        >
          {candidates.length === 0 ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : (
            <div style={{ position: "relative", height: totalH }}>
              {viewport.w > 0 &&
                visible.map(({ cand, row, col }) => {
                  const left = Math.round(col * tile);
                  const top = Math.round(row * tile);
                  const width = Math.round((col + 1) * tile) - left;
                  const height = Math.round((row + 1) * tile) - top;
                  const r = cacheRef.current.get(cand.id);
                  const active = cand.id === selectedId;
                  return (
                    <button
                      key={cand.id}
                      onClick={() => selectMain(cand)}
                      onDoubleClick={() => apply(cand)}
                      style={{ position: "absolute", left, top, width, height }}
                      className="group overflow-hidden bg-muted"
                    >
                      {r ? (
                        <Thumb pixels={r.pixels} w={r.w} h={r.h} />
                      ) : (
                        <div className="h-full w-full animate-pulse bg-muted" />
                      )}
                      <SwatchLabel colors={cand.colors} />
                      {active && <SelectionMark />}
                    </button>
                  );
                })}
            </div>
          )}
        </div>

        {/* Second hierarchy: horizontal strip of variations for the selected tile. */}
        {selectedId && (
          <div className="border-t">
            <div className="flex h-7 items-center px-3 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Similar
            </div>
            <div className="thin-scroll flex overflow-x-auto overscroll-contain pb-2">
              {similar.map((s) => {
                const active = s.id === similarSelectedId;
                return (
                  <button
                    key={s.id}
                    onClick={() => setSimilarSelectedId(s.id)}
                    onDoubleClick={() => apply(s)}
                    style={{ width: stripTile, height: stripTile }}
                    className="group relative shrink-0 overflow-hidden bg-muted"
                  >
                    <Thumb pixels={s.pixels} w={s.w} h={s.h} />
                    <SwatchLabel colors={s.colors} />
                    {active && <SelectionMark />}
                  </button>
                );
              })}
              {similarLoading && (
                <div
                  style={{ width: stripTile, height: stripTile }}
                  className="flex shrink-0 items-center justify-center text-muted-foreground"
                >
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              )}
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t px-4 py-2.5">
          <Button
            variant="outline"
            className="h-9 shrink-0 gap-1.5 text-xs"
            onClick={() => applyTarget && apply(applyTarget)}
            disabled={!applyTarget}
          >
            Apply
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
