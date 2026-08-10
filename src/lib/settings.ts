import type { StencilColor, HalftoneMode, PaperTexture } from "./stencil";
import type { ToneCurves } from "./curve";

export type PaperShape =
  | "original"
  | "square"
  | "portrait-a"
  | "portrait-2x3"
  | "portrait-3x4"
  | "portrait-4x5"
  | "landscape-a"
  | "landscape-3x2"
  | "landscape-4x3"
  | "landscape-5x4"
  | "widescreen";

/**
 * 復元対象の設定一式（画像は含めない）。
 * 履歴（サムネ付き）と Undo/Redo が共有する。
 */
export interface StencilSettings {
  colors: StencilColor[];
  dotSize: number;
  misregistration: number;
  density: number;
  inkOpacity: number;
  paperColor: string;
  halftoneMode: HalftoneMode;
  /** 色分解の強さ 0–1（0=忠実 / 1=グラフィック） */
  separation: number;
  blackGeneration?: number;
  highlightCutoff: number;
  paperTexture: PaperTexture;
  paperTextureAmount: number;
  /** 写真の短辺に対する四辺の用紙余白（0–0.5） */
  paperMargin: number;
  /** 用紙の縦横比プリセット。original は写真の形状を基準にする。 */
  paperShape: PaperShape;
  noise: number;
  transparentBg: boolean;
  /** トーンカーブ（色分解の手前で入力画像を整える。反転もこれで表す） */
  curves: ToneCurves;
}
