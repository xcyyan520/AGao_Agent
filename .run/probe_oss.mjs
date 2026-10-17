/* 探 OSS：桶 xcyyan 在哪个 region、能不能 creds 登录。
   麻烦之处：不知道 region 就没法拼 endpoint。办法是先随便试一个，
   OSS 对「桶在别的 region」的请求会返回 x-oss-bucket-region 头告诉你正确值。 */
import crypto from 'node:crypto';

const BUCKET = 'xcyyan';
const AK = process.env.OSS_ACCESS_KEY_ID;
const SK = process.env.OSS_ACCESS_KEY_SECRET;

if (!AK || !SK) { console.error('缺 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET'); process.exit(2); }
console.log('AK 长度', AK.length, '/ SK 长度', SK.length);

/* OSS V1 签名：CanonicalizedResource 必须把子资源带上。
   第一版漏了 `?location`，于是每个 region 都回 SignatureDoesNotMatch——
   而「签名错」和「桶不在这个 region」都返回 403，很容易看错。 */
function sign(method, key, sub = '', contentType = '', date = new Date().toUTCString()) {
  const resource = `/${BUCKET}/${key}${sub ? '?' + sub : ''}`;
  const sts = `${method}\n\n${contentType}\n${date}\n${resource}`;
  const sig = crypto.createHmac('sha1', SK).update(sts).digest('base64');
  return { date, auth: `OSS ${AK}:${sig}` };
}

async function probe(region) {
  const host = `${BUCKET}.${region}.aliyuncs.com`;
  const { date, auth } = sign('GET', '');
  try {
    const r = await fetch(`https://${host}/`, {
      headers: { Date: date, Authorization: auth },
      signal: AbortSignal.timeout(12000),
    });
    const body = await r.text();
    return {
      region, host, status: r.status,
      bucketRegion: r.headers.get('x-oss-bucket-region'),
      body: body.slice(0, 200).replace(/\s+/g, ' '),
    };
  } catch (e) {
    return { region, host, error: e.message };
  }
}

const guesses = ['oss-cn-hangzhou', 'oss-cn-shanghai', 'oss-cn-beijing', 'oss-cn-shenzhen', 'oss-cn-qingdao', 'oss-cn-chengdu'];
for (const g of guesses) {
  const r = await probe(g);
  console.log(JSON.stringify(r));
  if (r.status === 200) { console.log(`\n✅ 就是 ${g}`); break; }
  if (r.bucketRegion && r.bucketRegion !== g) {
    console.log(`\n→ 真实 region 是 ${r.bucketRegion}`);
    const r2 = await probe(r.bucketRegion);
    console.log(JSON.stringify(r2));
    break;
  }
}
process.exit(0);
