import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { crc32 } from './zip.mjs';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.name = 'HttpError'; this.status = status; }
}

export const MAX_DOCUMENT_CHARS = 100_000;
export const MAX_DOCX_BYTES = 3 * 1024 * 1024;

function decodeXml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (all, value) => {
    const basic = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (value in basic) return basic[value];
    const point = value.toLowerCase().startsWith('#x') ? parseInt(value.slice(2), 16) : parseInt(value.slice(1), 10);
    return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : all;
  });
}

/** Read only document.xml; never extract an uploaded archive onto disk. */
export function extractDocx(bytes) {
  if (bytes.length > MAX_DOCX_BYTES) throw new HttpError(400, 'DOCX 文件不能超过 3 MB。');
  let end = -1;
  for (let i = bytes.length - 22, min = Math.max(0, bytes.length - 65557); i >= min; i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new HttpError(400, 'DOCX 文件损坏，未找到有效的文档目录。');
  const count = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  let at = bytes.readUInt32LE(end + 16);
  if (count > 1000 || at + directorySize > end) throw new HttpError(400, 'DOCX 文档目录无效或过于复杂。');
  let xmlBytes;
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== 0x02014b50) throw new HttpError(400, 'DOCX 文档目录损坏。');
    const flags = bytes.readUInt16LE(at + 8);
    const method = bytes.readUInt16LE(at + 10);
    const checksum = bytes.readUInt32LE(at + 16);
    const compressed = bytes.readUInt32LE(at + 20);
    const size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const local = bytes.readUInt32LE(at + 42);
    if (at + 46 + nameLength + extraLength + commentLength > bytes.length) throw new HttpError(400, 'DOCX 文档目录损坏。');
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extraLength + commentLength;
    if (name !== 'word/document.xml') continue;
    if (flags & 1) throw new HttpError(400, '暂不支持加密 DOCX，请另存为未加密文件。');
    if (size > 2 * 1024 * 1024 || compressed > MAX_DOCX_BYTES) throw new HttpError(400, 'DOCX 正文过大，请精简后上传。');
    if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) throw new HttpError(400, 'DOCX 正文索引损坏。');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (start + compressed > bytes.length) throw new HttpError(400, 'DOCX 正文不完整。');
    const data = bytes.subarray(start, start + compressed);
    try {
      xmlBytes = method === 0 ? data : method === 8 ? inflateRawSync(data, { maxOutputLength: 2 * 1024 * 1024 }) : null;
    } catch { throw new HttpError(400, 'DOCX 正文解压失败。'); }
    if (!xmlBytes || xmlBytes.length !== size || crc32(xmlBytes) !== checksum) throw new HttpError(400, 'DOCX 正文校验失败或压缩格式不受支持。');
    break;
  }
  if (!xmlBytes) throw new HttpError(400, '未找到 DOCX 正文，请上传标准 Word 文档。');
  const xml = xmlBytes.toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) throw new HttpError(400, 'DOCX 正文包含不支持的 XML 声明。');
  const tokens = xml.match(/<w:t\b[^>]*>[\s\S]*?<\/w:t>|<w:tab\b[^>]*\/?\s*>|<w:br\b[^>]*\/?\s*>|<\/w:p>/gu) ?? [];
  return tokens.map(token => token.startsWith('</w:p') || token.startsWith('<w:br') ? '\n' : token.startsWith('<w:tab') ? '\t' : decodeXml(token.replace(/^<w:t\b[^>]*>|<\/w:t>$/gu, ''))).join('').replace(/\n{3,}/gu, '\n\n');
}

export function parseDocument(input) {
  if (!input || typeof input !== 'object') throw new HttpError(400, '请提交需求文档。');
  if (typeof input.filename !== 'string' || !input.filename.trim()) throw new HttpError(400, '请提供文档文件名。');
  const filename = path.basename(input.filename.replaceAll('\\', '/')).slice(0, 160);
  const extension = path.extname(filename).toLowerCase();
  let content;
  if (extension === '.docx') {
    if (typeof input.fileBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/u.test(input.fileBase64) || input.fileBase64.length % 4 !== 0) throw new HttpError(400, 'DOCX 上传内容无效，请重新选择文件。');
    content = extractDocx(Buffer.from(input.fileBase64, 'base64'));
  } else if (extension === '.md' || extension === '.txt') {
    if (typeof input.content !== 'string') throw new HttpError(400, '请提供文本需求内容。');
    content = input.content;
  } else throw new HttpError(400, '支持 .md、.txt 和 .docx 需求文档。');
  content = content.replace(/^\uFEFF/u, '').replaceAll('\r\n', '\n').trim();
  if (!content) throw new HttpError(400, '文档正文为空，请补充软件需求后再上传。');
  if (content.length > MAX_DOCUMENT_CHARS) throw new HttpError(400, '需求正文不能超过 100000 字符。');
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 100) : filename.replace(/\.[^.]+$/u, '');
  return { name, source: { filename, content } };
}
