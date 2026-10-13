import { useRef } from "react";

/** Pointer and keyboard operated divider; the owner decides panel constraints. */
export function ResizeHandle({ label, value, onResize }: {
  label: string;
  value: number;
  onResize: (deltaPixels: number) => void;
}) {
  const lastX = useRef<number | null>(null);
  return <div role="separator" aria-label={label} aria-orientation="vertical"
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)} tabIndex={0}
    className="flex h-full w-1.5 touch-none cursor-col-resize items-center justify-center bg-resize outline-none hover:bg-resize-hover focus-visible:bg-resize-focus"
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      lastX.current = event.clientX;
    }}
    onPointerMove={(event) => {
      if (lastX.current === null) return;
      const delta = event.clientX - lastX.current;
      lastX.current = event.clientX;
      onResize(delta);
    }}
    onPointerUp={(event) => {
      lastX.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={() => { lastX.current = null; }}
    onLostPointerCapture={() => { lastX.current = null; }}
    onKeyDown={(event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      onResize((event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 40 : 10));
    }}>
  </div>;
}
