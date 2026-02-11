import {
  useRef,
  useEffect,
  useState,
  useImperativeHandle,
  useCallback,
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
  className?: string;
  style?: React.CSSProperties;
}

const THROTTLE_MS = 400;

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
    className,
    style,
  },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useImperativeHandle(ref, () => ({
    getCanvas: () => canvasRef.current,
  }));

  const [imageData, setImageData] = useState<ImageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 画像ロード（src / width / height 変更時のみ）
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

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

        setImageData(getImageData(img, outW, outH));
        setError(null);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(
          e instanceof Error ? e.message : "Failed to load image"
        );
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [src, width, height]);

  // throttle されたリソグラフ処理
  const lastRunRef = useRef(0);
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runProcess = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imageData) return;

    setProcessing(true);
    // requestAnimationFrame で描画をまとめる
    requestAnimationFrame(() => {
      processRisograph(imageData, canvas, {
        colors,
        dotSize,
        misregistration,
        grain,
        density,
        inkOpacity,
        paperColor,
        halftoneMode,
        noise,
      });
      setProcessing(false);
      lastRunRef.current = Date.now();
    });
  }, [imageData, colors, dotSize, misregistration, grain, density, inkOpacity, paperColor, halftoneMode, noise]);

  useEffect(() => {
    if (!imageData) return;

    const now = Date.now();
    const elapsed = now - lastRunRef.current;

    if (pendingRef.current) {
      clearTimeout(pendingRef.current);
    }

    if (elapsed >= THROTTLE_MS) {
      runProcess();
    } else {
      setProcessing(true);
      pendingRef.current = setTimeout(() => {
        runProcess();
        pendingRef.current = null;
      }, THROTTLE_MS - elapsed);
    }

    return () => {
      if (pendingRef.current) {
        clearTimeout(pendingRef.current);
      }
    };
  }, [runProcess, imageData]);

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
