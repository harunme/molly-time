import { useEffect, useState } from 'react';
import { api, bytes } from './api';

export type UploadLimits = Record<'video' | 'subtitle' | 'image', number>;

export function getUploadLimits(signal?: AbortSignal) {
  return api<UploadLimits>('/uploads/options', 'GET', undefined, undefined, signal);
}

export function validateUploadSize(file: Pick<File, 'name' | 'size'>, kind: string, limits: UploadLimits) {
  const limit = limits[kind as keyof UploadLimits];
  if (!limit) throw new Error('不支持此文件类型');
  if (file.size <= 0) throw new Error(`${file.name} 是空文件，请重新选择`);
  if (file.size > limit) {
    const label = { video: '视频', subtitle: '字幕', image: '封面' }[kind as keyof UploadLimits];
    throw new Error(`${file.name} 超过单个${label}上限 ${bytes(limit)}`);
  }
}

export function useUploadLimits() {
  const [limits, setLimits] = useState<UploadLimits>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    getUploadLimits(controller.signal)
      .then((value) => { if (!controller.signal.aborted) setLimits(value); })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, []);
  return { limits, error };
}
