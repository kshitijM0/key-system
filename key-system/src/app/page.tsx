"use client";

import { useEffect, useState } from "react";

// Replace with your real Linkvertise monetized link (the one you generated
// with the destination pointing at https://yourdomain.com/claim-key)
const LINKVERTISE_URL = "https://link-hub.net/8236285/ApjF6y0XD5CV";

const STORAGE_KEY = "km_access_key";

export default function Home() {
  const [showPopup, setShowPopup] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [status, setStatus] = useState<"idle" | "checking" | "invalid" | "valid">(
    "idle"
  );
  const [unlocked, setUnlocked] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      checkKey(stored, true);
    } else {
      setShowPopup(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function checkKey(key: string, silent = false) {
    if (!silent) setStatus("checking");
    try {
      const res = await fetch("/api/validate-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const data = await res.json();
      if (data.valid) {
        setStatus("valid");
        setUnlocked(true);
        setShowPopup(false);
        localStorage.setItem(STORAGE_KEY, key);
      } else {
        setStatus("invalid");
        localStorage.removeItem(STORAGE_KEY);
        if (silent) setShowPopup(true);
      }
    } catch {
      setStatus("invalid");
    }
  }

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center justify-center p-6">
      {unlocked ? (
        <div className="text-center space-y-3">
          <h1 className="text-2xl font-semibold">Access unlocked</h1>
          <p className="text-neutral-400">Your protected content goes here.</p>
        </div>
      ) : (
        <h1 className="text-2xl font-semibold text-neutral-500">Locked</h1>
      )}

      {showPopup && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4">
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 w-full max-w-sm space-y-4">
            <h2 className="text-lg font-semibold">Enter your key</h2>

            <input
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="KM-XXXX-XXXX-XXXX-XXXX"
              className="w-full rounded-lg bg-neutral-800 border border-neutral-700 px-3 py-2 text-sm outline-none focus:border-neutral-500"
            />

            {status === "invalid" && (
              <p className="text-red-400 text-sm">
                Key is invalid or expired. Try again or get a free key below.
              </p>
            )}

            <button
              onClick={() => checkKey(keyInput)}
              disabled={status === "checking" || !keyInput}
              className="w-full rounded-lg bg-neutral-100 text-neutral-900 font-medium py-2 text-sm disabled:opacity-50"
            >
              {status === "checking" ? "Checking..." : "Unlock"}
            </button>

            <div className="pt-2 border-t border-neutral-800 text-center">
              <a
                href={LINKVERTISE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-emerald-400 hover:text-emerald-300 underline underline-offset-4"
              >
                Get key for free
              </a>
              <p className="text-xs text-neutral-500 mt-1">
                Complete a few steps to get a free 48-hour key.
              </p>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
