import {
  useRef,
  useEffect,
  useState,
  useImperativeHandle,
  forwardRef,
} from "react";
import {
  processRisograph,
  loadImage,
  getImageData,
  type RisographColor,
  type HalftoneMode,
} from "../lib/risograph";

export type { RisographColor, HalftoneMode };

export interface RisographCanvasHandle {
  getCanvas: () => HTMLCanvasElement | null;
}

export interface RisographCanvasProps {
  src: string;
  colors: RisographColor[];
  width?: number;
  height?: number;
  dotSize?: number;
  misregistration?: number;
  grain?: number;
  density?: number;
  inkOpacity?: number;
  paperColor?: string;
  halftoneMode?: HalftoneMode;
  noise?: number;
  transparentBg?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

/** スライダー操作が止まってからの待ち時間 */
const DEBOUNCE_MS = 300;

export const RisographCanvas = forwardRef<
  RisographCanvasHandle,
  RisographCanvasProps
>(function RisographCanvas(
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
    noise = 0,
    transparentBg = false,
    className,
    style,
  },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useImperativeHandle(ref, () => ({
    getCanvas: () => canvasRef.current,
  }));

  // 画像ロード: loaded.src と現在の src を比較して loading を派生
  const [loaded, setLoaded] = useState<{ src: string; data: ImageData } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const imageData = loaded && loaded.src === src ? loaded.data : null;
  const loading = !imageData && !error;

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
    dotSize, density, inkOpacity, halftoneMode, noise, misregistration,
    transparentBg, paperColor, grain,
    colors.map((c) => c.color).join(","),
  ].join("|");
  const [processedKey, setProcessedKey] = useState("");
  const processing = imageData !== null && processedKey !== paramsKey;

  // 最新パラメータを ref で保持
  const paramsRef = useRef({
    colors, dotSize, misregistration, grain, density, inkOpacity, paperColor, halftoneMode, noise, transparentBg,
  });
  useEffect(() => {
    paramsRef.current = {
      colors, dotSize, misregistration, grain, density, inkOpacity, paperColor, halftoneMode, noise, transparentBg,
    };
  });

  // debounce でリソグラフ処理を実行
  useEffect(() => {
    if (!imageData) return;

    const timerId = setTimeout(() => {
      setTimeout(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const p = paramsRef.current;
        processRisograph(imageData, canvas, {
          colors: p.colors,
          dotSize: p.dotSize,
          misregistration: p.misregistration,
          grain: p.grain,
          density: p.density,
          inkOpacity: p.inkOpacity,
          paperColor: p.paperColor,
          halftoneMode: p.halftoneMode,
          noise: p.noise,
          transparentBg: p.transparentBg,
        });
        setProcessedKey(paramsKey);
      }, 0);
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timerId);
    };
  }, [imageData, paramsKey]);

  const showIndicator = loading || processing;

  return (
    <div style={{ position: "relative", display: "inline-block", maxWidth: "100%" }}>
      <canvas
        ref={canvasRef}
        className={className}
        style={{
          display: "block",
          maxWidth: "100%",
          height: "auto",
          opacity: loading ? 0.3 : 1,
          transition: "opacity 0.3s",
          ...style,
        }}
      />
      {showIndicator && (
        <div
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            background: "rgba(0,0,0,0.5)",
            color: "#fff",
            fontSize: "11px",
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
            textAlign: "center",
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
});
