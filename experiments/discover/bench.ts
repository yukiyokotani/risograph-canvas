/**
 * Discover の「振り方」を数値で見るためのベンチ。
 *
 * 生成 → 重複排除 → 足切りまで DiscoverDialog と同じ手順を再現し、
 *   - 足切りの通過率（落ちる候補が多い＝スロットの無駄）
 *   - タイル同士の見た目の距離（近すぎるペア＝実質同じタイル）
 *   - パレット/パラメータの分布
 * を出す。生成ロジックを触る前後で同じ seed 列を回して比べる用。
 *
 * 使い方（dev サーバのコンソール）:
 *   const b = await import("/experiments/discover/bench.ts"); await b.runBench();
 */
import { computeStencil, type StencilOptions } from "../../src/lib/stencil";
import { buildToneLut, INVERT_CURVES } from "../../src/lib/curve";
import { rgbToLab } from "../../src/lib/color";
import { INKS } from "../../src/presets";
import {
  analyzeSource,
  generateCandidates,
  scoreRender,
  candidateSignature,
  paletteKey,
  DISCOVER_FIXED,
  SCREEN_RENDER_WIDTH,
  PREVIEW_BASE_WIDTH,
  MIN_DISTINCTION,
  MIN_VARIATION,
  MAX_PER_PALETTE,
  type Candidate,
} from "../../src/lib/discover";

const INVERT_LUT = buildToneLut(INVERT_CURVES);

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
    separation: cand.separation,
    blackGeneration: cand.blackGeneration ?? DISCOVER_FIXED.blackGeneration,
    highlightCutoff: cand.highlightCutoff,
    paperTexture: cand.paperTexture,
    paperTextureAmount: cand.paperTextureAmount ?? DISCOVER_FIXED.paperTextureAmount,
    noise: cand.noise ?? DISCOVER_FIXED.noise,
    transparentBg: false,
    toneLut: cand.invert ? INVERT_LUT : undefined,
    renderScale: srcWidth / PREVIEW_BASE_WIDTH,
  };
}

async function loadSource(src: string, w: number) {
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = rej;
    img.src = src;
  });
  const h = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * w));
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d")!;
  ctx.drawImage(img, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h).data, width: w, height: h };
}

/**
 * 合成テストソース。public/sample.jpg は階調チャートで「被写体が残るか」を測れないので、
 * 被写体（楕円）＋背景の2色構成に、緩い陰影と細部ノイズを載せた決定的な画像を作る。
 * キー（明るさ）とコントラストと彩度だけを変えた数種類を用意し、生成側が画像の性格に
 * 合わせて振れているかを見る。
 */
export type SourceKind = "portrait" | "lowkey" | "highkey" | "flat" | "mono";
const PROFILES: Record<SourceKind, { subj: number[]; bg: number[]; lift: number; gain: number }> = {
  // subj/bg は sRGB。lift/gain で全体のキーとコントラストを作る。
  portrait: { subj: [214, 156, 128], bg: [64, 92, 120], lift: 0, gain: 1 },
  lowkey: { subj: [150, 96, 74], bg: [28, 34, 46], lift: -22, gain: 0.72 },
  highkey: { subj: [238, 206, 190], bg: [188, 206, 222], lift: 26, gain: 0.8 },
  flat: { subj: [162, 142, 128], bg: [110, 124, 138], lift: 4, gain: 0.72 },
  mono: { subj: [176, 176, 176], bg: [88, 88, 88], lift: 0, gain: 1 },
};

