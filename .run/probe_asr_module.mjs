// 验证 asr.mjs 能独立跑：连上 → task-started → 送 1 秒静音 → finish。
// 不验证识别准确度（那需要真麦克风），只验证桥接层没写错。
import { AsrStream } from '../asr.mjs';

const { execSync } = await import('node:child_process');
const key = process.env.ASR_KEY
  || execSync('powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable(\'ALI_DEEPSEEK_API_KEY\',\'Machine\')"', { encoding: 'utf8' }).trim();

const a = new AsrStream({ apiKey: key });

a.on('started', () => console.log('✓ started'));
a.on('interim', p => console.log('  interim:', JSON.stringify(p.text)));
a.on('final', p => console.log('  final:', JSON.stringify(p.text)));
a.on('error', p => console.log('✗ error:', p.error.message));
a.on('closed', p => console.log('  closed:', p.code, p.reason));

const t0 = Date.now();
try {
  await a.start();
  console.log(`✓ start() 用了 ${Date.now() - t0}ms`);
} catch (e) {
  console.log('✗ start() 失败:', e.message);
  process.exit(1);
}

// 送 1 秒 16k 单声道 16bit 静音
a.push(Buffer.alloc(32000));
await new Promise(r => setTimeout(r, 500));
a.push(Buffer.alloc(32000));
console.log(`  送出去 ${a.bytes} 字节`);

const lines = await a.stop();
console.log(`✓ stop() 拿到 ${lines.length} 句定稿`);
process.exit(0);
