/**
 * 巨大な JSON 配列を1要素ずつ取り出す（依存なし）。
 *
 * claude.ai エクスポートの conversations.json や OpenWebUI の全チャットエクスポートは
 * 数百 MB になりうる。Node の文字列は約 5 億文字が上限なので、全体を一度に
 * JSON.parse できない場合がある。バイト列を走査して最上位の配列の要素境界だけを
 * 見つけ、要素ごとに JSON.parse する（main.py は json.load で全体を読んでいた）。
 *
 * 最上位が配列でなければ（オブジェクト等）全体を1要素として返す。
 */
export class JsonFormatError extends Error {}

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);

/**
 * チャンク列（UTF-8 のバイト列）から、最上位の配列の各要素を JSON.parse した値を返す。
 * 先頭の BOM は読み飛ばす。requireArray なら最上位が配列でないとき JsonFormatError
 */
export async function* jsonArrayElements(
  chunks: AsyncIterable<Buffer> | Iterable<Buffer>,
  opts: { requireArray?: boolean } = {},
): AsyncGenerator<unknown> {
  let started = false; // 最初の非空白文字を見たか
  let isArray = false;
  let done = false;
  let depth = 0; // 配列の中での入れ子の深さ（0 = 要素の外）
  let inString = false;
  let escape = false;
  let parts: Buffer[] = []; // いま組み立て中の要素（または非配列の全体）
  let elementStarted = false;
  let bomChecked = false;
  let pendingComma = false; // 直前に要素を閉じた（次はカンマか ']'）

  const emit = (): unknown => {
    const raw = Buffer.concat(parts).toString('utf-8');
    parts = [];
    elementStarted = false;
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new JsonFormatError((e as Error).message);
    }
  };

  for await (let chunk of chunks) {
    if (!bomChecked) {
      bomChecked = true;
      if (chunk.length >= 3 && chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf) chunk = chunk.subarray(3);
    }
    if (done) {
      for (const b of chunk) if (!WS.has(b)) throw new JsonFormatError('extra data after JSON array');
      continue;
    }
    let segStart = elementStarted || (started && !isArray) ? 0 : -1;
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];
      if (!started) {
        if (WS.has(b)) continue;
        started = true;
        if (b === 0x5b) {
          isArray = true;
          continue;
        }
        if (opts.requireArray) throw new JsonFormatError('expected a JSON array');
        segStart = i; // 配列でない: 全体を1つの値として集める
        continue;
      }
      if (!isArray) continue;
      if (inString) {
        if (escape) escape = false;
        else if (b === 0x5c) escape = true;
        else if (b === 0x22) inString = false;
        continue;
      }
      if (!elementStarted) {
        if (WS.has(b)) continue;
        if (b === 0x5d && depth === 0) {
          done = true;
          // ']' 以降は空白のみ許す
          for (let j = i + 1; j < chunk.length; j++) {
            if (!WS.has(chunk[j])) throw new JsonFormatError('extra data after JSON array');
          }
          break;
        }
        if (b === 0x2c) {
          if (!pendingComma) throw new JsonFormatError('unexpected comma');
          pendingComma = false;
          continue;
        }
        if (pendingComma) throw new JsonFormatError('missing comma between elements');
        elementStarted = true;
        segStart = i;
      }
      if (b === 0x22) inString = true;
      else if (b === 0x7b || b === 0x5b) depth++;
      else if (b === 0x7d || b === 0x5d) {
        if (depth === 0) {
          // 値（数値・リテラル）の直後の ']'
          parts.push(chunk.subarray(segStart, i));
          yield emit();
          done = true;
          for (let j = i + 1; j < chunk.length; j++) {
            if (!WS.has(chunk[j])) throw new JsonFormatError('extra data after JSON array');
          }
          segStart = -1;
          break;
        }
        depth--;
        if (depth === 0) {
          parts.push(chunk.subarray(segStart, i + 1));
          yield emit();
          pendingComma = true;
          segStart = -1;
        }
      } else if (b === 0x2c && depth === 0) {
        // 数値・リテラル要素の終わり
        parts.push(chunk.subarray(segStart, i));
        yield emit();
        pendingComma = false;
        segStart = -1;
      }
    }
    if (!done && segStart >= 0) parts.push(chunk.subarray(segStart));
  }
  if (!started) throw new JsonFormatError('empty input');
  if (!isArray) {
    yield emit();
    return;
  }
  if (!done) throw new JsonFormatError('unterminated JSON array');
}
