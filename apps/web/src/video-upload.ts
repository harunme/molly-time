import { api, ApiError, type Resource } from './api';
import { enqueue } from './uploads';
import { getUploadLimits, validateUploadSize } from './upload-limits';

type VideoRow = { file: File; name: string; itemId?: string };
export type VideoUploadBatch = { folderId?: string; rows: VideoRow[] };

async function inboxFolder() {
  const find = async () => (await api<Resource[]>('/resources?q=' + encodeURIComponent('未整理')))
    .find(item => item.type === 'Series' && item.name === '未整理' && !item.parentId);
  const existing = await find();
  if (existing) return existing.id;
  try {
    return (await api<Resource>('/resources', 'POST', { type: 'Series', name: '未整理' })).id;
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409) throw error;
    // Another tab may have created the inbox while the file chooser was open.
    const created = await find();
    if (created) return created.id;
    throw new Error('“未整理”文件夹已在回收站，请恢复或重命名后再上传。');
  }
}

export async function queueVideoFiles(batch: VideoUploadBatch, files: File[], queued: () => void) {
  if (files.length) {
    const limits = await getUploadLimits();
    const rows = files.map(file => {
      if (!/\.mp4$/i.test(file.name)) throw new Error(`${file.name} 不是 MP4 视频，请重新选择。`);
      validateUploadSize(file, 'video', limits);
      const name = file.name.replace(/\.[^.]+$/, '').trim();
      if (!name || name.length > 256) throw new Error(`${file.name} 的名称需为 1–256 个字符，请修改文件名后重新选择。`);
      return { file, name };
    });
    // Validate the entire selection before creating any folders or videos.
    batch.rows.push(...rows);
  }
  if (!batch.rows.length) return;
  batch.folderId ||= await inboxFolder();
  while (batch.rows.length) {
    const row = batch.rows[0];
    row.itemId ||= (await api<Resource>('/resources', 'POST', {
      type: 'Episode', parentId: batch.folderId, name: row.name,
    })).id;
    // Retain the created resource on failure so retry never creates it twice.
    await enqueue(row.file, row.itemId, 'video');
    batch.rows.shift();
    queued();
  }
}
