/* 阿里云 OSS 上传（零依赖）
   ────────────────────────────────────────────────────────────
   ⚠️ 状态：**这个文件目前没有被任何地方 import。** 它是为「扫描版 PDF /
   图片走 OCR」预留的，那条路还没接。现在材料上传走的是浏览器里解析
   （index.html 里的 extractTextFromFile + filetext.mjs），压根不碰 OSS。
   留着的理由是它已经实测能上传成功（.run/probe_oss_put.mjs，7 项），
   以后接 OCR 不用重写一遍签名。**别误以为它在生效。**

   什么时候才用得上这个文件：

   材料的正路是「在浏览器里解析成纯文本 → POST /api/materials」。
   .md/.txt/.pdf/.docx 的解压和取字全在浏览器做（见 index.html 的
   extractTextFromFile），因为那份东西最终要落进 SQLite，存的是**字**，
   不是文件。把 20MB 的 pdf 传上来再转文字，多绕一圈还白占带宽。

   但有一类文件浏览器解不了：**扫描版 PDF / 图片**。它们没有文字层，
   得走 OCR，而 OCR 不在浏览器里做。这种才上传到 OSS 留个原件。

   ⚠️ 桶 xcyyan 在 oss-cn-beijing（实测，见 .run/probe_oss.mjs）。
      猜错 region 的报错是 "must be addressed using the specified endpoint"，
      会被误读成权限问题。 */
import crypto from 'node:crypto';

export const OSS = {
  bucket: process.env.OSS_BUCKET || 'xcyyan',
  region: process.env.OSS_REGION || 'oss-cn-beijing',
  accessKeyId: process.env.OSS_ACCESS_KEY_ID || '',
  accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET || '',
  /** 对外可读前缀。私有桶时这里是空的，改用签名 URL。 */
  publicBase: process.env.OSS_PUBLIC_BASE || '',
};

export function ossReady() {
  return Boolean(OSS.accessKeyId && OSS.accessKeySecret && OSS.bucket);
}

/** OSS V1 签名。CanonicalizedResource 必须带上子资源（?x-oss-...），
 *  漏了就是 SignatureDoesNotMatch——而这跟「桶不在这个 region」都是 403，
 *  排查时极易看错（.run/probe_oss.mjs 第一版就栽在这里）。 */
function signedHeaders(method, key, contentType = '', extra = {}) {
  const date = new Date().toUTCString();
  const resource = `/${OSS.bucket}/${key}`;
  const canon = Object.keys(extra).sort()
    .map(k => `${k.toLowerCase()}:${extra[k]}`).join('\n');
  const sts = `${method}\n\n${contentType}\n${date}\n${canon ? canon + '\n' : ''}${resource}`;
  const sig = crypto.createHmac('sha1', OSS.accessKeySecret).update(sts).digest('base64');
  const h = { Date: date, Authorization: `OSS ${OSS.accessKeyId}:${sig}` };
  if (contentType) h['Content-Type'] = contentType;
  for (const k of Object.keys(extra)) h[k] = extra[k];
  return h;
}

/** 把对象 key 规范化：去掉前导斜杠、把反斜杠换掉、拒绝 ..
 *  （路径穿越在对象存储里也是真问题——`../` 会把东西写到别的"目录"下）。 */
export function safeKey(key) {
  return String(key || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(s => s && s !== '.' && s !== '..')
    .join('/');
}

/**
 * 上传一段二进制到 OSS。
 * @param {string} key        对象名，如 uploads/u123/1729-abc.pdf
 * @param {Buffer} body
 * @param {string} contentType
 * @returns {Promise<{ok:true,key,url,size}|{ok:false,error,status?}>}
 */
export async function putObject(key, body, contentType = 'application/octet-stream') {
  if (!ossReady()) return { ok: false, error: 'OSS 未配置（缺 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET）' };
  const k = safeKey(key);
  if (!k) return { ok: false, error: 'key 为空' };
  const url = `https://${OSS.bucket}.${OSS.region}.aliyuncs.com/${k.split('/').map(encodeURIComponent).join('/')}`;
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: signedHeaders('PUT', k, contentType),
      body,
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      const t = (await res.text()).slice(0, 300);
      return { ok: false, status: res.status, error: t.replace(/\s+/g, ' ') };
    }
    const base = OSS.publicBase || `https://${OSS.bucket}.${OSS.region}.aliyuncs.com`;
    return { ok: true, key: k, url: `${base}/${k.split('/').map(encodeURIComponent).join('/')}`, size: body.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 生成一个不会撞的对象名：uploads/<session>/<时间戳>-<随机>.ext */
export function makeKey(sessionId, filename) {
  const ext = (/\.([A-Za-z0-9]{1,8})$/.exec(String(filename || '')) || [, 'bin'])[1].toLowerCase();
  const sid = String(sessionId || 'anon').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'anon';
  const rnd = crypto.randomBytes(4).toString('hex');
  return `uploads/${sid}/${Date.now()}-${rnd}.${ext}`;
}
