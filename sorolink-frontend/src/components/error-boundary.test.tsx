import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ErrorBoundary } from "./error-boundary";

let shouldThrow = true;

function Bomb() {
  if (shouldThrow) throw new Error("secret internal failure");
  return <span>dashboard content</span>;
}

describe("ErrorBoundary (#4)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    shouldThrow = true;
  });

  it("renders children when nothing throws", () => {
    shouldThrow = false;
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText("dashboard content")).toBeInTheDocument();
  });

  it("renders the branded fallback with a Try again action on throw", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText("We hit an unexpected snag.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByText("dashboard content")).not.toBeInTheDocument();
  });

  it("does not expose the error message or stack trace to users", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(container.textContent).not.toContain("secret internal failure");
    expect(container.textContent).not.toMatch(/at Bomb|\.tsx:\d+/);
  });

  it("logs the error with console.error", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "Dashboard error boundary caught:",
      expect.objectContaining({ message: "secret internal failure" }),
      expect.anything(),
    );
  });

  it("recovers when Try again is clicked and the error is resolved", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onReset = vi.fn();
    render(
      <ErrorBoundary onReset={onReset}>
        <Bomb />
      </ErrorBoundary>,
    );
    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(screen.getByText("dashboard content")).toBeInTheDocument();
  });
});
