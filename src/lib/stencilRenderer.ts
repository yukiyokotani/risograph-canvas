/**
 * ステンシル描画のフロントエンド。
 *
 * WebGPU が使えれば GPU で網点・合成し、使えない/失敗した場合は従来の CPU 実装
 * （computeStencil）へフォールバックする。出力は CPU 実装と一致する。
 *
 * 色分解（濃度マップ）は元ピクセルの純関数なので、網点系のパラメータ（ドットサイズ・
 * 濃度・版ずれ・ノイズ・テクスチャ等）だけを変えたときは再計算せずキャッシュを使う。
 */
import {
  computeStencil,
  computeInkDensities,
  type StencilOptions,
  type ImageDataLike,
  type InkDensities,
} from "./stencil";
import { renderStencilWebGPU, type GpuStencilInput } from "./stencilGpu";

/** 版ずれ・グレインの既定シード（stencil.ts と一致させる） */
const DEFAULT_SEED = 0x5f3759df;

let devicePromise: Promise<GPUDevice | null> | null = null;

/** WebGPU デバイスを一度だけ取得してキャッシュする。使えなければ null を返す。 */
export function getGpuDevice(): Promise<GPUDevice | null> {
  if (!devicePromise) {
    devicePromise = (async () => {
      try {
        if (typeof navigator === "undefined" || !navigator.gpu) return null;
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) return null;
        const device = await adapter.requestDevice();
        // デバイスロスト時は次回に再取得させる
        device.lost.then(() => { devicePromise = null; });
        return device;
      } catch {
        return null;
      }
    })();
  }
  return devicePromise;
}

// --- 濃度マップのキャッシュ ---
// 分解に影響するパラメータが変わったときだけ再計算する。
const sourceIds = new WeakMap<object, number>();
let nextSourceId = 1;
function sourceId(source: ImageDataLike): number {
  let id = sourceIds.get(source as object);
  if (id === undefined) {
    id = nextSourceId++;
    sourceIds.set(source as object, id);
  }
  return id;
}

/** 分解結果に影響するパラメータだけからキーを作る（網点系は含めない） */
function densityKey(source: ImageDataLike, o: StencilOptions): string {
  return JSON.stringify([
    sourceId(source), source.width, source.height,
    o.colors.map((c) => `${c.color}:${c.angle ?? ""}`),
    o.colorMode, o.gamutThreshold, o.blackGeneration, o.highlightCutoff,
    o.invert, o.inkOpacity, o.paperColor,
  ]);
}

let densityCache: { key: string; densities: InkDensities } | null = null;

/** 濃度キャッシュを破棄（画像を変えたときなど、メモリを解放したい場合に使う） */
export function clearDensityCache(): void {
  densityCache = null;
}

function toGpuInput(d: InkDensities, o: StencilOptions): GpuStencilInput {
  const renderScale = o.renderScale ?? 1;
  return {
    densityMaps: d.densityMaps,
    angles: d.angles,
    inkRgbs: d.inkRgbs,
    paper: d.paper,
    width: d.width,
    height: d.height,
    // ピクセル単位のパラメータは computeStencil と同じく描画スケールへ比例させる
    dotSize: o.dotSize * renderScale,
    density: o.density ?? 1,
    inkOpacity: o.inkOpacity ?? 0.85,
    halftoneMode: o.halftoneMode ?? "am",
    transparentBg: o.transparentBg ?? false,
    misregistration: o.misregistration * renderScale,
    grain: o.grain,
    noise: o.noise ?? 0,
    seed: o.seed ?? DEFAULT_SEED,
    paperTexture: o.paperTexture ?? "felt",
    paperTextureAmount: o.paperTextureAmount ?? 0.5,
    renderScale,
  };
}

/**
 * WebGPU 優先でステンシルを描画し、RGBA ピクセルを返す。
 * WebGPU が使えない/失敗した場合は CPU 実装にフォールバックする。
 */
export async function renderStencilPixels(
  source: ImageDataLike,
  options: StencilOptions
): Promise<Uint8ClampedArray> {
  const device = await getGpuDevice();
  if (device) {
    try {
      const key = densityKey(source, options);
      let densities =
        densityCache && densityCache.key === key ? densityCache.densities : null;
      if (!densities) {
        densities = computeInkDensities(source, options);
        densityCache = { key, densities };
      }
      return await renderStencilWebGPU(device, toGpuInput(densities, options));
    } catch (e) {
      // GPU 側で問題が起きても描画は止めない
      console.warn("[stencil] WebGPU 描画に失敗したため CPU にフォールバックします", e);
    }
  }
  return computeStencil(source, options);
}
