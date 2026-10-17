const ans = process.argv[2];
const es = await fetch('http://127.0.0.1:8900/events?s=t5');
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
        if (m.type === 'verdict') console.log('第'+m.seq+'句 →', m.verdict, '|', m.comment);
        if (m.type === 'replay_end') process.exit(0);
      }
    }
  }
})();
await new Promise(r => setTimeout(r, 300));
await fetch('http://127.0.0.1:8900/api/replay', {method:'POST',headers:{'Content-Type':'application/json'},body: JSON.stringify({session:'t5', text: ans, charsPerSecond: 4})});
setTimeout(()=>process.exit(0), 45000);
