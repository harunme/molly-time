import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { api, type Page, type ResourceOption } from './api';

export function useDebounced(value: string, delay = 300) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

export function usePagedData<T extends { id: string }>(path: string, serial = 0, pageSize = 20, enabled = true, remember = false) {
  const [position, setPosition] = useState({ path, page: 1 });
  const page = position.path === path ? position.page : 1;
  const setPage = (next: number) => setPosition({ path, page: next });
  const key = `${path}|${page}|${pageSize}`;
  const [result, setResult] = useState<{ key: string; value: Page<T> }>();
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
    api<Page<T>>(url.pathname + url.search, 'GET', undefined, undefined, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(value.items) || !Number.isSafeInteger(value.total) || value.total < 0) {
          throw new Error('列表加载失败，请稍后重新进入此页。');
        }
        const last = Math.max(1, Math.ceil(value.total / pageSize));
        if (page > last) { setPosition({ path, page: last }); return; }
        setResult({ key, value });
        if (remember) setKnown((current) => ({ ...current, ...Object.fromEntries(value.items.map((item) => [item.id, item])) }));
      })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); })
      .finally(() => { if (!controller.signal.aborted) setRefreshing(false); });
    return () => controller.abort();
  }, [path, page, pageSize, serial, key, enabled, remember]);
  const current = result?.key === key ? result.value : undefined;
  return { data: current?.items ?? [], total: current?.total ?? 0, page, pageSize, setPage,
    known, error, loading: enabled && !current && !error, refreshing: enabled && refreshing };
}

export function Pagination({ page, pageSize = 20, total, setPage, loading = false, label = '列表分页' }: {
  page: number; pageSize?: number; total: number; setPage: (page: number) => void; loading?: boolean; label?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (loading && !total) return null;
  return <nav className="pagination" aria-label={label}>
    <span className="pagination-total">共 {total} 条</span>
    <Button type="button" variant="outline" size="sm" aria-label={`${label}：上一页`} disabled={loading || page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft />上一页</Button>
    <span aria-live="polite" className="pagination-position">第 {page} / {pages} 页</span>
    <Button type="button" variant="outline" size="sm" aria-label={`${label}：下一页`} disabled={loading || page >= pages} onClick={() => setPage(page + 1)}>下一页<ChevronRight /></Button>
  </nav>;
}

export function ResourcePicker({ value = '', onChange, placeholder, label, exclude = [], initial }: {
  value?: string; onChange: (id: string, item?: ResourceOption) => void; placeholder: string; label: string;
  exclude?: string[]; initial?: ResourceOption;
}) {
  const [search, setSearch] = useState('');
  const query = useDebounced(search);
  const list = usePagedData<ResourceOption>(`/resources?summary=true&q=${encodeURIComponent(query)}`, 0, 20, true, true);
  const selected = list.known[value] ?? (initial?.id === value ? initial : undefined);
  return <div className="paged-picker">
    <Input aria-label="检索候选名称" placeholder="搜索文件夹名称…" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} />
    <NativeSelect aria-label={label} value={value} disabled={list.loading} onChange={(e) => onChange(e.target.value, list.known[e.target.value])}>
      <option value="">{placeholder}</option>
      {selected && !list.data.some((item) => item.id === value) && <option value={value}>{selected.name}</option>}
      {list.data.filter((item) => !exclude.includes(item.id) || item.id === value).map((item) => <option key={item.id} value={item.id}>{item.name}{item.status !== 'published' ? '（未发布）' : ''}</option>)}
    </NativeSelect>
    {list.error && <p role="alert" className="error">{list.error}</p>}
    <Pagination {...list} loading={list.refreshing} label="候选资源分页" />
  </div>;
}
