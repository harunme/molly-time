import { useEffect, useRef, useState } from 'react';
import { call } from './api';

type Release = { versionName: string; size: number; notes: string };
type Phase = 'checking' | 'latest' | 'available' | 'downloading' | 'preparing' | 'ready' | 'installing' | 'installed' | 'error';
type Update = { phase: Phase; message: string; percent?: number; release?: Release; retry?: 'check' | 'download' | 'install' };
type Progress = { state: string; received?: number; total?: number; message?: string; phase?: Phase };

// Older shells send installation messages as state. Keep that compatibility at
// the Bridge boundary; controls below depend on phases, never display text.
function progressUpdate(current: Update | undefined, detail: Progress): Update {
  const base = { ...current };
  if (detail.state === 'downloading') {
    const percent = Math.min(100, Math.max(0, Math.floor((detail.received ?? 0) * 100 / Math.max(1, detail.total ?? 1))));
    return { ...base, phase: percent === 100 ? 'preparing' : 'downloading', percent, message: percent === 100 ? '正在准备安装…' : `正在下载 ${percent}%` };
  }
  if (detail.state === 'downloaded') return { ...base, phase: 'ready', percent: 100, message: '更新已准备好', retry: undefined };
  if (detail.state === 'error') return { ...base, phase: 'error', message: detail.message ?? '更新失败，请重试', retry: 'download' };
  const phase = detail.phase ?? (detail.state === '请在系统安装界面确认更新' ? 'installing'
    : detail.state === '更新已安装，请重新打开 MollyTime' ? 'installed' : 'ready');
  return { ...base, phase, message: detail.message ?? detail.state, retry: phase === 'error' ? 'install' : undefined };
}

export function useClientUpdate() {
  const [update, setUpdate] = useState<Update>();
  const current = useRef<Update | undefined>(undefined);
  const commit = (next: Update) => { current.current = next; setUpdate(next); };
  const download = async (previous: Update) => {
    commit({ ...previous, phase: 'downloading', percent: 0, message: '正在下载 0%', retry: undefined });
    try { await call('downloadUpdate'); }
    catch (failure) {
      commit({ ...previous, phase: 'error', message: failure instanceof Error ? failure.message : '下载失败，请重试', retry: 'download' });
    }
  };
  const check = async (force = false) => {
    // Startup notifications and settings share one operation. Never replace an
    // active download or a verified package waiting for installation.
    const previous = current.current;
    if (previous && (['checking', 'downloading', 'preparing', 'ready', 'installing', 'installed'].includes(previous.phase) || !force)) return;
    commit({ phase: 'checking', message: '正在检查更新…' });
    try {
      const result = await call<{ release: Release | null; progress?: Progress }>('checkUpdate');
      const next: Update = result.release ? { phase: 'available', message: `发现新版本 ${result.release.versionName}`, release: result.release }
        : { phase: 'latest', message: '当前已是最新版本' };
      const restored = result.progress && result.release ? progressUpdate(next, result.progress) : next;
      if (restored.phase === 'available') await download(restored);
      else commit(restored);
    } catch (failure) {
      commit({ phase: 'error', message: failure instanceof Error ? failure.message : '检查更新失败', retry: 'check' });
    }
  };
  const act = async () => {
    const previous = current.current;
    if (!previous || !['ready', 'error'].includes(previous.phase)) return;
    if (previous.retry === 'check' || !previous.release) { await check(true); return; }
    if (previous.retry === 'download') { await download(previous); return; }
    commit({ ...previous, phase: 'installing', percent: 100, message: '正在准备安装…' });
    try { await call('installUpdate'); }
    catch (failure) {
      commit({ ...previous, phase: 'error', message: failure instanceof Error ? failure.message : '安装失败，请重试', retry: 'install' });
    }
  };
  useEffect(() => {
    const progress = (event: Event) => commit(progressUpdate(current.current, (event as CustomEvent<Progress>).detail));
    window.addEventListener('molly:clientUpdateProgress', progress);
    return () => window.removeEventListener('molly:clientUpdateProgress', progress);
  }, []);
  const actionable = !!update && ['ready', 'error'].includes(update.phase);
  const actionLabel = update?.phase === 'error' ? '重试' : '立即安装';
  return { update, check, act, actionable, actionLabel };
}
