/* filetext.mjs —— 在浏览器里把上传的文件变成纯文本（零依赖）
   ════════════════════════════════════════════════════════════════════
   为什么在浏览器里解、而不是传到服务器解：

   材料最终要落进 SQLite 的是**字**，不是文件。传上来再转文字要多占
   一次带宽、多一份临时文件，还得处理并发与清理。浏览器本来就有
   DecompressionStream，zip 和 pdf 的压缩流都能就地解开。

   支持：.txt .md .csv .json .log（含 GBK 编码）
        .docx（zip + word/document.xml）
        .pdf（取文字层；扫描版取不出来，调用方负责提示）
   不支持：.doc（老的 OLE 二进制格式，浏览器没法解）
          .png .jpg（没有文字层，只能 OCR）

   ⚠️ 编码这一条最容易踩：中文 Windows 上很多 .txt 是 **GBK**，
      直接 TextDecoder('utf-8') 会把每个汉字解成 3 个 ���。
      所以先试严格 UTF-8，抛错才退回 GBK。 */
/* 这个文件同时给 Node 用（测试脚本），所以不能写死在浏览器才有的东西上。
   下面两个 getter 把「可能有」的全局兜住。 */
const DS = typeof DecompressionStream !== 'undefined' ? DecompressionStream : null;
const TD = typeof TextDecoder !== 'undefined' ? TextDecoder : null;

/* ── 编码 ─────────────────────────────────────────────── */

/** 解字节到字符串。返回 {text, encoding}。
 *  顺序：BOM → 严格 UTF-8 → GBK。 */
export function decodeText(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // BOM 优先：有 BOM 就不用猜，猜错反而更糟
  if (u8.length >= 3 && u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) {
    return { text: new TD('utf-8').decode(u8.subarray(3)), encoding: 'utf-8-bom' };
  }
  if (u8.length >= 2 && u8[0] === 0xFF && u8[1] === 0xFE) {
    return { text: new TD('utf-16le').decode(u8.subarray(2)), encoding: 'utf-16le' };
  }
  if (u8.length >= 2 && u8[0] === 0xFE && u8[1] === 0xFF) {
    return { text: new TD('utf-16be').decode(u8.subarray(2)), encoding: 'utf-16be' };
  }
  try {
    // fatal:true 才是「严格」——不加的话非法字节会变成 U+FFFD 而**不抛错**，
    // 那就永远走不到 GBK 分支，一堆文件会静默变成一串问号。
    return { text: new TD('utf-8', { fatal: true }).decode(u8), encoding: 'utf-8' };
  } catch (_) {
    try { return { text: new TD('gbk').decode(u8), encoding: 'gbk' }; } catch (_2) { /* 老浏览器没有 gbk */ }
    return { text: new TD('utf-8').decode(u8), encoding: 'utf-8-lossy' };
  }
}

/* ── 解压 ─────────────────────────────────────────────── */

/** zlib/deflate 解压。raw=true 时按 raw deflate 解。
 *  PDF 的 FlateDecode 正常带 zlib 头，但现实里有不带的，所以要能兜住。 */
