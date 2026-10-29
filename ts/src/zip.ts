/**
 * ZIP の読み書き（依存なし・node:zlib のみ）。インポート（POST /import ほか）で
 * アップロードされた ZIP をメモリ上で読み、バックアップ（GET /api/export）を書く。
 * main.py は zipfile で一時ディレクトリへ展開していた。
 *
 * 読み取り:
 * - 中央ディレクトリから一覧を作る（ZIP64 の EOCD・拡張フィールドにも対応）
 * - 圧縮方式は stored（0）と deflate（8）。それ以外は ZipError
 * - 展開時に CRC32 を検証する（zipfile と同じく不一致は壊れた ZIP 扱い）
 * - 大きいエントリ（conversations.json）はストリームでも読める
 * 書き込み: deflate。エントリ数・オフセットが ZIP の上限を超えたときだけ ZIP64 にする
 */
import zlib from 'node:zlib';

export class ZipError extends Error {}

export interface ZipEntry {
  /** アーカイブ内のパス（区切りは '/'） */
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
  isDir: boolean;
}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const MAX16 = 0xffff;
const MAX32 = 0xffffffff;

function u64(buf: Buffer, off: number): number {
  const v = buf.readBigUInt64LE(off);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('zip64 value too large');
  return Number(v);
}

function findEocd(buf: Buffer): number {
  // EOCD は末尾 22 バイト + コメント（最大 65535）の範囲にある
  const min = Math.max(0, buf.length - 22 - MAX16);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new ZipError('not a zip file (end of central directory not found)');
}

/** 中央ディレクトリを読んでエントリ一覧を返す（ディレクトリエントリも含む） */
export function listZipEntries(buf: Buffer): ZipEntry[] {
  if (buf.length < 22) throw new ZipError('not a zip file (too short)');
  const eocd = findEocd(buf);
  let total = buf.readUInt16LE(eocd + 10);
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === MAX16 || cdSize === MAX32 || cdOffset === MAX32) {
    const loc = eocd - 20;
    if (loc < 0 || buf.readUInt32LE(loc) !== SIG_EOCD64_LOCATOR) throw new ZipError('zip64 locator not found');
    const e64 = u64(buf, loc + 8);
    if (e64 + 56 > buf.length || buf.readUInt32LE(e64) !== SIG_EOCD64) throw new ZipError('zip64 end record not found');
    total = u64(buf, e64 + 32);
    cdSize = u64(buf, e64 + 40);
    cdOffset = u64(buf, e64 + 48);
  }
  if (cdOffset + cdSize > buf.length) throw new ZipError('central directory out of range');

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipError('bad central directory entry');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    let compressedSize = buf.readUInt32LE(p + 20);
    let size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf-8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
    // ZIP64 拡張フィールド（id 0x0001）: 0xFFFFFFFF になっている値だけが size, compressed, offset の順に入る
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = buf.readUInt16LE(x);
      const len = buf.readUInt16LE(x + 2);
      if (id === 0x0001) {
        let q = x + 4;
        if (size === MAX32) { size = u64(buf, q); q += 8; }
        if (compressedSize === MAX32) { compressedSize = u64(buf, q); q += 8; }
        if (localHeaderOffset === MAX32) { localHeaderOffset = u64(buf, q); }
      }
      x += 4 + len;
    }
    entries.push({ name, method, crc, compressedSize, size, localHeaderOffset, isDir: name.endsWith('/') });
    p = xEnd + commentLen;
  }
  return entries;
}

function dataRange(buf: Buffer, e: ZipEntry): [number, number] {
  const h = e.localHeaderOffset;
  if (h + 30 > buf.length || buf.readUInt32LE(h) !== SIG_LOCAL) throw new ZipError(`bad local header: ${e.name}`);
  const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28);
  const end = start + e.compressedSize;
  if (end > buf.length) throw new ZipError(`entry out of range: ${e.name}`);
  return [start, end];
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC32（zlib.crc32 があればそれを使う） */
export function crc32(data: Buffer, prev = 0): number {
  const native = (zlib as unknown as { crc32?: (d: Buffer, v?: number) => number }).crc32;
  if (native) return native(data, prev) >>> 0;
  let c = (prev ^ MAX32) >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ MAX32) >>> 0;
}

