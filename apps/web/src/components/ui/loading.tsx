import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Skeleton } from "./skeleton";

export type LoadingVariant = "page" | "form" | "table" | "cards" | "list" | "detail" | "inline" | "chart";
type LoadingProps = {
  label?: string;
  description?: ReactNode;
  className?: string;
  size?: "sm" | "md";
  variant?: LoadingVariant;
  rows?: number;
};

function Shapes({ variant, rows }: { variant: LoadingVariant; rows: number }) {
  if (variant === "inline") return <div className="flex w-full items-center gap-3"><Skeleton className="h-4 w-32" /><Skeleton className="h-4 w-16" /></div>;
  if (variant === "cards") return <div className="grid w-full grid-cols-2 content-start gap-6 sm:grid-cols-3 xl:grid-cols-4">
    {Array.from({ length: rows }, (_, index) => <div className="min-w-0 space-y-4 p-3" key={index}>
      <Skeleton className="aspect-[16/11] w-full rounded-2xl" /><Skeleton className="mx-auto h-4 w-2/3" />
    </div>)}
  </div>;
  if (variant === "table") return <div className="w-full space-y-4">
    <Skeleton className="h-10 w-full rounded-full" />
    {Array.from({ length: rows }, (_, index) => <div className="grid min-h-10 grid-cols-[minmax(0,2fr)_1fr_1fr] items-center gap-6 px-3 sm:grid-cols-[minmax(0,2fr)_1fr_1fr_1fr]" key={index}>
      <Skeleton className="h-4 w-4/5" /><Skeleton className="h-4 w-2/3" /><Skeleton className="h-4 w-3/4" /><Skeleton className="hidden h-4 w-2/3 sm:block" />
    </div>)}
  </div>;
  if (variant === "form") return <div className="grid w-full gap-6">
    {Array.from({ length: rows }, (_, index) => <div className="space-y-3" key={index}><Skeleton className="h-4 w-24" /><Skeleton className="h-10 w-full max-w-lg rounded-full" /></div>)}
    <Skeleton className="h-10 w-28 rounded-full" />
  </div>;
  if (variant === "detail") return <div className="grid w-full gap-5 sm:grid-cols-2">
    {Array.from({ length: rows }, (_, index) => <div className="space-y-3" key={index}><Skeleton className="h-4 w-24" /><Skeleton className="h-8 w-32" /><Skeleton className="h-3 w-3/4" /></div>)}
  </div>;
  if (variant === "chart") return <div className="flex h-40 w-full items-end gap-2" aria-hidden="true">
    {[45, 70, 35, 90, 60, 80, 50, 65, 40, 75, 55, 85].map((height, index) => <Skeleton key={index} className="min-w-0 flex-1 rounded-sm" style={{ height: `${height}%` }} />)}
  </div>;
  return <div className="w-full space-y-5">
    {Array.from({ length: rows }, (_, index) => <div className="flex min-w-0 items-center gap-4" key={index}>
      <Skeleton className="size-10 shrink-0 rounded-xl" /><div className="min-w-0 flex-1 space-y-3"><Skeleton className="h-4 w-2/3 max-w-80" /><Skeleton className="h-3 w-1/3 max-w-48" /></div><Skeleton className="h-4 w-12 shrink-0" />
    </div>)}
  </div>;
}

function Loading({ label = "正在加载", description, className, size = "md", variant = "list", rows }: LoadingProps) {
  const count = rows ?? (variant === "form" || variant === "detail" ? 2 : size === "sm" ? 3 : 5);
  return <div data-slot="loading-skeleton" data-variant={variant} role="status" aria-live="polite" aria-label={label} aria-busy="true"
    className={cn("min-w-0 w-full", variant === "page" ? "grid min-h-dvh grid-cols-1 bg-background lg:grid-cols-[15rem_minmax(0,1fr)]" : size === "sm" ? "py-3" : "py-4", className)}>
    <span className="sr-only">{label}{description && <> · {description}</>}</span>
    {variant === "page" ? <>
      <div className="hidden space-y-9 bg-card p-8 lg:block"><Skeleton className="h-6 w-28" /><Shapes variant="list" rows={4} /></div>
      <div className="min-w-0 space-y-8 p-5 lg:p-10"><div className="space-y-3"><Skeleton className="h-7 w-36" /><Skeleton className="h-4 w-2/3 max-w-96" /></div><div className="rounded-card bg-card p-6"><Shapes variant="detail" rows={3} /></div><div className="rounded-card bg-card p-6"><Shapes variant="table" rows={5} /></div></div>
    </> : <Shapes variant={variant} rows={count} />}
  </div>;
}

function LoadingText({ label, className }: { label: string; className?: string }) {
  return <span role="status" aria-label={label} className={cn("inline-flex items-center gap-2", className)}><span className="sr-only">{label}</span><Skeleton className="h-3 w-20" /><Skeleton className="h-3 w-8" /></span>;
}

export { Loading, LoadingText };