async function inflate(bytes, raw = false) {
  if (!DS) throw new Error('这个环境没有 DecompressionStream');
  const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const ds = new DS(raw ? 'deflate-raw' : 'deflate');
  const stream = new Blob([src]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflateLoose(bytes) {
  try { return await inflate(bytes, false); }
  catch (_) { return await inflate(bytes, true); }
}

/* ── zip（docx/xlsx 都是 zip） ───────────────────────────── */
/* 只读中央目录，不做流式解压——docx 通常几百 KB，一次读进内存毫无压力。 */

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

/** @returns {Promise<Record<string, Uint8Array>>} 文件名 → 内容 */
export async function unzip(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // EOCD（中央目录结尾）签名 0x06054b50，从文件尾往前找，最大回溯 64KB（注释字段上限）
  let eocd = -1;
  const back = Math.min(b.length, 65557);
  for (let i = b.length - 22; i >= b.length - back && i >= 0; i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是 zip（找不到中央目录）');
  const count = u16(b, eocd + 10);
  const cdOff = u32(b, eocd + 16);
  const out = {};
  let p = cdOff;
  for (let i = 0; i < count && p + 46 <= b.length; i++) {
    if (!(b[p] === 0x50 && b[p + 1] === 0x4b && b[p + 2] === 0x01 && b[p + 3] === 0x02)) break;
    const method = u16(b, p + 10);
    const compSize = u32(b, p + 20);
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const cmtLen = u16(b, p + 32);
    const lho = u32(b, p + 42);
    const name = new TD('utf-8').decode(b.subarray(p + 46, p + 46 + nameLen));
    const lNameLen = u16(b, lho + 26);
    const lExtraLen = u16(b, lho + 28);
    const dataOff = lho + 30 + lNameLen + lExtraLen;
    const raw = b.subarray(dataOff, dataOff + compSize);
    if (method === 0) out[name] = raw;
    else if (method === 8) {
      try { out[name] = await inflate(raw, true); } catch (_) { /* 单个条目坏了不该拖垮整个文件 */ }
    }
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

/* ── docx ─────────────────────────────────────────────── */
/* 正文在 word/document.xml。需要做三件事：
   ① 把 <w:p> 变段落、<w:br>/<w:tab> 变换行和制表符
   ② 剥掉所有标签
   ③ 还原 XML 实体（&amp; 之类必须最后做，否则内容里的 &lt; 会被误当标签） */
export async function docxToText(bytes) {
  const files = await unzip(bytes);
  const entry = files['word/document.xml'];
  if (!entry) throw new Error('这个 docx 里没有 word/document.xml');
  let xml = new TD('utf-8').decode(entry);
  xml = xml
    .replace(/<w:tab\b[^>]*\/?>/g, '\t')
    .replace(/<w:br\b[^>]*\/?>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<[^>]+>/g, '');
  xml = xml
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
  return xml.replace(/\n{3,}/g, '\n\n').trim();
}

/* ── pdf ──────────────────────────────────────────────── */
/* ⚠️ 这是「尽力而为」，不是完整实现。真实 PDF 有加密、线性化、
      对象流（PDF 1.5+ 把对象压进 stream）等一堆变体。
   策略：
     ① 建「字体资源名 → ToUnicode 映射表」的关系。
        ★ 这一步是能否取对字的全部关键。第一版贪省事，把所有 ToUnicode
          合并成一张全局表，结果取出来的字全是乱码。
          原因：一份 PDF 里 6 个字体（SimHei/SimSun/Times/Wingdings…）
          都有各自的子集编码，**同一个 <0001> 在每个字体里是不同字**。
          合并 = 互相覆盖。
        PDF 的结构是两跳：
           内容流里 /F1 12 Tf        ← 这是资源名
           页面 /Resources /Font << /F1 8 0 R >>   ← 资源名 → 字体对象
           obj 8 有 /ToUnicode 10 0 R               ← 字体对象 → CMap
        所以要老老实实走完这两跳。
     ② 扫所有 stream，能解压的都解压，挑出含 BT/Tj 的内容流。
     ③ 按 Tf 切换当前字体，再抠 (…) 和 <…> 里的字符查表。
   取不出文字（扫描版）时返回空串，由调用方决定怎么办。 */

function latin1(b) {
  let s = '';
  const CH = 8192;
  for (let i = 0; i < b.length; i += CH) {
    s += String.fromCharCode.apply(null, b.subarray(i, i + CH));
  }
  return s;
}

function parseCMap(src) {
  const map = new Map();
  const hexToStr = (h) => {
    // 一个 bfchar 目标可以是多个 UTF-16 码元（连字、代理对），要全取
    let out = '';
    for (let i = 0; i + 4 <= h.length; i += 4) {
      out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    }
    return out;
  };
  // beginbfchar：<srcCode> <dstUnicode>
  for (const block of src.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(m[1], 16), hexToStr(m[2]));
    }
  }
  // beginbfrange：<lo> <hi> <dst>  或  <lo> <hi> [<d1> <d2> ...]
  for (const block of src.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g)) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
      if (m[3]) {
        const base = m[3];
        const baseNum = parseInt(base.slice(-4), 16);
        const prefix = base.slice(0, -4);
        for (let c = lo; c <= hi && c - lo < 65536; c++) {
          const cu = baseNum + (c - lo);
          map.set(c, hexToStr(prefix + cu.toString(16).padStart(4, '0')));
        }
      } else if (m[4]) {
        const items = [...m[4].matchAll(/<([0-9A-Fa-f]+)>/g)].map(x => x[1]);
        for (let i = 0; i < items.length && lo + i <= hi; i++) map.set(lo + i, hexToStr(items[i]));
      }
    }
  }
  return map;
}