export function makeTestSource(kind: SourceKind, w = SCREEN_RENDER_WIDTH) {
  const h = Math.max(1, Math.round(w * 1.25));
  const p = PROFILES[kind];
  const data = new Uint8ClampedArray(w * h * 4);
  // 決定的なハッシュノイズ（細部＝distinction が拾う高周波）
  const nz = (x: number, y: number) => {
    let t = (x * 374761393 + y * 668265263) >>> 0;
    t = Math.imul(t ^ (t >>> 13), 1274126177) >>> 0;
    return ((t ^ (t >>> 16)) >>> 0) / 4294967296 - 0.5;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // 被写体マスク（楕円・境界はなめらか）
      const dx = (x - w * 0.5) / (w * 0.34);
      const dy = (y - h * 0.44) / (h * 0.32);
      const d = Math.hypot(dx, dy);
      const m = 1 / (1 + Math.exp((d - 1) * 7));
      // 陰影: 斜めの傾き＋ゆるい起伏（面ではなく立体に見えるように）
      const shade =
        0.86 +
        0.16 * (1 - y / h) +
        0.06 * Math.sin((x / w) * 5.1) * Math.cos((y / h) * 3.7);
      const grain = nz(x, y) * 16 + nz(x >> 1, y >> 1) * 10;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const base = p.bg[c] + (p.subj[c] - p.bg[c]) * m;
        const v = (base * shade + grain - 128) * p.gain + 128 + p.lift;
        data[o + c] = Math.max(0, Math.min(255, v));
      }
      data[o + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

/** タイル全体の平均 Lab（「遠目に見たときの色」）。タイル同士の距離の指標に使う。 */
function meanLab(px: Uint8ClampedArray): [number, number, number] {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < px.length; i += 4) {
    r += px[i]; g += px[i + 1]; b += px[i + 2]; n++;
  }
  return rgbToLab(r / n, g / n, b / n);
}
const dE = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** 軸の値ごとに「足切り通過率 %(件数)」を出す。どの値が落ちているかを見る。 */
function rate<K extends string | number>(
  scored: { cand: Candidate; d: number; v: number }[],
  key: (c: Candidate) => K,
): string {
  const m = new Map<K, { n: number; ok: number }>();
  for (const s of scored) {
    const k = key(s.cand);
    const e = m.get(k) ?? { n: 0, ok: 0 };
    e.n++;
    if (s.d >= MIN_DISTINCTION && s.v >= MIN_VARIATION) e.ok++;
    m.set(k, e);
  }
  return [...m.entries()]
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }))
    .map(([k, e]) => `${k}=${Math.round((e.ok / e.n) * 100)}%(${e.n})`)
    .join(" ");
}

const hist = (vals: number[]) => {
  const m = new Map<number, number>();
  for (const v of vals) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, c]) => `${k}:${c}`).join(" ");
};

export async function runBench(kind: SourceKind | "sample" = "portrait", pages = 5) {
  const screen =
    kind === "sample"
      ? await loadSource("/sample.jpg", SCREEN_RENDER_WIDTH)
      : makeTestSource(kind);
  const stats = analyzeSource(screen.data, screen.width, screen.height);

  const seenSig = new Set<string>();
  const paletteCount = new Map<string, number>();
  let generated = 0, dupSig = 0, dupPalette = 0, culled = 0;
  let failDist = 0, failVar = 0;
  const kept: { cand: Candidate; lab: [number, number, number] }[] = [];
  const scored: { cand: Candidate; d: number; v: number }[] = [];

  for (let page = 1; page <= pages; page++) {
    for (const cand of generateCandidates(stats, page, 48)) {
      generated++;
      const sig = candidateSignature(cand);
      if (seenSig.has(sig)) { dupSig++; continue; }
      const pal = paletteKey(cand);
      const used = paletteCount.get(pal) ?? 0;
      if (used >= MAX_PER_PALETTE) { dupPalette++; continue; }
      seenSig.add(sig);
      paletteCount.set(pal, used + 1);
      const px = computeStencil(screen, buildOptions(cand, screen.width));
      const s = scoreRender(screen.data, px, screen.width, screen.height);
      scored.push({ cand, d: s.distinction, v: s.variation });
      if (s.distinction < MIN_DISTINCTION || s.variation < MIN_VARIATION) {
        culled++;
        if (s.distinction < MIN_DISTINCTION) failDist++;
        if (s.variation < MIN_VARIATION) failVar++;
        continue;
      }
      kept.push({ cand, lab: meanLab(px) });
    }
  }

  // タイル同士の距離。近いペアが多いほど「同じに見えるタイル」でグリッドが埋まっている。
  let near = 0, pairs = 0, sum = 0;
  for (let i = 0; i < kept.length; i++) {
    for (let j = i + 1; j < kept.length; j++) {
      const d = dE(kept[i].lab, kept[j].lab);
      sum += d; pairs++;
      if (d < 4) near++;
    }
  }
  // 版ずれ: サムネ描画で実際に 1px 以上ずれる候補の割合（0 なら振っても見えない）
  const scale = SCREEN_RENDER_WIDTH / PREVIEW_BASE_WIDTH;
  const visibleMisreg = kept.filter((k) => Math.round(k.cand.misregistration * scale) > 0).length;

  const out = {
    kind,
    srcChroma: +stats.chroma.toFixed(1),
    generated,
    dupSig,
    dupPalette,
    culled,
    kept: kept.length,
    cullPassPct: +((kept.length / (generated - dupSig - dupPalette)) * 100).toFixed(1),
    uniquePalettes: new Set(kept.map((k) => paletteKey(k.cand))).size,
    meanTileDistance: +(sum / pairs).toFixed(2),
    nearDuplicatePairsPct: +((near / pairs) * 100).toFixed(2),
    visibleMisregPct: +((visibleMisreg / kept.length) * 100).toFixed(1),
    failDistPct: +((failDist / scored.length) * 100).toFixed(1),
    failVarPct: +((failVar / scored.length) * 100).toFixed(1),
    // 軸ごとの通過率（どの値が落ちているか）
    byDensity: rate(scored, (c) => c.density),
    byOpacity: rate(scored, (c) => c.inkOpacity),
    bySeparation: rate(scored, (c) => (c.separation === 0 ? 0 : c.separation < 0.45 ? 0.3 : c.separation < 0.75 ? 0.6 : 0.9)),
    byDotSize: rate(scored, (c) => c.dotSize),
    byCategory: rate(scored, (c) => c.category),
    byInks: rate(scored, (c) => c.colors.length),
    inkCounts: hist(kept.map((k) => k.cand.colors.length)),
    dotSize: hist(kept.map((k) => k.cand.dotSize)),
    density: hist(kept.map((k) => k.cand.density)),
    opacity: hist(kept.map((k) => k.cand.inkOpacity)),
    separation: hist(kept.map((k) => Math.round(k.cand.separation * 10) / 10)),
    category: hist(kept.map((k) => ["current", "curated", "duo", "tri", "single", "surprise"].indexOf(k.cand.category))),
  };
  console.log(JSON.stringify(out, null, 2));
  return out;
}

