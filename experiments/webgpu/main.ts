// WebGPU パリティ実験のオーケストレーション。
// CPU 参照(computeStencil) と WebGPU 版を並べ、ピクセル差分を計測する。
import { computeStencil, computeInkDensities, type InkDensities, type StencilOptions } from "../../src/lib/stencil";
import { renderStencilWebGPU, type GpuStencilInput } from "../../src/lib/stencilGpu";
import { computeInkDensitiesWebGPU } from "../../src/lib/stencilDecomposeGpu";

const PRESETS: Record<string, { name: string; color: string }[]> = {
  tricolor: [
    { name: "Blue", color: "#0078BF" },
    { name: "Red", color: "#F15060" },
    { name: "Yellow", color: "#FFE800" },
  ],
  cmyk: [
    { name: "Blue", color: "#0078BF" },
    { name: "Red", color: "#F15060" },
    { name: "Yellow", color: "#FFE800" },
    { name: "Black", color: "#000000" },
  ],
  classic: [
    { name: "Blue", color: "#0078BF" },
    { name: "Red", color: "#F15060" },
  ],
  "mono-black": [{ name: "Black", color: "#000000" }],
  "mono-red": [{ name: "Red", color: "#E93A28" }],
  "mono-blue": [{ name: "Blue", color: "#0078BF" }],
  "pink-blue": [
    { name: "Fl. Pink", color: "#F0409A" },
    { name: "Mid Blue", color: "#3255A4" },
  ],
};

const $ = (id: string) => document.getElementById(id)!;
const statusEl = $("status");
const metricsEl = $("metrics");
const log = (s: string) => { statusEl.textContent = s; console.log(s); };

let device: GPUDevice | null = null;
let sourceData: ImageData | null = null;

async function initGPU() {
  if (!navigator.gpu) throw new Error("WebGPU not available");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no GPU adapter");
  device = await adapter.requestDevice();
  device.lost.then((info) => log("GPU device lost: " + info.message));
}

async function loadImage(maxW: number): Promise<ImageData> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("failed to load /sample.jpg"));
    img.src = "/sample.jpg";
  });
  const scale = maxW / img.naturalWidth; // 計測用に拡大も許可
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

function draw(canvasId: string, pixels: Uint8ClampedArray, w: number, h: number) {
  const cv = $(canvasId) as HTMLCanvasElement;
  cv.width = w; cv.height = h;
  cv.getContext("2d")!.putImageData(new ImageData(pixels, w, h), 0, 0);
}

function diffMetrics(a: Uint8ClampedArray, b: Uint8ClampedArray, w: number, h: number) {
  const diff = new Uint8ClampedArray(a.length);
  let maxD = 0, sum = 0, n = 0, over2 = 0, over8 = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a[i + c] - b[i + c]);
      diff[i + c] = Math.min(255, d * 8);
      if (d > maxD) maxD = d;
      sum += d; n++;
      if (d > 2) over2++;
      if (d > 8) over8++;
    }
    diff[i + 3] = 255;
  }
  draw("diff", diff, w, h);
  return { maxD, mean: sum / n, pctOver2: (100 * over2 / n), pctOver8: (100 * over8 / n) };
}

