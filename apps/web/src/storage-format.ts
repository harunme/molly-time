// Shared display contract: tools/fixtures/storage-byte-format.tsv.
export const GIB = 1024 ** 3;

export function formatStorageBytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];
  let amount = value, unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${value} B`;
  return `${(Math.round(amount * 10) / 10).toFixed(1)} ${units[unit]}`;
}