/**
 * パラメータ空間の掃引。生成側の当てずっぽうを避けるため、代表的なパレット型ごとに
 * density × opacity × separation を総当たりして「どの領域が足切りを通るか」を測る。
 * ここで得た当たり領域を randomParams の抽選プールに反映する。
 */
export async function runSweep(kind: SourceKind, dotSize = 4) {
  const screen = makeTestSource(kind);
  const P = {
    duo: { colors: [INKS.blue, INKS.brightRed], paper: "#f5f0e8", invert: false },
    tri: { colors: [INKS.blue, INKS.brightRed, INKS.yellow], paper: "#f5f0e8", invert: false },
    triK: { colors: [INKS.blue, INKS.brightRed, INKS.black], paper: "#f5f0e8", invert: false },
    single: { colors: [INKS.fluorescentPink], paper: "#f5f0e8", invert: false },
    dark: { colors: [INKS.fluorescentPink], paper: "#1a1a1a", invert: true },
  };
  const DENS = [0.9, 1.1, 1.3, 1.5];
  const OPAC = [0.65, 0.8, 0.95];
  const SEP = [0, 0.3, 0.6, 0.9];
  const rows: Record<string, string> = {};
  for (const [name, p] of Object.entries(P)) {
    const cells: string[] = [];
    for (const density of DENS) {
      for (const inkOpacity of OPAC) {
        for (const separation of SEP) {
          const cand = {
            id: "x", label: "", category: "duo", colors: p.colors, paperColor: p.paper,
            invert: p.invert, separation, dotSize, density, inkOpacity, misregistration: 1,
            highlightCutoff: 0, paperTexture: "none", halftoneMode: "am",
          } as unknown as Candidate;
          const px = computeStencil(screen, buildOptions(cand, screen.width));
          const s = scoreRender(screen.data, px, screen.width, screen.height);
          const ok = s.distinction >= MIN_DISTINCTION && s.variation >= MIN_VARIATION;
          if (ok) cells.push(`d${density}/o${inkOpacity}/s${separation}`);
        }
      }
    }
    rows[name] = `${cells.length}/${DENS.length * OPAC.length * SEP.length} ok :: ${cells.join(", ")}`;
  }
  console.log(kind, rows);
  return rows;
}

/** 全プロファイルを回して1行ずつ要約する（変更前後の比較用）。 */
export async function runAll(pages = 4) {
  const kinds: SourceKind[] = ["portrait", "lowkey", "highkey", "flat", "mono"];
  const rows = [];
  for (const k of kinds) rows.push(await runBench(k, pages));
  return rows.map((r) => ({
    kind: r.kind,
    kept: r.kept,
    cullPassPct: r.cullPassPct,
    uniquePalettes: r.uniquePalettes,
    meanTileDistance: r.meanTileDistance,
    nearDupPct: r.nearDuplicatePairsPct,
  }));
}
