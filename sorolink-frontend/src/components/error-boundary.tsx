"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

// #4 — Application-level error boundary wrapping the dashboard tree. Catches
// unexpected rendering errors and shows a recoverable branded fallback
// instead of crashing the whole dashboard. Internal details (message, stack)
// are only logged to the console, never rendered.

interface ErrorBoundaryProps {
  children: ReactNode;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Dashboard error boundary caught:", error, info.componentStack);
  }

  handleReset = () => {
    this.props.onReset?.();
    this.setState({ hasError: false });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="error-boundary" role="alert">
        <div className="error-boundary__card">
          <p className="eyebrow">Something went wrong</p>
          <h1>We hit an unexpected snag.</h1>
          <p>
            Part of the SoroLink dashboard failed to render. Try again, or reload
            the page if the problem persists.
          </p>
          <div className="error-boundary__actions">
            <button className="run-button" type="button" onClick={this.handleReset}>
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }
}
