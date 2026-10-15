export function mp4Fixture(version = 0, handler = 'vide', duration = 1250n): Buffer {
  const box = (type: string, ...parts: Buffer[]) => {
    const payload = Buffer.concat(parts), header = Buffer.alloc(8);
    header.writeUInt32BE(payload.length + 8); header.write(type, 4);
    return Buffer.concat([header, payload]);
  };
  const movie = Buffer.alloc(version ? 32 : 20);
  movie[0] = version;
  movie.writeUInt32BE(1000, version ? 20 : 12);
  if (version) movie.writeBigUInt64BE(duration, 24); else movie.writeUInt32BE(Number(duration), 16);
  const track = Buffer.alloc(12); track.write(handler, 8);
  return Buffer.concat([
    box('ftyp', Buffer.from('isom0000')),
    box('moov', box('mvhd', movie), box('trak', box('mdia', box('hdlr', track)))),
  ]);
}
