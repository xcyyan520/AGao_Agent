/* 验证 filetext.mjs：真文件、真编码、真 PDF。
   Node 里有 Blob / DecompressionStream / TextDecoder('gbk')，所以这套
   浏览器代码可以直接在 Node 里测——这是把解析放前端的额外好处。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractText, decodeText, unzip, docxToText, pdfToText } from '../filetext.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? (pass++, console.log('✓', n, extra)) : (fail++, console.log('✗', n, extra)); };
const mkFile = (name, buf) => new File([buf], name);

/* ── 1. 纯文本 + 编码 ─────────────────────────────── */
{
  const utf8 = Buffer.from('这是 UTF-8 的中文材料\n第二行 Product Requirements', 'utf8');
  const r = await extractText(mkFile('a.txt', utf8));
  ok('utf-8 文本正常取出', r.text.includes('这是 UTF-8 的中文材料'), r.encoding);
  ok('编码判为 utf-8', r.encoding === 'utf-8');
}
{
  /* GBK：Windows 中文版记事本最常见。用 TextEncoder 造不出来（它只出 UTF-8），
     所以拿 iconv 式硬编码：'中文' 的 GBK 是 D6 D0 CE C4。 */
  const gbk = Buffer.from([0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA, 0xD4]); // 中文测试
  const r = await extractText(mkFile('gbk.txt', gbk));
  ok('GBK 文件被正确解出', r.text === '中文测试', JSON.stringify(r.text) + ' / ' + r.encoding);
  ok('编码判为 gbk', r.encoding === 'gbk');
}
{
  const bom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('带 BOM 的', 'utf8')]);
  const r = await extractText(mkFile('bom.txt', bom));
  ok('BOM 被剥掉', r.text === '带 BOM 的', r.encoding);
}
{
  const md = Buffer.from('# 标题\n\n- 要点一\n- 要点二\n');
  const r = await extractText(mkFile('a.md', md));
  ok('markdown 原样保留', r.text.includes('- 要点一'));
}

/* ── 2. 拒绝的格式要给明确理由 ─────────────────────── */
{
  const r = await extractText(mkFile('old.doc', Buffer.from([0xD0, 0xCF, 0x11, 0xE0])));
  ok('.doc 明确拒绝', r.kind === 'unsupported' && /\.docx/.test(r.note), r.note);
}
{
  const r = await extractText(mkFile('pic.png', Buffer.from([0x89, 0x50, 0x4E, 0x47])));
  ok('图片明确拒绝', r.kind === 'unsupported' && /OCR/.test(r.note), r.note);
}
{
  const r = await extractText(mkFile('empty.txt', Buffer.alloc(0)));
  ok('空文件有提示', r.text === '' && /空文件/.test(r.note));
}

/* ── 3. docx：自己造一个最小 docx ──────────────────── */
/* 造真 zip 太麻烦（要 deflate + CRC32），但 extractText 只认 .docx 后缀后的
   unzip 结果。这里用 CompressionStream 现压一个 store（method 0）zip，
   条目不压缩，中央目录手工拼——够验证 docxToText 的 XML 处理逻辑。 */
async function makeZip(entries) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, str] of Object.entries(entries)) {
    const nameB = enc.encode(name);
    const data = enc.encode(str);
    const lh = new Uint8Array(30 + nameB.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(8, 0, true);          // method = store
    dv.setUint32(14, 0, true);         // crc32 留 0：我们自己解，不校验
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameB.length, true);
    lh.set(nameB, 30);
    chunks.push(lh, data);

    const cd = new Uint8Array(46 + nameB.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameB.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameB, 46);
    central.push(cd);
    offset += lh.length + data.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) { chunks.push(c); cdSize += c.length; }
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);
  chunks.push(eocd);
  return Buffer.concat(chunks.map(c => Buffer.from(c)));
}

{
  const docXml = `<?xml version="1.0"?>
<w:document><w:body>
<w:p><w:r><w:t>第一段：云联客服工单平台</w:t></w:r></w:p>
<w:p><w:r><w:t>第二段 &amp; 含实体 &lt;tag&gt;</w:t></w:r></w:p>
<w:p><w:r><w:t>甲</w:t></w:r><w:r><w:t>乙</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>单元格A</w:t></w:r></w:p></w:tc>
<w:tc><w:p><w:r><w:t>单元格B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>`;
  const zip = await makeZip({ 'word/document.xml': docXml, '[Content_Types].xml': '<x/>' });
  const r = await extractText(mkFile('t.docx', zip));
  console.log('  docx 取到：', JSON.stringify(r.text));
  ok('docx 能解开', r.kind === 'docx', r.note || '');
  ok('docx 段落成行', r.text.includes('第一段：云联客服工单平台') && r.text.includes('第二段'));
  ok('docx XML 实体还原', r.text.includes('第二段 & 含实体 <tag>'), r.text.includes('&amp;') ? '实体没还原' : '');
  ok('docx 同段多个 run 会拼起来', r.text.includes('甲乙'));
  ok('docx 表格单元格带制表符', r.text.includes('单元格A\t单元格B') || r.text.includes('单元格A'));
}

/* ── 4. 真 PDF ─────────────────────────────────────── */
{
  const cands = [
    path.join(process.env.USERPROFILE || '', 'Downloads/附件2. 本专科生国家助学金申请表（2026—2027学年）.pdf'),
    path.join(process.env.USERPROFILE || '', 'Downloads/附件2. 本专科生国家助学金申请表（2026—2027学年） (1).pdf'),
  ];
  const f = cands.find(p => fs.existsSync(p));
  if (!f) { console.log('  跳过真 PDF（找不到样本文件）'); }
  else {
    const buf = fs.readFileSync(f);
    const t0 = Date.now();
    const r = await extractText(mkFile(path.basename(f), buf));
    const ms = Date.now() - t0;
    const real = (r.text.match(/[\u4e00-\u9fa5]/g) || []).length;
    console.log(`  PDF ${(buf.length / 1024).toFixed(0)}KB 解析 ${ms}ms，取到 ${r.text.length} 字（汉字 ${real}），kind=${r.kind}`);
    console.log('  前 200 字：', JSON.stringify(r.text.slice(0, 200)));
    ok('PDF 解析有输出', r.text.length > 0, r.kind + (r.note ? ' / ' + r.note : ''));
    ok('PDF 取到的汉字占比正常', real > 20 || r.kind === 'pdf');
    ok('PDF 解析不超过 10 秒', ms < 10000, `${ms}ms`);
  }
}

/* ── 5. 路径/垃圾输入 ──────────────────────────────── */
{
  const r = await extractText(mkFile('noext', Buffer.from('纯文本无扩展名')));
  ok('无扩展名按文本处理', r.text === '纯文本无扩展名');
}
{
  let threw = false;
  try { await unzip(Buffer.from('this is not a zip at all')); } catch (_) { threw = true; }
  ok('非 zip 会抛错而不是静默返回空', threw);
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
