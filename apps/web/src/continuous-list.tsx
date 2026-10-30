import { useEffect, useState } from 'react';
import { api, type Page } from './api';
import { useRevalidation } from './lifecycle';
import type { PagedDataCache } from './pagination';
import { Button } from './components/ui/button';

/** Fetch only this directory, in bounded batches; publish a complete snapshot atomically. */
export function useContinuousData<T extends { id: string }>(path: string, serial = 0, enabled = true, cache?: PagedDataCache<T>) {
  const revision = useRevalidation();
  const [attempt, retry] = useState(0);
  const [result, setResult] = useState<{ path: string; value: Page<T> }>();
  const [status, setStatus] = useState({ path: '', refreshing: true, error: '' });
  const [known, setKnown] = useState<Record<string, T>>({});
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setStatus({ path, refreshing: true, error: '' });
    const load = async () => {
      const items: T[] = [];
      const ids = new Set<string>();
      let expectedTotal: number | undefined;
      const url = new URL(path, location.origin);
      url.searchParams.set('pageSize', '100');
      for (let page = 1; ; page++) {
        url.searchParams.set('page', String(page));
        const value = await api<Page<T>>(url.pathname + url.search, 'GET', undefined, undefined, controller.signal);
        if (controller.signal.aborted) return;
        if (!Array.isArray(value.items) || !Number.isSafeInteger(value.total) || value.total < 0 ||
            value.items.some(item => !item || typeof item.id !== 'string' || ids.has(item.id))) {
          throw new Error('目录内容已变化，请重新加载。');
        }
        if (expectedTotal !== undefined && value.total !== expectedTotal) throw new Error('目录内容已变化，请重新加载。');
        expectedTotal = value.total;
        for (const item of value.items) {
          if (ids.has(item.id)) throw new Error('目录内容已变化，请重新加载。');
          ids.add(item.id); items.push(item);
        }
        if (items.length >= value.total) {
          if (items.length !== value.total) throw new Error('目录内容已变化，请重新加载。');
          const snapshot = { ...value, items };
          cache?.pages.set(path, snapshot);
          setResult({ path, value: snapshot });
          setKnown(current => ({ ...current, ...Object.fromEntries(items.map(item => [item.id, item])) }));
          return;
        }
        if (!value.items.length) throw new Error('目录未加载完整，请重新加载。');
      }
    };
    void load().then(() => {
      if (!controller.signal.aborted) setStatus({ path, refreshing: false, error: '' });
    }).catch((failure: Error) => {
      if (!controller.signal.aborted) setStatus({ path, refreshing: false, error: failure.message });
    });
    return () => controller.abort();
  }, [path, serial, enabled, cache, revision, attempt]);
  const current = result?.path === path ? result.value : cache?.pages.get(path);
  const error = status.path === path ? status.error : '';
  const refreshing = enabled && (status.path !== path || status.refreshing);
  return { data: current?.items ?? [], total: current?.total ?? 0, known, error,
    loading: enabled && !current && !error, refreshing,
    retry: () => retry(value => value + 1) };
}

export function ContinuousListStatus({ refreshing, error, retry }: {
  refreshing: boolean; error: string; retry: () => void;
}) {
  if (!refreshing && !error) return null;
  return <div className="flex items-center justify-center gap-3 py-4" role="status">
    {refreshing ? '正在加载目录…' : <><span>目录未能更新</span><Button variant="bordered" size="sm" onClick={retry}>重新加载</Button></>}
  </div>;
}
