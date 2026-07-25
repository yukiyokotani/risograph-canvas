import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 画面全体が真っ白になるのを防ぐ最小限のエラーバウンダリ。
 *
 * 描画中に例外が出ると React はツリーごとアンマウントするため、何も出ない
 * 画面だけが残る。ここで受け止めて、何が起きたかと復帰手段（再読み込み）を出す。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[stencil] 予期しないエラーで画面を復帰できませんでした", error, info);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          display: "flex",
          minHeight: "100dvh",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          fontFamily: "system-ui, sans-serif",
          background: "#141414",
          color: "#e8e4dc",
        }}
      >
        <div style={{ maxWidth: 420 }}>
          <h1 style={{ fontSize: 18, margin: "0 0 8px", fontWeight: 600 }}>
            Something went wrong
          </h1>
          <p style={{ fontSize: 14, lineHeight: 1.6, margin: "0 0 16px", opacity: 0.75 }}>
            Reload the page to start over. Your image is only held in this tab, so
            you will need to choose it again.
          </p>
          <pre
            style={{
              fontSize: 11,
              lineHeight: 1.5,
              margin: "0 0 16px",
              padding: 10,
              overflowX: "auto",
              borderRadius: 6,
              background: "#00000055",
              opacity: 0.7,
            }}
          >
            {error.message}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              cursor: "pointer",
              borderRadius: 6,
              border: "1px solid #ffffff33",
              background: "transparent",
              color: "inherit",
              fontSize: 13,
              padding: "8px 14px",
            }}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
