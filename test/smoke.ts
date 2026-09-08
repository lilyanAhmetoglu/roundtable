import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SERVER = path.join(process.env.HOME!, 'Desktop/projects/roundtable/dist/index.js');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'roundtable-smoke-'));

class Client {
  private id = 0;
  private buf = '';
  private pending = new Map<number, (v: any) => void>();
  constructor(private proc: ChildProcessWithoutNullStreams) {
    proc.stdout.on('data', d => {
      this.buf += d.toString();
      let nl;
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        this.pending.get(msg.id)?.(msg);
        this.pending.delete(msg.id);
      }
    });
  }
  send(method: string, params: any): Promise<any> {
    const id = ++this.id;
    return new Promise(resolve => {
      this.pending.set(id, resolve);
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async call(name: string, args: any = {}) {
    const r = await this.send('tools/call', { name, arguments: args });
    const text = r.result?.content?.[0]?.text ?? '';
    return { isError: !!r.result?.isError, text, json: safeJson(text) };
  }
  async init() {
    await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '1' },
    });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }
  kill() { this.proc.kill(); }
}
const safeJson = (t: string) => { try { return JSON.parse(t); } catch { return undefined; } };

function seat(seatName: string, agent: string, budget = 3) {
  return new Client(spawn('node', [
    SERVER, '--room', 'smoke', '--seat', seatName, '--agent', agent,
    '--topic', 'Should the cache be write-through', '--budget', String(budget), '--cwd', cwd,
  ], { stdio: ['pipe', 'pipe', 'inherit'] }) as ChildProcessWithoutNullStreams);
}

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail && !ok ? ` :: ${detail}` : ''}`);
  if (!ok) failures++;
};

const lead = seat('lead', 'opus-5');
const peer = seat('peer', 'opus-5');   // deliberately the SAME agent in both seats
await Promise.all([lead.init(), peer.init()]);

// Tool surface differs by seat.
const leadTools = (await lead.send('tools/list', {})).result.tools.map((t: any) => t.name);
const peerTools = (await peer.send('tools/list', {})).result.tools.map((t: any) => t.name);
check('lead has close_room', leadTools.includes('close_room'), leadTools.join());
check('peer has no close_room', !peerTools.includes('close_room'), peerTools.join());
check('peer has no write_spec', !peerTools.includes('write_spec'), peerTools.join());
check('lead has write_spec', leadTools.includes('write_spec'), leadTools.join());

// The peer parks in wait_for_message BEFORE the lead posts. This is the
// cross-process wake-up the whole design rests on.
const parked = peer.call('wait_for_message', { timeout_seconds: 20 });
await new Promise(r => setTimeout(r, 500));
const t0 = Date.now();
await lead.call('post', { text: 'Write-through, because reads dominate.', kind: 'brief' });
const woke = await parked;
check('parked peer woke on the lead post', woke.json?.messages?.[0]?.text?.startsWith('Write-through'), woke.text.slice(0, 160));
check('wake was prompt (<3s)', Date.now() - t0 < 3000, `${Date.now() - t0}ms`);

// Turn enforcement in both directions.
const outOfTurn = await lead.call('post', { text: 'and another thing', kind: 'challenge' });
check('lead cannot post twice in a row', outOfTurn.isError, outOfTurn.text);
await peer.call('post', { text: 'No: writes dominate at src/cache.ts:88.', kind: 'objection' });
const peerTwice = await peer.call('post', { text: 'also this', kind: 'objection' });
check('peer cannot post twice in a row', peerTwice.isError, peerTwice.text);

// Budget is counted in lead posts; 3 were allowed.
await lead.call('post', { text: 'Checked line 88, you are right.', kind: 'concession' });
await peer.call('post', { text: 'Then write-behind with a flush on commit.', kind: 'proposal' });
await lead.call('post', { text: 'Agreed.', kind: 'decision' });
await peer.call('post', { text: 'Watch the flush on crash.', kind: 'answer' });
const spent = await lead.call('post', { text: 'one more', kind: 'challenge' });
check('lead blocked once budget spent', spent.isError && spent.text.includes('close_room'), spent.text);

// A peer parked when the budget is gone must not hang until timeout.
const stranded = await peer.call('wait_for_message', { timeout_seconds: 2 });
check('peer told budget is spent rather than hanging', stranded.json?.idle === true && /budget is spent/.test(stranded.json?.note ?? ''), stranded.text.slice(0, 160));

// A room cannot end without producing anything.
const earlyClose = await lead.call('close_room', { reason: 'giving up' });
check('close refused with no spec', earlyClose.isError && /write_spec/.test(earlyClose.text), earlyClose.text);
const peerSpec = await peer.call('write_spec', { text: '# nope' });
check('peer cannot write the spec', peerSpec.isError, peerSpec.text);
await lead.call('write_spec', { text: '# Decision\n\nWrite-behind with a flush on commit.\n' });
check('spec landed on disk', fs.existsSync(path.join(cwd, 'SPEC-smoke.md')), 'missing');

// Close reaches a peer that is already parked.
const parkedForClose = peer.call('wait_for_message', { timeout_seconds: 20 });
await new Promise(r => setTimeout(r, 400));
await lead.call('close_room', { reason: 'agreement reached' });
const closed = await parkedForClose;
check('parked peer received the close', closed.json?.closed === true, closed.text.slice(0, 160));
const afterClose = await peer.call('post', { text: 'late', kind: 'answer' });
check('no posting after close', afterClose.isError, afterClose.text);

// Transcript survived on disk, in order, from two processes.
const dir = path.join(cwd, '.roundtable/smoke/messages');
const seqs = fs.readdirSync(dir).sort().map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).seq);
check('transcript is contiguous and ordered', JSON.stringify(seqs) === JSON.stringify([1, 2, 3, 4, 5, 6]), JSON.stringify(seqs));

lead.kill(); peer.kill();
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
