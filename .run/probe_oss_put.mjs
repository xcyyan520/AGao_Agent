/* 验证 oss.mjs 能真上传、能真读回。
   用一个 40 字节的文本对象，别拿大文件污染桶。 */
import { putObject, makeKey, ossReady, OSS } from '../oss.mjs';

console.log('OSS 配置：', { bucket: OSS.bucket, region: OSS.region, ready: ossReady() });
if (!ossReady()) process.exit(2);

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? (pass++, console.log('✓', n, extra)) : (fail++, console.log('✗', n, extra)); };

const key = makeKey('probe_oss', 'hello.txt');
console.log('对象名：', key);
const body = Buffer.from('同步思考 OSS 连通性探针 ' + new Date().toISOString(), 'utf8');
const r = await putObject(key, body, 'text/plain; charset=utf-8');
console.log('上传结果：', JSON.stringify(r).slice(0, 300));
ok('上传成功', r.ok === true, r.ok ? `url=${r.url}` : r.error);
ok('回传的 key 与请求一致', r.ok && r.key === key);
ok('回传 size 正确', r.ok && r.size === body.length);

if (r.ok) {
  const back = await fetch(r.url, { signal: AbortSignal.timeout(20000) });
  ok('能读回（200）', back.status === 200, `status=${back.status}`);
  const txt = await back.text();
  ok('内容一致', txt === body.toString('utf8'));
}

ok('safeKey 去掉路径穿越', (await import('../oss.mjs')).safeKey('../../etc/passwd') === 'etc/passwd');
ok('safeKey 处理反斜杠', (await import('../oss.mjs')).safeKey('a\\b\\c.txt') === 'a/b/c.txt');

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
