import React from "react";

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches unexpected React render errors so the window displays diagnostic
 * details and a recovery action instead of turning completely blank.
 */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="h-screen w-screen flex flex-col items-center justify-center bg-[#1e1e1e] text-[#e0e0e0] p-6 select-text">
          <div className="max-w-lg w-full border border-[#3f3f3f] bg-[#252526] p-5 space-y-3">
            <h2 className="text-sm font-semibold text-red-400">
              ScpCraft encountered a rendering error
            </h2>
            <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-[#1e1e1e] border border-[#333333] p-3 text-[#dcdcdc] max-h-60 overflow-auto">
              {this.state.error.message}
            </pre>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="px-3 py-1.5 bg-[#0e639c] hover:bg-[#1177bb] text-white text-xs font-medium"
              >
                Reload Window
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
