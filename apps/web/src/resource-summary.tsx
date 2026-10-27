import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

type ResourceSummaryProps = {
  icon: LucideIcon;
  title: string;
  primary: ReactNode;
  primaryTitle?: string;
  primaryTestId?: string;
  secondary: ReactNode;
  detail: ReactNode;
  note: ReactNode;
  children?: ReactNode;
  className?: string;
};

export function ResourceSummary({ icon: Icon, title, primary, primaryTitle, primaryTestId,
  secondary, detail, note, children, className }: ResourceSummaryProps) {
  return <Card className={cn('mb-card-gap p-card-padding', className)}>
    <div className="min-w-0 space-y-3">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="size-4 shrink-0" />
        <h2 className="text-sm font-medium">{title}</h2>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <strong className="text-3xl font-semibold tabular-nums" title={primaryTitle} data-testid={primaryTestId}>{primary}</strong>
        <span className="text-sm text-muted-foreground">{secondary}</span>
      </div>
      <p className="text-sm text-muted-foreground">{detail}</p>
      <p className="text-xs leading-relaxed text-muted-foreground">{note}</p>
      {children}
    </div>
  </Card>;
}
