"use client";

// Liquid-glass toast notifications. No dependency: a module-level event bus
// (`toast(...)` is callable from anywhere, including non-React code) and one
// <Toaster /> mounted in the root layout that portals the stack to <body>.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./Toaster.module.css";

export type ToastKind = "success" | "error" | "info";

interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
  leaving?: boolean;
}

type Listener = (t: Omit<ToastItem, "id">) => void;
let listener: Listener | null = null;
const queue: Omit<ToastItem, "id">[] = [];

export function toast(kind: ToastKind, title: string, detail?: string): void {
  if (listener) listener({ kind, title, detail });
  else queue.push({ kind, title, detail }); // fired before mount — deliver on mount
}

const ICONS: Record<ToastKind, string> = { success: "✓", error: "✕", info: "•" };
const AUTO_DISMISS_MS = 5000;
const LEAVE_MS = 260;

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    let nextId = 1;
    const dismiss = (id: number) => {
      setItems((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
      setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), LEAVE_MS);
    };
    listener = (t) => {
      const id = nextId++;
      setItems((prev) => [...prev.slice(-3), { ...t, id }]); // max 4 on screen
      setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    };
    for (const t of queue.splice(0)) listener(t);
    return () => {
      listener = null;
    };
  }, []);

  if (!mounted) return null;
  return createPortal(
    <div className={styles.stack} role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={styles.toast} data-kind={t.kind} data-leaving={t.leaving || undefined}>
          <span className={styles.icon} data-kind={t.kind}>
            {ICONS[t.kind]}
          </span>
          <span className={styles.body}>
            <span className={styles.title}>{t.title}</span>
            {t.detail && <span className={styles.detail}>{t.detail}</span>}
          </span>
          <button
            type="button"
            className={styles.close}
            aria-label="Dismiss"
            onClick={() => {
              setItems((prev) => prev.map((x) => (x.id === t.id ? { ...x, leaving: true } : x)));
              setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== t.id)), LEAVE_MS);
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
