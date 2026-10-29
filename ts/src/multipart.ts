/**
 * multipart/form-data の解析（依存なし）。インポート・アップロード系 REST で使う
 * （main.py では Werkzeug の request.files / request.form にあたる）。
 *
 * ボディ全体（Buffer）を受け取り、ファイル部分はコピーせず subarray で返す。
 * 同じ name が複数あるときは Werkzeug の request.files[name] と同じく最初のものを返す。
 */
export interface MultipartFile {
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface MultipartForm {
  fields: Record<string, string>;
  files: Record<string, MultipartFile>;
}

/** Content-Type から boundary を取り出す。multipart/form-data でなければ null */
export function multipartBoundary(contentType: string | undefined): string | null {
  if (!contentType || !/^multipart\/form-data/i.test(contentType)) return null;
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return m ? (m[1] ?? m[2]) : null;
}

/** Content-Disposition のパラメータ（name / filename）を取り出す */
function dispositionParams(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /;\s*([a-zA-Z*]+)=(?:"((?:[^"\\]|\\.)*)"|([^;]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header)) !== null) {
    const key = m[1].toLowerCase();
    let val = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3].trim();
    if (key === 'filename*') {
      // RFC 5987: UTF-8''%E3%81%82...
      const ext = /^[^']*'[^']*'(.*)$/.exec(val);
      if (ext) {
        try {
          val = decodeURIComponent(ext[1]);
        } catch {
          /* そのまま */
        }
      }
      out.filename = val;
      continue;
    }
    if (key === 'filename' && 'filename' in out) continue; // filename* を優先
    out[key] = val;
  }
  return out;
}

/** multipart ボディを解析する。形式が不正なら null */
export function parseMultipart(body: Buffer, contentType: string | undefined): MultipartForm | null {
  const boundary = multipartBoundary(contentType);
  if (!boundary) return null;
  const delim = Buffer.from(`--${boundary}`);
  const form: MultipartForm = { fields: {}, files: {} };
  let pos = body.indexOf(delim);
  if (pos < 0) return null;
  while (true) {
    pos += delim.length;
    // 終端 "--boundary--"
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;
    // 区切りのあとの CRLF
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
    const headerEnd = body.indexOf('\r\n\r\n', pos);
    if (headerEnd < 0) return null;
    const headers = body.toString('utf-8', pos, headerEnd).split('\r\n');
    const next = body.indexOf(Buffer.concat([Buffer.from('\r\n'), delim]), headerEnd + 4);
    if (next < 0) return null;
    const data = body.subarray(headerEnd + 4, next);
    let disposition = '';
    let partType = 'text/plain';
    for (const h of headers) {
      const i = h.indexOf(':');
      if (i < 0) continue;
      const name = h.slice(0, i).trim().toLowerCase();
      const value = h.slice(i + 1).trim();
      if (name === 'content-disposition') disposition = value;
      else if (name === 'content-type') partType = value;
    }
    const params = dispositionParams(disposition);
    const field = params.name;
    if (field !== undefined) {
      if ('filename' in params) {
        if (!(field in form.files)) {
          form.files[field] = { filename: params.filename, contentType: partType, data };
        }
      } else if (!(field in form.fields)) {
        form.fields[field] = data.toString('utf-8');
      }
    }
    pos = next + 2;
  }
  return form;
}
