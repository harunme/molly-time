import { useRevalidation } from "./lifecycle";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useEffect, useState } from 'react';
import { Pagination as PaginationRoot, PaginationNext, PaginationPrevious } from "@/components/ui/pagination";
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { SelectField } from "@/components/ui/select";
import { api, type Page, type ResourceOption } from './api';

export function useDebounced(value: string, delay = 300) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

export type PagedDataCache<T, Response extends Page<T> = Page<T>> = {
  pages: Map<string, Response>;
  positions: Map<string, number>;
};

export function usePagedData<T extends { id: string; }, Response extends Page<T> = Page<T>>(path: string, serial = 0, pageSize = 20, enabled = true, remember = false, cache?: PagedDataCache<T, Response>) {
  const revision = useRevalidation();
  const [position, setPosition] = useState(() => ({ path, page: cache?.positions.get(path) ?? 1 }));
  const page = position.path === path ? position.page : 1;
  const setPage = (next: number) => {
    cache?.positions.set(path, next);
    setPosition({ path, page: next });
  };
  const key = `${path}|${page}|${pageSize}`;
  const [result, setResult] = useState<{ key: string; value: Response; }>();
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(true);
  const [known, setKnown] = useState<Record<string, T>>({});
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const url = new URL(path, location.origin);
    url.searchParams.set('page', String(page));
    url.searchParams.set('pageSize', String(pageSize));
    setRefreshing(true); setError('');
    api<Response>(url.pathname + url.search, 'GET', undefined, undefined, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(value.items) || !Number.isSafeInteger(value.total) || value.total < 0) {
          throw new Error('列表加载失败，请稍后重新进入此页。');
        }
        const last = Math.max(1, Math.ceil(value.total / pageSize));
        if (page > last) { cache?.positions.set(path, last); setPosition({ path, page: last }); return; }
        cache?.pages.set(key, value);
        setResult({ key, value });
        if (remember) setKnown((current) => ({ ...current, ...Object.fromEntries(value.items.map((item) => [item.id, item])) }));
      })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); })
      .finally(() => { if (!controller.signal.aborted) setRefreshing(false); });
    return () => controller.abort();
  }, [path, page, pageSize, serial, key, enabled, remember, cache, revision]);
  const current = result?.key === key ? result.value : cache?.pages.get(key);
  return {
    response: current, data: current?.items ?? [], total: current?.total ?? 0, page, pageSize, setPage,
    known, error, loading: enabled && !current && !error, refreshing: enabled && refreshing
  };
}

export function Pagination({ page, pageSize = 20, total, setPage, loading = false, label = '列表分页' }: {
  page: number; pageSize?: number; total: number; setPage: (page: number) => void; loading?: boolean; label?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (loading && !total) return null;
  return <PaginationRoot className="pagination" aria-label={label}>
    <span className="pagination-total">共 {total} 条</span>
    <PaginationPrevious type="button" variant="bordered" size="sm" aria-label={`${label}：上一页`} disabled={loading || page <= 1} onClick={() => setPage(page - 1)} />
    <span aria-live="polite" className="pagination-position">第 {page} / {pages} 页</span>
    <PaginationNext type="button" variant="bordered" size="sm" aria-label={`${label}：下一页`} disabled={loading || page >= pages} onClick={() => setPage(page + 1)} />
  </PaginationRoot>;
}

export function ResourcePicker({ value = '', onChange, placeholder, label, exclude = [], initial, parentId, resourceType }: {
  value?: string; onChange: (id: string, item?: ResourceOption) => void; placeholder: string; label: string;
  exclude?: string[]; initial?: ResourceOption; parentId?: string; resourceType?: "Season";
}) {
  const [search, setSearch] = useState('');
  const query = useDebounced(search);
  const list = usePagedData<ResourceOption>(`/resources?summary=true&q=${encodeURIComponent(query)}${parentId ? `&parentId=${encodeURIComponent(parentId)}` : ""}${resourceType ? `&resourceType=${resourceType}` : ""}`, 0, 20, true, true);
  const selected = list.known[value] ?? (initial?.id === value ? initial : undefined);
  return <div className="paged-picker">
    <Input aria-label="检索候选名称" placeholder={resourceType === "Season" ? "搜索季名称…" : "搜索动画片名称…"} value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} />
    {list.loading && !selected ? <div role="status" aria-label="正在加载候选资源"><Skeleton className="h-control w-full rounded-full" /></div> : <SelectField aria-label={label} value={value} disabled={list.loading} onValueChange={(value) => onChange(value, list.known[value])} options={[({ value: "", label: <> {placeholder} </> }), selected && !list.data.some((item) => item.id === value) && ({ value: value, label: <> {selected.name} </> }), list.data.filter((item) => !exclude.includes(item.id) || item.id === value).map((item) => ({ value: item.id, label: <> {item.name}{item.status !== 'published' ? '（未发布）' : ''} </> }))]} />}
    {list.error && <Alert variant="destructive" role="alert" className="error"><AlertDescription>{list.error}</AlertDescription></Alert>}
    <Pagination {...list} loading={list.refreshing} label="候选资源分页" />
  </div>;
}