/** エントリを展開して返す（CRC 検証つき） */
export function zipEntryData(buf: Buffer, e: ZipEntry): Buffer {
  const [start, end] = dataRange(buf, e);
  const raw = buf.subarray(start, end);
  let out: Buffer;
  if (e.method === 0) out = raw;
  else if (e.method === 8) out = zlib.inflateRawSync(raw);
  else throw new ZipError(`unsupported compression method ${e.method}: ${e.name}`);
  if (crc32(out) !== e.crc) throw new ZipError(`bad CRC: ${e.name}`);
  return out;
}

const STORED_CHUNK = 1 << 20;

/**
 * エントリを展開しながら少しずつ返す（巨大な conversations.json 用）。
 * 展開後の全体をメモリに持たない。CRC は最後まで読んだ時点で検証する
 */
export async function* zipEntryChunks(buf: Buffer, e: ZipEntry): AsyncGenerator<Buffer> {
  const [start, end] = dataRange(buf, e);
  const raw = buf.subarray(start, end);
  let crc = 0;
  if (e.method === 0) {
    for (let i = 0; i < raw.length; i += STORED_CHUNK) {
      const c = raw.subarray(i, i + STORED_CHUNK);
      crc = crc32(c, crc);
      yield c;
    }
  } else if (e.method === 8) {
    const inflate = zlib.createInflateRaw();
    inflate.end(raw);
    for await (const chunk of inflate) {
      crc = crc32(chunk as Buffer, crc);
      yield chunk as Buffer;
    }
  } else {
    throw new ZipError(`unsupported compression method ${e.method}: ${e.name}`);
  }
  if (crc !== e.crc) throw new ZipError(`bad CRC: ${e.name}`);
}

// ── 書き込み ─────────────────────────────────────────────────────────

export interface ZipInput {
  name: string;
  data: Buffer;
  /** 省略時は現在時刻 */
  mtime?: Date;
}

/** MS-DOS 形式の時刻・日付（ローカル時刻。zipfile と同じ） */
function dosDateTime(d: Date): [number, number] {
  const year = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return [time, date];
}

/** ファイル群から ZIP（deflate）を組み立てる */
export function buildZip(files: ZipInput[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf-8');
    const comp = zlib.deflateRawSync(f.data);
    if (f.data.length > MAX32 - 1 || comp.length > MAX32 - 1) throw new ZipError(`file too large: ${f.name}`);
    const crc = crc32(f.data);
    const [time, date] = dosDateTime(f.mtime ?? new Date());
    const flags = /[^\x00-\x7f]/.test(f.name) ? 0x0800 : 0; // UTF-8 名
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    // オフセットが 4GB を超えたら中央ディレクトリ側だけ ZIP64 拡張に入れる
    const zip64Offset = offset > MAX32 - 1;
    const extra = Buffer.alloc(zip64Offset ? 12 : 0);
    if (zip64Offset) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(8, 2);
      extra.writeBigUInt64LE(BigInt(offset), 4);
    }
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(SIG_CENTRAL, 0);
    cd.writeUInt16LE(zip64Offset ? 45 : 20, 4);
    cd.writeUInt16LE(zip64Offset ? 45 : 20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(extra.length, 30);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(zip64Offset ? MAX32 : offset, 42);
    central.push(cd, name, extra);
    parts.push(local, name, comp);
    offset += local.length + name.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const needZip64 = files.length >= MAX16 || offset > MAX32 - 1 || cdBuf.length > MAX32 - 1;
  const tail: Buffer[] = [];
  if (needZip64) {
    const e64 = Buffer.alloc(56);
    e64.writeUInt32LE(SIG_EOCD64, 0);
    e64.writeBigUInt64LE(44n, 4);
    e64.writeUInt16LE(45, 12);
    e64.writeUInt16LE(45, 14);
    e64.writeBigUInt64LE(BigInt(files.length), 24);
    e64.writeBigUInt64LE(BigInt(files.length), 32);
    e64.writeBigUInt64LE(BigInt(cdBuf.length), 40);
    e64.writeBigUInt64LE(BigInt(offset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(SIG_EOCD64_LOCATOR, 0);
    loc.writeBigUInt64LE(BigInt(offset + cdBuf.length), 8);
    loc.writeUInt32LE(1, 16);
    tail.push(e64, loc);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(needZip64 ? MAX16 : files.length, 8);
  eocd.writeUInt16LE(needZip64 ? MAX16 : files.length, 10);
  eocd.writeUInt32LE(needZip64 ? MAX32 : cdBuf.length, 12);
  eocd.writeUInt32LE(needZip64 ? MAX32 : offset, 16);
  tail.push(eocd);
  return Buffer.concat([...parts, cdBuf, ...tail]);
}
