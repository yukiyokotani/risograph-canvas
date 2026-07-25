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
  type StencilOptions,
  type ImageDataLike,
} from "./stencil";
import { compositeFromDensityBuffer } from "./stencilGpu";
import { decomposeToGpuBuffer, type GpuDensities } from "./stencilDecomposeGpu";

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
        // デバイスロスト時は次回に再取得させる。失われたデバイス上のバッファを
        // 抱えたままだと、次の描画でそれを渡してしまい 1 フレーム無駄に失敗する。
        device.lost.then(() => { devicePromise = null; clearDensityCache(); });
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
    o.separation, o.blackGeneration, o.highlightCutoff,
    o.invert, o.inkOpacity, o.paperColor,
    // トーンカーブは分解前に入力を変えるのでキーに含める
    o.toneLut ? Array.from(o.toneLut) : null,
  ]);
}

// 濃度は GPU バッファのままキャッシュし、合成器へ直接渡す（GPU→CPU→GPU の往復を排除）。
let densityCache: { key: string; densities: GpuDensities } | null = null;

/** 濃度キャッシュを破棄しバッファも解放する（画像を変えたときなど） */
export function clearDensityCache(): void {
  densityCache?.densities.densityBuffer.destroy();
  densityCache = null;
}

// すべての描画呼び出しを直列化するためのロック。
// 共有の densityCache / GPU バッファに複数の描画（例: Discover の大量サムネと
// メインプレビュー）が同時アクセスすると、片方が相手の densityBuffer を destroy して
// 空の density で合成される（＝インクが消える）ため、グローバルに1本ずつ実行する。
let renderLock: Promise<unknown> = Promise.resolve();

/**
 * WebGPU 優先でステンシルを描画し、RGBA ピクセルを返す。
 * 分解→合成を GPU バッファで直結し、濃度はキャッシュする（分解に効くパラメータが
 * 変わったときだけ再分解）。WebGPU が使えない/失敗時は CPU 実装へフォールバック。
 *
 * 共有 GPU 状態の競合を防ぐため、呼び出しはグローバルに直列化する。
 */
export function renderStencilPixels(
  source: ImageDataLike,
  options: StencilOptions
): Promise<Uint8ClampedArray> {
  return serialized(() => renderStencilPixelsInner(source, options, true));
}

/**
 * GPU でのみ描画する（失敗しても CPU へ落とさず例外にする）。
 *
 * 書き出しのように「失敗したら Worker で処理したい」呼び出し側が使う。
 * 既定の {@link renderStencilPixels} はメインスレッドの CPU 実装へ落ちるため、
 * 大きな書き出しで GPU が容量制限に当たると UI が固まってしまう。
 */
export function renderStencilPixelsGpuOnly(
  source: ImageDataLike,
  options: StencilOptions
): Promise<Uint8ClampedArray> {
  return serialized(() => renderStencilPixelsInner(source, options, false));
}

/** 共有 GPU 状態の競合を防ぐため、呼び出しをグローバルに直列化する。 */
function serialized(
  task: () => Promise<Uint8ClampedArray>
): Promise<Uint8ClampedArray> {
  const run = renderLock.then(task);
  // 失敗しても後続を止めない（チェーンは常に解決扱いにする）
  renderLock = run.then(
    () => {},
    () => {},
  );
  return run;
}

async function renderStencilPixelsInner(
  source: ImageDataLike,
  options: StencilOptions,
  cpuFallback: boolean
): Promise<Uint8ClampedArray> {
  const device = await getGpuDevice();
  if (device) {
    try {
      const key = densityKey(source, options);
      let densities =
        densityCache && densityCache.key === key ? densityCache.densities : null;
      if (!densities) {
        // 分解も GPU で（LUT ではなく直接移植なので出力は CPU と一致）。
        densities = await decomposeToGpuBuffer(device, source, options);
        // 古いバッファを解放してから差し替え
        if (densityCache && densityCache.densities !== densities) {
          densityCache.densities.densityBuffer.destroy();
        }
        densityCache = { key, densities };
      }
      const renderScale = options.renderScale ?? 1;
      return await compositeFromDensityBuffer(device, {
        densityBuffer: densities.densityBuffer,
        inkCount: densities.inkCount,
        angles: densities.angles,
        inkRgbs: densities.inkRgbs,
        paper: densities.paper,
        width: densities.width,
        height: densities.height,
        // ピクセル単位のパラメータは computeStencil と同じく描画スケールへ比例させる
        dotSize: options.dotSize * renderScale,
        density: options.density ?? 1,
        inkOpacity: options.inkOpacity ?? 0.85,
        halftoneMode: options.halftoneMode ?? "am",
        transparentBg: options.transparentBg ?? false,
        misregistration: options.misregistration * renderScale,
        grain: options.grain,
        noise: options.noise ?? 0,
        seed: options.seed ?? DEFAULT_SEED,
        paperTexture: options.paperTexture ?? "felt",
        paperTextureAmount: options.paperTextureAmount ?? 0.5,
        renderScale,
      });
    } catch (e) {
      // GPU 側で問題が起きても描画は止めない。壊れかけのキャッシュは破棄。
      clearDensityCache();
      if (!cpuFallback) throw e;
      console.warn("[stencil] WebGPU 描画に失敗したため CPU にフォールバックします", e);
    }
  }
  if (!cpuFallback) throw new Error("WebGPU is unavailable");
  return computeStencil(source, options);
}
