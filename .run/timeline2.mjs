const ans = process.argv[2];
const start = Date.now();
const out = [];
const es = await fetch('http://127.0.0.1:8900/events?s=t4');
const reader = es.body.getReader(); const dec = new TextDecoder();
(async () => {
  let buf = '';
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2);
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const m = JSON.parse(line.slice(6));
        if (m.type === 'chunk') out.push([Date.now()-start, 'chunk', JSON.stringify((m.text||'').slice(0,20))]);
        else if (m.type === 'judging') out.push([Date.now()-start, 'judging', '第'+m.seq+'句']);
        else if (m.type === 'verdict') out.push([Date.now()-start, 'verdict', m.verdict, m.comment.slice(0,26)]);
        if (m.type === 'replay_end') {
          for (const r of out) console.log(String(r[0]).padStart(6), r[1].padEnd(9), r.slice(2).join(' | '));
          process.exit(0);
        }
      }
    }
  }
})();
await new Promise(r => setTimeout(r, 300));
await fetch('http://127.0.0.1:8900/api/replay', {method:'POST',headers:{'Content-Type':'application/json'},body: JSON.stringify({session:'t4', text: ans, charsPerSecond: 4})});
setTimeout(()=>process.exit(0), 70000);
