import { useEffect, useRef, useState } from 'react';
import { request } from './api';
import { FocusButton } from './focus';
import { FocusSelect } from './focus-select';

const choices = [
  { value: 'zh', label: '中文' }, { value: 'en', label: '英文' },
  { value: 'zh-en', label: '中英文' }, { value: 'off', label: '关闭字幕' },
] as const;
type Preference = typeof choices[number]['value'];

export function PlaybackSettings() {
  const [value, setValue] = useState<Preference>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const saving = useRef(false);
  useEffect(() => {
    let alive = true;
    void request<{ defaultSubtitle: Preference }>('/api/settings/playback').then((data) => {
      if (alive) { setValue(data.defaultSubtitle); setError(''); }
    }).catch((failure) => { if (alive) setError(failure.message); });
    return () => { alive = false; };
  }, [reload]);
  const save = async (next: Preference) => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true); setError('');
    try {
      const data = await request<{ defaultSubtitle: Preference }>('/api/settings/playback', 'PUT', { defaultSubtitle: next });
      setValue(data.defaultSubtitle);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '保存失败，请重试'); }
    finally { saving.current = false; setBusy(false); }
  };
  return <section className="subtitle-preference" aria-label="默认字幕">
    <h2>默认字幕</h2>
    <p>与管理后台同步，下次播放生效。没有匹配字幕时关闭；中英文需要双语字幕文件。</p>
    <FocusSelect focusKey="subtitle-default" label="默认字幕" value={value} options={choices} disabled={!value} onChange={(next) => { void save(next); }} />
    {busy && <p role="status">正在保存…</p>}
    {error && <><p role="alert" className="error">{error}</p><FocusButton focusKey="subtitle-settings-retry" onClick={() => setReload((v) => v + 1)}>重新加载字幕设置</FocusButton></>}
  </section>;
}
