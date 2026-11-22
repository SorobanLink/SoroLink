import { Suspense } from "react";
import { Dashboard } from "@/components/dashboard";
import { ErrorBoundary } from "@/components/error-boundary";

export default function Home() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<div className="shell loading-shell">Loading...</div>}>
        <Dashboard />
      </Suspense>
    </ErrorBoundary>
  );
}