/** 解开 PDF 内容流里的字符串字面量转义 */
function unescapePdf(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e) => {
    switch (e[0]) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'b': return '\b';
      case 'f': return '\f';
      case '(': return '(';
      case ')': return ')';
      case '\\': return '\\';
      default: return String.fromCharCode(parseInt(e, 8));
    }
  });
}

/** 取某个对象号的完整 chunk（从 `N 0 obj` 到对应 `endobj`）。
 *  对象内容里可能有嵌套的 stream……endstream，用 endobj 定位最省事。 */
function objChunk(src, objNum, genNum = 0) {
  const re = new RegExp(`(?:^|[^0-9])${objNum}\\s+${genNum}\\s+obj\\b`);
  const om = re.exec(src);
  if (!om) return null;
  const start = om.index + om[0].length;
  const end = src.indexOf('endobj', start);
  if (end < 0) return null;
  return { dict: src.slice(start, Math.min(end, start + 4000)), start, end };
}

/** 从一个对象 chunk 里取出 stream 数据（已去尾部 EOL，未解压）。 */
function streamBytesOf(b, src, start) {
  const chunkEnd = src.indexOf('endobj', start);
  const chunk = src.slice(start, chunkEnd);
  const sIdx = chunk.indexOf('stream');
  if (sIdx < 0) return null;
  let ds = start + sIdx + 6;
  while (b[ds] === 0x0d || b[ds] === 0x0a) ds++;
  let de = src.indexOf('endstream', ds);
  if (de < 0) return null;
  while (de > ds && (b[de - 1] === 0x0a || b[de - 1] === 0x0d)) de--;
  return b.subarray(ds, de);
}

