import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import {
  buildCurveLut,
  amountOf,
  FULL_AMOUNTS,
  IDENTITY_POINTS,
  INVERT_POINTS,
  type CurvePoint,
  type ToneCurves,
} from "../lib/curve";
import { Slider } from "./ui/slider";

type ChannelKey = "rgb" | "r" | "g" | "b";

const CHANNELS: {
  key: ChannelKey;
  label: string;
  stroke: string;
  chip: string;
}[] = [
  { key: "rgb", label: "RGB", stroke: "currentColor", chip: "" },
  { key: "r", label: "R", stroke: "#ff5d5d", chip: "#d93b3b" },
  { key: "g", label: "G", stroke: "#49d17a", chip: "#2fa35c" },
  { key: "b", label: "B", stroke: "#5b8cff", chip: "#3f68e0" },
];

/** 使い出しの取っ掛かりになるプリセット（点は x 昇順） */
const PRESETS: { label: string; points: CurvePoint[] }[] = [
  { label: "Linear", points: IDENTITY_POINTS },
  { label: "Invert", points: INVERT_POINTS },
  {
    label: "Contrast",
    points: [
      { x: 0, y: 0 },
      { x: 0.25, y: 0.16 },
      { x: 0.75, y: 0.84 },
      { x: 1, y: 1 },
    ],
  },
  {
    label: "Lift shadows",
    points: [
      { x: 0, y: 0.12 },
      { x: 0.5, y: 0.55 },
      { x: 1, y: 1 },
    ],
  },
  {
    label: "Punch darks",
    points: [
      { x: 0, y: 0 },
      { x: 0.45, y: 0.3 },
      { x: 1, y: 1 },
    ],
  },
];

const SIZE = 260; // グラフ領域の一辺（SVG 単位）
const PAD = 10; // 余白。端の点（x=0, x=1）が枠で切れないように内側へ寄せる
const VIEW = SIZE + PAD * 2;
const HIT = 12; // 点をつかめる距離 (px)

export interface CurvesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  curves: ToneCurves;
  onChange: (curves: ToneCurves) => void;
  /** 背景に敷くヒストグラム（各チャンネル 256 段、0–1 に正規化済み） */
  histogram?: { r: Float32Array; g: Float32Array; b: Float32Array } | null;
}

/**
 * トーンカーブのアイコン。3 つのアンカーを通る S 字の曲線。
 */
