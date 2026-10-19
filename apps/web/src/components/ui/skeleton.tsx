import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function Skeleton({ className, ...props }: ComponentProps<'span'>) {
  return <span data-slot="skeleton" aria-hidden="true" className={cn('block rounded-md bg-muted motion-safe:animate-pulse', className)} {...props} />;
}