export async function pdfToText(bytes) {
  if (!DS) throw new Error('这个环境没有 DecompressionStream');
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const src = latin1(b);

  /* ① 走两跳把「资源名 → CMap」建起来。
        第一跳：页面 /Resources /Font << /F1 8 0 R /F2 17 0 R ... >>
        第二跳：obj 8 的 /ToUnicode 10 0 R
        两跳都必须走，跳过任一步就只能得到乱码。 */
  const fontRefToCmap = new Map();   // 字体对象号 → CMap Map
  const resNameToObj = new Map();    // 资源名（如 F1）→ 字体对象号

  for (const fm of src.matchAll(/\/Font\s*<<([\s\S]*?)>>/g)) {
    for (const e of fm[1].matchAll(/\/([A-Za-z0-9_.+-]+)\s+(\d+)\s+(\d+)\s+R/g)) {
      // 同一个资源名可能被多个页面定义成不同对象；保留第一个即可，
      // 后面对不上的字体还有兜底（见下面 ③）。
      if (!resNameToObj.has(e[1])) resNameToObj.set(e[1], Number(e[2]));
    }
  }

  const cMapCache = new Map();
  async function cmapForFontObj(objNum) {
    if (cMapCache.has(objNum)) return cMapCache.get(objNum);
    const oc = objChunk(src, objNum, 0);
    let result = null;
    if (oc) {
      const tu = /\/ToUnicode\s+(\d+)\s+(\d+)\s+R/.exec(oc.dict);
      if (tu) {
        const tc = objChunk(src, tu[1], tu[2]);
        if (tc) {
          const raw = streamBytesOf(b, src, tc.start);
          let cmapSrc = tc.dict;
          if (raw) {
            try { cmapSrc = latin1(await inflateLoose(raw)); }
            catch (_) { cmapSrc = latin1(raw); }
          }
          result = parseCMap(cmapSrc);
        }
      }
      // 没有 ToUnicode 时的兜底：Type0 + Identity-H 的 CID 恰好等于
      // GBK 编码的情况很常见（老的中文 PDF 工具就爱这么写）。
      if (!result && /\/Encoding\s*\/Identity-H/.test(oc.dict)) result = null;
    }
    cMapCache.set(objNum, result);
    return result;
  }

  for (const [, objNum] of resNameToObj) {
    const cm = await cmapForFontObj(objNum);
    if (cm) fontRefToCmap.set(objNum, cm);
  }

  // 唯一的全局兜底表：把所有字体里出现过的映射收进来，只在按名字查不到时用
  const globalCmap = new Map();
  for (const cm of fontRefToCmap.values()) {
    for (const [k, v] of cm) if (!globalCmap.has(k)) globalCmap.set(k, v);
  }

  /* ② 扫所有 stream，筛出像内容流的。
        ★ 这里有个能把人卡一小时的坑：`/stream\r?\n/` 会匹配到 `endstream`
          末尾那 7 个字符（"endstream" 的后缀就是 "stream"）。于是每找到一个
          真流，紧接着就会匹配到它自己的 endstream，产出一段跨对象的垃圾。
          第一版没注意，结果把一张 JPEG 当成内容流，抠出 11000 字乱码。
          必须用后行断言把它排除掉。 */
  const pieces = [];
  const streamRe = /(?<!end)stream\r?\n/g;
  let m;
  while ((m = streamRe.exec(src)) !== null) {
    const dataStart = m.index + m[0].length;
    const endIdx = src.indexOf('endstream', dataStart);
    if (endIdx < 0) break;
    // 往回看对象字典，判断有没有 FlateDecode
    const dictStart = Math.max(0, src.lastIndexOf('obj', m.index));
    const dict = src.slice(dictStart, m.index);
    if (/\/Subtype\s*\/Image/.test(dict)) continue;   // 图片流里绝不会有文字，别浪费 CPU
    if (/\/Type\s*\/(XRef|ObjStm|Metadata)/.test(dict)) continue;
    if (/\/Subtype\s*\/Type0/.test(dict) || /\/Type\s*\/Font/.test(dict)) continue;
    const isFlate = /\/FlateDecode/.test(dict);
    // endstream 前面那个 EOL 不属于数据。PDF 规范说 Length 不含它，
    // 但现实里有没有含的，所以两头都试。
    let raw = b.subarray(dataStart, endIdx);
    while (raw.length && (raw[raw.length - 1] === 0x0a || raw[raw.length - 1] === 0x0d)) {
      raw = raw.subarray(0, raw.length - 1);
    }
    let text = null;
    if (isFlate) {
      try { text = latin1(await inflateLoose(raw)); } catch (_) { continue; }
    } else {
      text = latin1(raw);
    }
    // 内容流的特征：有 BT 和 Tj/TJ。字体、图像、元数据流里不会有。
    if (/\bBT\b/.test(text) && /\b(Tj|TJ)\b/.test(text)) pieces.push(text);
  }

  /* ③ 抠字符。★ 关键：跟着 `/F3 12 Tf` 切字体表。
        不带 Tf 的字符串用「当前字体」；一个内容流开头还没 Tf 时用全局兜底。 */
  let out = '';
  for (const content of pieces) {
    // 一次扫完：字体切换、换行、字符串三种 token 共用一条正则，保证顺序不乱
    const re = /\/([A-Za-z0-9_.+-]+)\s+[\d.]+\s+Tf|\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>|\bTd\b|\bTD\b|\bT\*\b/g;
    let cur = null;
    let t;
    while ((t = re.exec(content)) !== null) {
      const tok = t[0];
      if (tok.endsWith('Tf')) {
        const objNum = resNameToObj.get(t[1]);
        cur = objNum !== undefined ? (fontRefToCmap.get(objNum) || null) : null;
        continue;
      }
      if (tok === 'Td' || tok === 'TD' || tok === 'T*') {
        // 位置变化的两种语义分不清（同段内微调 vs 换行），
        // 但只要横向位移够大就换行，够用了
        if (out && !out.endsWith('\n')) out += '\n';
        continue;
      }
      const cmap = cur && cur.size ? cur : globalCmap;
      if (tok[0] === '(') {
        const s = unescapePdf(tok.slice(1, -1));
        if (cmap.size) {
          // 单字节码优先查表，查不到就原样保留（西文字体常常不需要 ToUnicode）
          let acc = '';
          for (let i = 0; i < s.length; i++) {
            const v = cmap.get(s.charCodeAt(i));
            acc += v !== undefined ? v : s[i];
          }
          out += acc;
        } else out += s;
      } else if (tok[0] === '<') {
        const hex = tok.slice(1, -1).replace(/\s+/g, '');
        // CID 字体是 2 字节一码；没有 CMap 时按 2 字节硬解会出乱码，
        // 所以没有 CMap 就只处理 ASCII 可打印范围。
        if (cmap.size) {
          for (let i = 0; i + 4 <= hex.length; i += 4) {
            const code = parseInt(hex.slice(i, i + 4), 16);
            const v = cmap.get(code);
            if (v !== undefined) out += v;
          }
        } else {
          for (let i = 0; i + 2 <= hex.length; i += 2) {
            const cu = parseInt(hex.slice(i, i + 2), 16);
            if (cu >= 32 && cu < 127) out += String.fromCharCode(cu);
          }
        }
      }
    }
    out += '\n';
  }

  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ── 入口 ─────────────────────────────────────────────── */

export const ACCEPT = '.txt,.md,.markdown,.csv,.json,.log,.docx,.pdf';

/**
 * 把 File/Blob 变成纯文本。
 * @returns {Promise<{text:string, kind:string, encoding?:string, note?:string}>}
 *   kind: text | docx | pdf | unsupported
 *   note: 给人看的说明（比如「扫描版 PDF」），调用方拿它提示用户
 */
export async function extractText(file) {
  const name = String(file.name || '');
  const ext = (name.match(/\.([A-Za-z0-9]+)$/) || [, ''])[1].toLowerCase();
  const buf = new Uint8Array(await file.arrayBuffer());

  if (!buf.length) return { text: '', kind: 'unsupported', note: '这个是空文件' };

  if (ext === 'docx') {
    try {
      const text = await docxToText(buf);
      return { text, kind: 'docx' };
    } catch (e) {
      return { text: '', kind: 'unsupported', note: `docx 解不开：${e.message}` };
    }
  }

  if (ext === 'pdf') {
    // 老 PDF 头部前面可能有垃圾字节，所以搜前 1KB
    const head = latin1(buf.subarray(0, Math.min(1024, buf.length)));
    if (!head.includes('%PDF')) return { text: '', kind: 'unsupported', note: '这个文件不像 PDF' };
    try {
      const text = await pdfToText(buf);
      // 少于 40 个「看起来像字」的字符就当作没有文字层——扫描版就是这样
      const real = (text.match(/[\u4e00-\u9fa5A-Za-z0-9]/g) || []).length;
      if (real < 40) {
        return {
          text: '', kind: 'pdf',
          note: '这是扫描版 PDF（或者文字是图片），里面没有可提取的文字层',
        };
      }
      return { text, kind: 'pdf' };
    } catch (e) {
      return { text: '', kind: 'unsupported', note: `pdf 解不开：${e.message}` };
    }
  }

  // 其余一律当文本处理。.doc 是 OLE 二进制，会解出乱码，
  // 所以单独拦下来给出明确提示，而不是让用户看到一屏方块。
  if (ext === 'doc') {
    return { text: '', kind: 'unsupported', note: '.doc 是老格式，浏览器解不了；请在 Word 里另存为 .docx 或 .txt' };
  }
  if (/^(png|jpe?g|gif|bmp|webp|heic)$/.test(ext)) {
    return { text: '', kind: 'unsupported', note: '图片里没有文字层，要提取得走 OCR' };
  }

  const { text, encoding } = decodeText(buf);
  return { text, kind: 'text', encoding };
}
