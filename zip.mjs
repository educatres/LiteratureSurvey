// Small dependency-free ZIP writer (STORE entries, UTF-8 filenames).
// ZIP uses no compression, so downloads can be assembled on GitHub Pages.
const utf8 = new TextEncoder();
const table = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  table[i] = c >>> 0;
}

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

const put16 = (view, offset, value) => view.setUint16(offset, value, true);
const put32 = (view, offset, value) => view.setUint32(offset, value >>> 0, true);

export function makeZip(files) {
  if (files.length > 65535) throw new Error('ZIP 檔案數量超過上限。');
  const parts = [];
  const directory = [];
  let position = 0;
  for (const file of files) {
    const name = utf8.encode(file.name);
    const bytes = typeof file.content === 'string' ? utf8.encode(file.content) : file.content;
    if (!(bytes instanceof Uint8Array)) throw new TypeError('ZIP content must be text or Uint8Array');
    if (name.length > 65535 || bytes.length > 0xffffffff) throw new Error('單一檔案太大。');
    const checksum = crc32(bytes);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    put32(lv, 0, 0x04034b50);
    put16(lv, 4, 20);
    put16(lv, 6, 0x0800); // UTF-8
    put16(lv, 8, 0); // STORE
    put32(lv, 14, checksum);
    put32(lv, 18, bytes.length);
    put32(lv, 22, bytes.length);
    put16(lv, 26, name.length);
    local.set(name, 30);
    parts.push(local, bytes);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    put32(cv, 0, 0x02014b50);
    put16(cv, 4, 20);
    put16(cv, 6, 20);
    put16(cv, 8, 0x0800);
    put32(cv, 16, checksum);
    put32(cv, 20, bytes.length);
    put32(cv, 24, bytes.length);
    put16(cv, 28, name.length);
    put32(cv, 42, position);
    central.set(name, 46);
    directory.push(central);
    position += local.length + bytes.length;
    if (position > 0xffffffff) throw new Error('ZIP 總大小超過 4 GB。');
  }
  const directoryStart = position;
  for (const item of directory) {
    position += item.length;
    if (position > 0xffffffff) throw new Error('ZIP 總大小超過 4 GB。');
  }
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  put32(ev, 0, 0x06054b50);
  put16(ev, 8, files.length);
  put16(ev, 10, files.length);
  put32(ev, 12, position - directoryStart);
  put32(ev, 16, directoryStart);
  return new Blob([...parts, ...directory, end], { type: 'application/zip' });
}