let loadedSize = 0;
async function run() {
  const size = parseInt(($("size") as HTMLSelectElement).value, 10);
  if (!sourceData || loadedSize !== size) {
    log(`loading /sample.jpg at ${size}px…`);
    sourceData = await loadImage(size);
    loadedSize = size;
  }
  const { width: w, height: h } = sourceData;
  const preset = ($("preset") as HTMLSelectElement).value;
  const mode = ($("mode") as HTMLSelectElement).value as "am" | "fm";
  const dotSize = parseFloat(($("dot") as HTMLSelectElement).value);

  // エフェクト(版ずれ/グレイン/ノイズ/紙テクスチャ)の ON/OFF でパリティを切り分ける
  const fx = ($("fx") as HTMLSelectElement).value !== "off";
  const misregistration = fx ? 2 : 0;
  const grain = fx ? 0.1 : 0;
  const noise = fx ? 0.15 : 0;
  const paperTexture = (fx ? "fiber" : "none") as "none" | "felt" | "fiber";
  const paperTextureAmount = fx ? 0.5 : 0;
  const seed = 0x5f3759df;
  const renderScale = 1;

  const options: StencilOptions = {
    colors: PRESETS[preset],
    dotSize, misregistration, grain, density: 1.2, inkOpacity: 0.85,
    paperColor: ($("paper") as HTMLSelectElement).value, halftoneMode: mode,
    separation: parseFloat(($("sep") as HTMLSelectElement).value), blackGeneration: 0.7,
    highlightCutoff: parseFloat(($("cutoff") as HTMLSelectElement).value),
    noise, transparentBg: false, invert: false, renderScale, seed,
    paperTexture, paperTextureAmount,
  };

  const skipCpu = ($("skipcpu") as HTMLInputElement).checked;
  const useGpuDecompose = ($("gpudecomp") as HTMLInputElement).checked;

  // 分解（CPU 参照）— GPU 分解のパリティ比較にも使う
  const td = performance.now();
  const cap: InkDensities = computeInkDensities(sourceData, options);
  const decompMs = performance.now() - td;

  // GPU 分解（任意）: CPU の密度マップと per-ink で差分を取る
  let densInfo = "";
  let densForGpu = cap;
  if (useGpuDecompose) {
    try {
      const tg = performance.now();
      const gpuDens = await computeInkDensitiesWebGPU(device!, sourceData, options);
      const gpuDecompMs = performance.now() - tg;
      densForGpu = gpuDens;
      let maxD = 0, sum = 0, n = 0;
      for (let k = 0; k < cap.densityMaps.length; k++) {
        const a = cap.densityMaps[k], b = gpuDens.densityMaps[k];
        for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > maxD) maxD = d; sum += d; n++; }
      }
      densInfo = `\n分解パリティ(密度0-1): max ${maxD.toFixed(4)} mean ${(sum / n).toFixed(5)}  | 分解 CPU ${decompMs.toFixed(0)}ms → GPU ${gpuDecompMs.toFixed(1)}ms`;
    } catch (e) {
      densInfo = `\nGPU 分解 失敗: ${(e as Error).message}`;
    }
  }

  // CPU 参照（フル）
  let cpuPixels: Uint8ClampedArray | null = null;
  let cpuMs = NaN;
  if (!skipCpu) {
    const t0 = performance.now();
    cpuPixels = computeStencil(sourceData, options);
    cpuMs = performance.now() - t0;
    draw("cpu", cpuPixels, w, h);
  }

  // WebGPU（分解は densForGpu = CPU or GPU）
  const gpuInput: GpuStencilInput = {
    densityMaps: densForGpu.densityMaps,
    angles: densForGpu.angles,
    inkRgbs: densForGpu.inkRgbs,
    paper: densForGpu.paper,
    width: w, height: h,
    dotSize, density: 1.2, inkOpacity: 0.85,
    halftoneMode: mode, transparentBg: false,
    misregistration, grain, noise, seed, paperTexture, paperTextureAmount, renderScale,
  };
  try {
    const t1 = performance.now();
    const gpuPixels = await renderStencilWebGPU(device!, gpuInput);
    const gpuMs = performance.now() - t1;
    draw("gpu", gpuPixels, w, h);
    const parity = cpuPixels
      ? (() => { const m = diffMetrics(cpuPixels, gpuPixels, w, h);
          return `\ndiff: max ${m.maxD}  mean ${m.mean.toFixed(2)}  |  >2: ${m.pctOver2.toFixed(2)}%  >8: ${m.pctOver8.toFixed(2)}%`; })()
      : "\n(CPU skipped)";
    const cpuTxt = skipCpu ? "—" : `${cpuMs.toFixed(0)}ms`;
    const speedup = skipCpu ? "" : `  → ${(cpuMs / gpuMs).toFixed(1)}× faster`;
    metricsEl.textContent =
      `size ${w}×${h} (${(w * h / 1e6).toFixed(2)}MP)` +
      `\n分解(CPU, キャッシュ可): ${decompMs.toFixed(0)}ms` +
      `\n網点+合成:  CPU ${cpuTxt}   GPU ${gpuMs.toFixed(1)}ms${speedup}` +
      densInfo +
      parity;
    log("done.");
  } catch (e) {
    log("GPU render failed (未実装 or error): " + (e as Error).message);
    metricsEl.textContent = `CPU ${cpuMs.toFixed(1)}ms  |  GPU: —`;
  }
}

(async () => {
  try {
    log("requesting WebGPU device…");
    await initGPU();
    ($("run") as HTMLButtonElement).onclick = run;
    for (const id of ["preset", "mode", "dot", "fx", "size", "paper", "sep", "cutoff", "skipcpu", "gpudecomp"]) {
      ($(id) as HTMLElement).onchange = run;
    }
    await run();
  } catch (e) {
    log("init failed: " + (e as Error).message);
  }
})();
