import {
  useRef,
  useEffect,
  useState,
  useImperativeHandle,
  forwardRef,
} from "react";
import {
  loadImage,
  getImageData,
  type StencilColor,
  type HalftoneMode,
  type PaperTexture,
} from "../lib/stencil";
import { renderStencilPixels, getGpuDevice } from "../lib/stencilRenderer";

export type { StencilColor, HalftoneMode, PaperTexture };

export interface StencilCanvasHandle {
  getCanvas: () => HTMLCanvasElement | null;
}

export interface StencilCanvasProps {
  src: string;
  colors: StencilColor[];
  width?: number;
  height?: number;
  dotSize?: number;
  misregistration?: number;
  grain?: number;
  density?: number;
  inkOpacity?: number;
  paperColor?: string;
  halftoneMode?: HalftoneMode;
  /** 色分解の強さ 0–1（0=忠実 / 1=グラフィック） */
  separation?: number;
  blackGeneration?: number;
  highlightCutoff?: number;
  paperTexture?: PaperTexture;
  paperTextureAmount?: number;
  noise?: number;
  transparentBg?: boolean;
  invert?: boolean;
  /** トーンカーブ LUT（256×3）。色分解の手前で入力画像へ適用する。 */
  toneLut?: Uint8Array;
  /**
   * 描画スケール。ドットサイズ・版ずれ・テクスチャ等を一律この倍率へ比例させる。
   * width を上げて内部解像度を上げつつ renderScale を同じ倍率にすると、見た目
   * （網点サイズ等）はそのままで解像感だけ上がる（ダウンロードの 2x/4x と同じ理屈）。
   */
  renderScale?: number;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * スライダー操作が止まってからの待ち時間。
 * CPU 実装は 1 枚あたり数百 ms かかるので長めに待つ必要があるが、WebGPU なら
 * 合成が 20ms 程度なので待ち時間の方が支配的になる。GPU が使える環境では短くして
 * 操作にほぼ追従させる。
 */
const DEBOUNCE_MS = 300;
const DEBOUNCE_MS_GPU = 60;

export const StencilCanvas = forwardRef<
  StencilCanvasHandle,
  StencilCanvasProps
>(function StencilCanvas(
  {
    src,
    colors,
    width,
    height,
    dotSize = 4,
    misregistration = 2,
    grain = 0.1,
    density = 1,
    inkOpacity = 0.85,
    paperColor,
    halftoneMode,
    separation = 0,
    blackGeneration = 0.7,
    highlightCutoff = 0,
    paperTexture = "felt",
    paperTextureAmount = 0.5,
    noise = 0,
    transparentBg = false,
    invert = false,
    toneLut,
    renderScale = 1,
    className,
    style,
  },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // 非同期描画の追い越し防止（最新の描画だけを採用する）
  const renderRunRef = useRef(0);
  // WebGPU が使えるか（デバウンス時間の切り替えに使う）
  const gpuReadyRef = useRef(false);
  useEffect(() => {
    let alive = true;
    getGpuDevice().then((d) => { if (alive) gpuReadyRef.current = !!d; });
    return () => { alive = false; };
  }, []);

  useImperativeHandle(ref, () => ({
    getCanvas: () => canvasRef.current,
  }));

  // 画像ロード: loaded.src と現在の src を比較して loading を派生
  const [loaded, setLoaded] = useState<{ src: string; data: ImageData } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const imageData = loaded && loaded.src === src ? loaded.data : null;
  const loading = !imageData && !error;

  // src が変わったら前のエラーを捨てる。残したままだと loading の判定
  // （!imageData && !error）が false になり、新しい画像の読み込み中に古いエラーが
  // 出たままインジケータも出ない。effect ではなくレンダー中に調整する。
  const [prevSrc, setPrevSrc] = useState(src);
  if (prevSrc !== src) {
    setPrevSrc(src);
    setError(null);
  }

  useEffect(() => {
    let cancelled = false;

    loadImage(src)
      .then((img) => {
        if (cancelled) return;

        let outW = width ?? img.naturalWidth;
        let outH = height ?? img.naturalHeight;

        if (width && !height) {
          outH = Math.round(
            (img.naturalHeight / img.naturalWidth) * width
          );
        }
        if (height && !width) {
          outW = Math.round(
            (img.naturalWidth / img.naturalHeight) * height
          );
        }

        setLoaded({ src, data: getImageData(img, outW, outH) });
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(
          e instanceof Error ? e.message : "Failed to load image"
        );
      });

    return () => {
      cancelled = true;
    };
  }, [src, width, height]);

  // 処理パラメータのキーを生成し、完了キーと比較して processing を派生
  const paramsKey = [
    dotSize, density, inkOpacity, halftoneMode, separation, blackGeneration, highlightCutoff, paperTexture, paperTextureAmount, noise, misregistration,
    transparentBg, invert, paperColor, grain, renderScale, toneLut,
    colors.map((c) => c.color).join(","),
  ].join("|");
  const [processedKey, setProcessedKey] = useState("");
  const processing = imageData !== null && processedKey !== paramsKey;
  const hasRendered = processedKey !== "";

  // 最新パラメータを ref で保持
  const paramsRef = useRef({
    colors, dotSize, misregistration, grain, density, inkOpacity, paperColor, halftoneMode, separation, blackGeneration, highlightCutoff, paperTexture, paperTextureAmount, noise, transparentBg, invert, toneLut, renderScale,
  });
  useEffect(() => {
    paramsRef.current = {
      colors, dotSize, misregistration, grain, density, inkOpacity, paperColor, halftoneMode, separation, blackGeneration, highlightCutoff, paperTexture, paperTextureAmount, noise, transparentBg, invert, toneLut, renderScale,
    };
  });

  // debounce でステンシル印刷処理を実行
  useEffect(() => {
    if (!imageData) return;

    const timerId = setTimeout(() => {
      setTimeout(async () => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const p = paramsRef.current;
        // 連続操作で古い描画が後から届いても上書きしないよう、最新のみ採用する
        const myRun = ++renderRunRef.current;
        try {
          const pixels = await renderStencilPixels(imageData, {
            colors: p.colors,
            dotSize: p.dotSize,
            misregistration: p.misregistration,
            grain: p.grain,
            density: p.density,
            inkOpacity: p.inkOpacity,
            paperColor: p.paperColor,
            halftoneMode: p.halftoneMode,
            separation: p.separation,
            blackGeneration: p.blackGeneration,
            highlightCutoff: p.highlightCutoff,
            paperTexture: p.paperTexture,
            paperTextureAmount: p.paperTextureAmount,
            noise: p.noise,
            transparentBg: p.transparentBg,
            invert: p.invert,
            toneLut: p.toneLut,
            renderScale: p.renderScale,
          });
          if (myRun !== renderRunRef.current) return; // 追い越された
          const { width, height } = imageData;
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d")!;
          const outputData = ctx.createImageData(width, height);
          outputData.data.set(pixels);
          ctx.putImageData(outputData, 0, 0);
          setProcessedKey(paramsKey);
        } catch (e) {
          console.error("[stencil] 描画に失敗しました", e);
        }
      }, 0);
    }, gpuReadyRef.current ? DEBOUNCE_MS_GPU : DEBOUNCE_MS);

    return () => {
      clearTimeout(timerId);
    };
  }, [imageData, paramsKey]);

  const showIndicator = loading || processing;

  return (
    <div style={{
      position: "relative",
      display: "inline-block",
      maxWidth: "100%",
      opacity: hasRendered ? 1 : 0,
      transition: "opacity 0.3s",
    }}>
      <canvas
        ref={canvasRef}
        className={className}
        style={{
          display: "block",
          maxWidth: "100%",
          height: "auto",
          ...style,
        }}
      />
      {hasRendered && showIndicator && (
        <div
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            background: "rgba(0,0,0,0.5)",
            color: "#fff",
            fontSize: "11px",
            lineHeight: 1.4,
            whiteSpace: "nowrap",
            padding: "3px 8px",
            borderRadius: "4px",
            pointerEvents: "none",
          }}
        >
          {loading ? "Loading..." : "Processing..."}
        </div>
      )}
      {error && (
        <div
          style={{
            padding: "20px",
            color: "#c00",
            fontSize: "14px",
            lineHeight: 1.5,
            textAlign: "center",
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
});
