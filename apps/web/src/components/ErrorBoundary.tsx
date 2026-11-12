import { Component, type ReactNode } from 'react';

/** Last line of defence: if the page itself breaks, say so instead of going blank. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { broken: boolean }> {
  override state = { broken: false };

  static getDerivedStateFromError(): { broken: boolean } {
    return { broken: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error(error);
  }

  override render(): ReactNode {
    if (!this.state.broken) return this.props.children;
    return (
      <div className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-12">
        <h1 className="text-2xl font-semibold tracking-tight">Something broke on this page</h1>
        <p className="text-dim mt-2 text-sm leading-relaxed">
          Reloading usually fixes it. Your room is still there, and you’ll be put back in your seat.
        </p>
        <button className="btn btn-accent mt-8 self-start" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
