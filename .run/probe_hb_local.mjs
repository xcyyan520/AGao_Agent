const ac = new AbortController();
const t = setTimeout(() => ac.abort(), 13000);
const res = await fetch('http://127.0.0.1:8900/events?s=hb_test2', { signal: ac.signal });
console.log('HTTP', res.status, '| content-type:', res.headers.get('content-type'));
const rd = res.body.getReader();
const dec = new TextDecoder();
let buf = '', n = 0;
try {
  while (n < 3) {
    const { value, done } = await rd.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    n++;
    await new Promise(r => setTimeout(r, 4000));
  }
} catch (e) { /* abort */ }
clearTimeout(t);
const evts = buf.split('\n').filter(l => l.startsWith('data:'));
console.log('收到 data: 行数 =', evts.length);
evts.slice(0, 5).forEach(l => console.log('  ' + l.slice(0, 100)));
console.log('含 hb ?', /"type":"hb"/.test(buf));
process.exit(0);
