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
} from "../lib/risograph";

export type { RisographColor };

export interface RisographCanvasHandle {
  getCanvas: () => HTMLCanvasElement | null;
}

export interface RisographCanvasProps {
  /** 画像ソースURL */
  src: string;
  /** スポットカラーの配列 */
  colors: RisographColor[];
  /** 出力幅 (px)。省略時は画像の元サイズ */
  width?: number;
  /** 出力高さ (px)。省略時はアスペクト比を維持 */
  height?: number;
  /** ハーフトーンのドットサイズ (px)。デフォルト: 4 */
  dotSize?: number;
  /** 版ずれの最大ピクセル量。デフォルト: 2 */
  misregistration?: number;
  /** ノイズの強度 (0-1)。デフォルト: 0.1 */
  grain?: number;
  /** canvas 要素に付与する className */
  className?: string;
  /** canvas 要素に付与する style */
  style?: React.CSSProperties;
}

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
    className,
    style,
  },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useImperativeHandle(ref, () => ({
    getCanvas: () => canvasRef.current,
  }));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;

    loadImage(src)
      .then((img) => {
        if (cancelled) return;

        // 出力サイズの決定
        let outW = width ?? img.naturalWidth;
        let outH = height ?? img.naturalHeight;

        // 幅のみ指定時はアスペクト比を維持
        if (width && !height) {
          outH = Math.round(
            (img.naturalHeight / img.naturalWidth) * width
          );
        }
        // 高さのみ指定時もアスペクト比を維持
        if (height && !width) {
          outW = Math.round(
            (img.naturalWidth / img.naturalHeight) * height
          );
        }

        const imageData = getImageData(img, outW, outH);

        processRisograph(imageData, canvas, {
          colors,
          dotSize,
          misregistration,
          grain,
        });

        setLoading(false);
        setError(null);
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
  }, [src, colors, width, height, dotSize, misregistration, grain]);

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
      {loading && (
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            color: "#666",
            fontSize: "14px",
          }}
        >
          Processing...
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