export function CurvesIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M3 20C9 20 9 12 12 12C15 12 15 4 21 4" />
      <circle cx="3" cy="20" r="2.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
      <circle cx="21" cy="4" r="2.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function CurvesDialog({
  open,
  onOpenChange,
  curves,
  onChange,
  histogram,
}: CurvesDialogProps) {
  const [channel, setChannel] = useState<ChannelKey>("rgb");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const points = curves[channel];

  /** グラフ座標 (0–1) → SVG 座標。y は上下反転（下が 0）。余白 PAD の分だけ内側。 */
  const toSvg = (p: CurvePoint) => ({
    x: PAD + p.x * SIZE,
    y: PAD + (1 - p.y) * SIZE,
  });

  const curvePath = useMemo(() => {
    const raw = buildCurveLut(points, 128);
    // 効き具合を反映した実効カーブを描く（グラフと結果を一致させる）
    const a = amountOf(curves, channel);
    const lut = raw.map((v, i) => {
      const identity = i / (raw.length - 1);
      return identity + (v - identity) * a;
    });
    let d = "";
    for (let i = 0; i < lut.length; i++) {
      const x = PAD + (i / (lut.length - 1)) * SIZE;
      const y = PAD + (1 - lut[i]) * SIZE;
      d += `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    }
    return d;
  }, [points, curves, channel]);

  /**
   * 背景のヒストグラム。合成（3ch の最大）をグレーで敷き、その上に R/G/B を
   * 「半透明の塗り＋輪郭線」で重ねる（業務用のカラコレ UI と同じ見せ方）。
   * 塗りだけだと重なりが濁り、線だけだと分布の量感が出ないので両方を使う。
   */
  const histPaths = useMemo(() => {
    if (!histogram) return null;
    const line = (bins: Float32Array) => {
      let d = "";
      for (let i = 0; i < 256; i++) {
        const x = PAD + (i / 255) * SIZE;
        const y = PAD + SIZE - Math.min(1, bins[i]) * SIZE * 0.92;
        d += `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
      }
      return d;
    };
    const combined = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      combined[i] = Math.max(histogram.r[i], histogram.g[i], histogram.b[i]);
    }
    // 折れ線の先頭 "M" を外して繋ぐので、区切りの "L" を明示する
    // （付け忘れると M10,27010,250... のような不正なパスになり塗りが出ない）
    const area = (bins: Float32Array) =>
      `M${PAD},${PAD + SIZE}L` +
      line(bins).slice(1) +
      `L${PAD + SIZE},${PAD + SIZE}Z`;
    return {
      fill: area(combined),
      lines: [
        { key: "r", d: line(histogram.r), area: area(histogram.r), color: "#ff5d5d" },
        { key: "g", d: line(histogram.g), area: area(histogram.g), color: "#49d17a" },
        { key: "b", d: line(histogram.b), area: area(histogram.b), color: "#5b8cff" },
      ],
    };
  }, [histogram]);

  const amount = amountOf(curves, channel);
  const setAmount = (v: number) => {
    onChange({
      ...curves,
      amounts: { ...(curves.amounts ?? FULL_AMOUNTS), [channel]: v },
    });
  };

  const setPoints = useCallback(
    (next: CurvePoint[]) => {
      onChange({ ...curves, [channel]: next });
    },
    [curves, channel, onChange]
  );

  const eventToGraph = (e: { clientX: number; clientY: number }): CurvePoint => {
    const rect = svgRef.current!.getBoundingClientRect();
    // 表示サイズ → SVG 単位 → 余白を除いたグラフ座標
    const sx = ((e.clientX - rect.left) / rect.width) * VIEW - PAD;
    const sy = ((e.clientY - rect.top) / rect.height) * VIEW - PAD;
    const x = sx / SIZE;
    const y = 1 - sy / SIZE;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const g = eventToGraph(e);
    const rect = svgRef.current!.getBoundingClientRect();
    const scale = rect.width / VIEW;
    // 近くの点をつかむ。無ければ新しく足す。
    let hit = -1;
    let best = HIT * HIT;
    points.forEach((p, i) => {
      const s = toSvg(p);
      const gs = toSvg(g);
      const dx = (s.x - gs.x) * scale;
      const dy = (s.y - gs.y) * scale;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) {
        best = d2;
        hit = i;
      }
    });
    if (hit < 0) {
      const next = [...points, g].sort((a, b) => a.x - b.x);
      hit = next.findIndex((p) => p === g);
      setPoints(next);
    }
    setDragIndex(hit);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (dragIndex === null) return;
    const g = eventToGraph(e);
    const next = points.map((p, i) => {
      if (i !== dragIndex) return p;
      // 端点は x を固定（0 と 1 を保つ）。中間点は隣とすれ違わせない。
      if (i === 0) return { x: 0, y: g.y };
      if (i === points.length - 1) return { x: 1, y: g.y };
      const lo = points[i - 1].x + 0.01;
      const hi = points[i + 1].x - 0.01;
      return { x: Math.min(hi, Math.max(lo, g.x)), y: g.y };
    });
    setPoints(next);
  };

  const endDrag = () => setDragIndex(null);

  /** 中間点はダブルクリックで削除 */
  const removePoint = (index: number) => {
    if (index === 0 || index === points.length - 1) return;
    setPoints(points.filter((_, i) => i !== index));
  };

  // 開いている間は Delete で選択中の点を消せるようにする
  useEffect(() => {
    if (!open || dragIndex === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Backspace" || e.key === "Delete") {
        removePoint(dragIndex);
        setDragIndex(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dragIndex, points]);

  const activeStroke = CHANNELS.find((c) => c.key === channel)!.stroke;
  const isIdentity =
    points.length === 2 && points[0].y === 0 && points[1].y === 1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[92vw] max-w-[92vw] gap-0 bg-background/70 p-0 backdrop-blur-md sm:max-w-md">
        <DialogHeader className="space-y-0 border-b px-4 py-2.5 pr-12 text-left">
          <DialogTitle className="text-base">Tone curves</DialogTitle>
          <p className="text-xs text-muted-foreground">
            Shapes the photo before it is separated into inks.
          </p>
        </DialogHeader>

        <div className="p-4">
          {/* チャンネル切り替え */}
          <div className="mb-3 flex gap-1">
            {CHANNELS.map((c) => (
              <button
                key={c.key}
                onClick={() => setChannel(c.key)}
                className={`h-7 flex-1 rounded-md border text-xs font-medium transition-colors ${
                  channel === c.key
                    ? "text-background"
                    : "border-transparent text-muted-foreground hover:bg-accent/60"
                }`}
                style={
                  channel === c.key
                    ? {
                        background: c.key === "rgb" ? "var(--foreground)" : c.chip,
                        borderColor: c.key === "rgb" ? "var(--foreground)" : c.chip,
                        color: c.key === "rgb" ? "var(--background)" : "#fff",
                      }
                    : undefined
                }
              >
                {c.label}
              </button>
            ))}
          </div>

          {/* グラフ */}
          <svg
            ref={svgRef}
            viewBox={`0 0 ${VIEW} ${VIEW}`}
            className="w-full touch-none rounded-md border bg-card"
            style={{ aspectRatio: "1 / 1", color: "var(--foreground)" }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            {histPaths && (
              <g>
                <path d={histPaths.fill} fill="currentColor" opacity={0.14} />
                {histPaths.lines.map((h) => {
                  const focused = channel === "rgb" || channel === h.key;
                  return (
                    <g key={h.key} opacity={focused ? 1 : 0.25}>
                      <path d={h.area} fill={h.color} opacity={0.16} />
                      <path
                        d={h.d}
                        fill="none"
                        stroke={h.color}
                        strokeWidth={1}
                        vectorEffect="non-scaling-stroke"
                        opacity={0.7}
                      />
                    </g>
                  );
                })}
              </g>
            )}
            {/* 罫線は拡大しても 1px のままにする（太さがばらついて見えるのを防ぐ） */}
            <g
              stroke="currentColor"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              shapeRendering="crispEdges"
            >
              <rect
                x={PAD}
                y={PAD}
                width={SIZE}
                height={SIZE}
                fill="none"
                opacity={0.25}
              />
              {[1, 2, 3, 4, 5, 6, 7].map((n) => (
                <g key={n} opacity={n === 4 ? 0.16 : 0.08}>
                  <line
                    x1={PAD + (n / 8) * SIZE}
                    y1={PAD}
                    x2={PAD + (n / 8) * SIZE}
                    y2={PAD + SIZE}
                  />
                  <line
                    x1={PAD}
                    y1={PAD + (n / 8) * SIZE}
                    x2={PAD + SIZE}
                    y2={PAD + (n / 8) * SIZE}
                  />
                </g>
              ))}
            </g>
            <line
              x1={PAD}
              y1={PAD + SIZE}
              x2={PAD + SIZE}
              y2={PAD}
              stroke="currentColor"
              opacity={0.25}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              strokeDasharray="4 4"
            />
            <path
              d={curvePath}
              fill="none"
              stroke={activeStroke}
              strokeWidth={1.75}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            {points.map((p, i) => {
              const s = toSvg(p);
              return (
                <g key={i} onDoubleClick={() => removePoint(i)}>
                  <circle
                    cx={s.x}
                    cy={s.y}
                    r={i === dragIndex ? 5.5 : 4.25}
                    fill={activeStroke}
                    stroke="#00000066"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              );
            })}
          </svg>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            Drag to bend the curve. Click empty space to add a point,
            double-click a point to remove it.
          </p>

          {/* 効き具合（チャンネルごと）。0 で素通し、100 で設定したカーブそのまま。 */}
          <div className="mt-3">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Amount</span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {Math.round(amount * 100)}%
              </span>
            </div>
            <Slider
              aria-label="Curve amount"
              value={[amount]}
              onValueChange={([v]) => setAmount(v)}
              min={0}
              max={1}
              step={0.05}
            />
          </div>

          {/* プリセット */}
          <div className="mt-3 flex flex-wrap gap-1.5">
            {PRESETS.map((preset) => (
              <button
                key={preset.label}
                onClick={() => setPoints(preset.points.map((p) => ({ ...p })))}
                className="rounded-md border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t px-4 py-2.5">
          <button
            onClick={() =>
              onChange({
                rgb: IDENTITY_POINTS,
                r: IDENTITY_POINTS,
                g: IDENTITY_POINTS,
                b: IDENTITY_POINTS,
                amounts: FULL_AMOUNTS,
              })
            }
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Reset all channels
          </button>
          <Button
            variant="outline"
            className="h-9 shrink-0 text-xs"
            onClick={() => onOpenChange(false)}
            disabled={false}
          >
            {isIdentity ? "Close" : "Done"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
