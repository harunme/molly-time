export type VideoMetadata = { runtimeMs: number; cover?: string };
type Box = { type: string; start: number; end: number };

/** Read MP4 headers without loading mdat or requiring a browser-supported codec. */
export async function videoDuration(file: Blob): Promise<number> {
  let remaining = 10_000;
  const read = async (start: number, size: number) => {
    const data = await file.slice(start, start + size).arrayBuffer();
    if (data.byteLength !== size) throw new Error('视频信息不完整，请检查原文件');
    return new DataView(data);
  };
  const text = (data: DataView, offset: number) => String.fromCharCode(...new Uint8Array(data.buffer, offset, 4));
  const boxes = async (start: number, end: number): Promise<Box[]> => {
    const result: Box[] = [];
    while (start < end) {
      if (--remaining < 0 || end - start < 8) throw new Error('视频信息异常，请检查原文件');
      const header = await read(start, 8);
      let size = header.getUint32(0), headerSize = 8;
      if (size === 1) {
        if (end - start < 16) throw new Error('视频信息不完整，请检查原文件');
        const extended = (await read(start + 8, 8)).getBigUint64(0);
        if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('视频信息异常，请检查原文件');
        size = Number(extended); headerSize = 16;
      } else if (size === 0) size = end - start;
      if (size < headerSize || size > end - start) throw new Error('视频信息不完整，请检查原文件');
      result.push({ type: text(header, 4), start: start + headerSize, end: start + size });
      start += size;
    }
    return result;
  };
  const top = await boxes(0, file.size);
  if (!top.some((box) => box.type === 'ftyp')) throw new Error('请选择 MP4 视频文件');
  const moov = top.find((box) => box.type === 'moov');
  if (!moov) throw new Error('视频缺少时长信息，请检查原文件');
  const children = await boxes(moov.start, moov.end);
  const mvhd = children.find((box) => box.type === 'mvhd');
  if (!mvhd || mvhd.end - mvhd.start < 20) throw new Error('视频缺少时长信息，请检查原文件');
  const version = (await read(mvhd.start, 1)).getUint8(0);
  if (version !== 0 && version !== 1) throw new Error('不支持的视频时长格式');
  const needed = version === 1 ? 32 : 20;
  if (mvhd.end - mvhd.start < needed) throw new Error('视频信息不完整，请检查原文件');
  const header = await read(mvhd.start, needed);
  const timescale = header.getUint32(version === 1 ? 20 : 12);
  const duration = version === 1 ? header.getBigUint64(24) : BigInt(header.getUint32(16));
  if (!timescale || duration === 0n || duration === (version === 1 ? 0xffffffffffffffffn : 0xffffffffn)) {
    throw new Error('无法读取有效视频时长，请检查原文件');
  }
  let video = false;
  for (const track of children.filter((box) => box.type === 'trak')) {
    const mdia = (await boxes(track.start, track.end)).find((box) => box.type === 'mdia');
    if (!mdia) continue;
    const handler = (await boxes(mdia.start, mdia.end)).find((box) => box.type === 'hdlr');
    if (handler && handler.end - handler.start >= 12 && text(await read(handler.start, 12), 8) === 'vide') video = true;
  }
  if (!video) throw new Error('文件中没有视频轨道');
  const runtimeMs = Number((duration * 1000n + BigInt(timescale) / 2n) / BigInt(timescale));
  if (!Number.isSafeInteger(runtimeMs) || runtimeMs <= 0 || runtimeMs > 922337203685477) {
    throw new Error('无法读取有效视频时长，请检查原文件');
  }
  return runtimeMs;
}

function videoCover(file: File, runtimeMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (cover?: string) => {
      if (done) return;
      done = true; clearTimeout(timer);
      video.onloadedmetadata = video.onloadeddata = video.onseeked = video.onerror = null;
      video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url);
      resolve(cover);
    };
    const capture = () => {
      if (!video.videoWidth || !video.videoHeight) { finish(); return; }
      try {
        const scale = Math.min(1, 640 / video.videoWidth, 360 / video.videoHeight);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const context = canvas.getContext('2d');
        if (!context) { finish(); return; }
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let light = 0;
        for (let i = 0; i < pixels.length; i += 4) light += pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;
        const image = canvas.toDataURL('image/jpeg', 0.8);
        finish(light / (pixels.length / 4) < 10 || image.length > 350_000 ? undefined : image);
      } catch { finish(); }
    };
    const timer = window.setTimeout(() => finish(), 5000);
    video.muted = true; video.playsInline = true; video.preload = 'auto';
    video.onloadedmetadata = () => {
      try { video.currentTime = Math.min(3, runtimeMs / 1000 * 0.1); } catch { finish(); }
    };
    video.onseeked = capture;
    video.onerror = () => finish();
    video.src = url;
  });
}

const prepared = new WeakMap<File, Promise<VideoMetadata>>();
export function prepareVideo(file: File): Promise<VideoMetadata> {
  let result = prepared.get(file);
  if (!result) {
    result = videoDuration(file).then(async (runtimeMs) => ({ runtimeMs, cover: await videoCover(file, runtimeMs) }));
    prepared.set(file, result);
  }
  return result;
}
