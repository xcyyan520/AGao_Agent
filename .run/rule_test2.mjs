const cases = [
  '不用加锁，redis 单线程',
  '那这',
  '需要加锁吗',
  '我们压测用的 JMeter，QPS 一万二',
  '索引加得越多越快',
  'int 最大值是 21 亿'
];
for (const c of cases) {
  const body = JSON.stringify({ model:'fake', stream:false, messages:[{role:'user',content:'[chunk] '+c+'\n\n现在只针对这一块给出判断，并更新工作记忆。'}] });
  const r = await fetch('http://127.0.0.1:8901/v1/chat/completions', {method:'POST',headers:{'Content-Type':'application/json'},body});
  const j = await r.json();
  const obj = JSON.parse(j.choices[0].message.content);
  console.log(obj.verdict.padEnd(9), '<-', c, obj.dive ? ('| 追问: '+obj.dive.slice(0,22)) : '');
}
