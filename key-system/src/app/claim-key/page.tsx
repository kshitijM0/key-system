"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

function ClaimKeyInner() {
  const params = useSearchParams();
  const hash = params.get("hash");

  const [state, setState] = useState<"loading" | "success" | "error">("loading");
  const [key, setKey] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    if (!hash) {
      setState("error");
      setErrorMsg("No verification hash found in the URL.");
      return;
    }

    fetch("/api/claim-free-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hash }),
    })
      .then(async (res) => {
        const data = await res.json();
        if (res.ok) {
          setKey(data.key);
          setState("success");
        } else {
          setErrorMsg(data.error ?? "Could not verify.");
          setState("error");
        }
      })
      .catch(() => {
        setErrorMsg("Network error. Please try again.");
        setState("error");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash]);

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center justify-center p-6">
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 w-full max-w-sm text-center space-y-4">
        {state === "loading" && <p>Verifying...</p>}

        {state === "success" && key && (
          <>
            <h1 className="text-lg font-semibold text-emerald-400">
              Here&apos;s your free key
            </h1>
            <p className="font-mono text-sm bg-neutral-800 rounded-lg py-2 px-3 select-all">
              {key}
            </p>
            <p className="text-xs text-neutral-500">Valid for 48 hours.</p>
            <a
              href="/"
              className="inline-block mt-2 text-sm underline underline-offset-4 text-neutral-300"
            >
              Go use it
            </a>
          </>
        )}

        {state === "error" && (
          <>
            <h1 className="text-lg font-semibold text-red-400">Couldn&apos;t verify</h1>
            <p className="text-sm text-neutral-400">{errorMsg}</p>
            <a
              href="/"
              className="inline-block mt-2 text-sm underline underline-offset-4 text-neutral-300"
            >
              Back to home
            </a>
          </>
        )}
      </div>
    </main>
  );
}

export default function ClaimKeyPage() {
  return (
    <Suspense fallback={null}>
      <ClaimKeyInner />
    </Suspense>
  );
}
