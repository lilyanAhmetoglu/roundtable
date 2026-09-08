import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export type Seat = 'lead' | 'peer';

export interface Message {
  seq: number;
  at: string;
  seat: Seat;
  agent: string;
  kind: string;
  text: string;
}

export interface RoomConfig {
  room: string;
  topic: string;
  budget: number;
  /** Where the lead writes the plan. Fixed at creation so nobody has to guess. */
  spec: string;
  createdAt: string;
}

/**
 * A room is a directory of files. Every message is its own file, written with
 * write-to-temp-then-rename, so two agent processes can share a room without a
 * lock: renames are atomic and nobody ever mutates a file another process reads.
 *
 * Everything else is derived rather than stored, which is what keeps it honest:
 *   round  = how many times the lead has posted
 *   turn   = whoever did not send the last message (lead opens)
 *   closed = the closed.json file exists
 *
 * There is no shared mutable state to corrupt, so there is nothing to unwind
 * when an agent dies mid-turn.
 */
export class Room {
  readonly dir: string;
  private readonly messagesDir: string;

  constructor(readonly cwd: string, readonly name: string) {
    this.dir = path.join(cwd, '.roundtable', name);
    this.messagesDir = path.join(this.dir, 'messages');
  }

  /** Create the room if this is the first seat to arrive. Never overwrites. */
  ensure(topic: string, budget: number): RoomConfig {
    fs.mkdirSync(this.messagesDir, { recursive: true });

    // Everything under .roundtable is scaffolding -- prompts, server config,
    // the transcript. None of it belongs in a commit, and a directory that
    // ignores itself keeps it out without touching the repository's own
    // .gitignore or the shared exclude file. The spec is the output, and it is
    // written outside this directory precisely so it is the one thing that
    // shows up in the diff.
    const ignore = path.join(this.cwd, '.roundtable', '.gitignore');
    if (!fs.existsSync(ignore)) writeAtomic(ignore, '*\n');

    const configPath = path.join(this.dir, 'room.json');
    const existing = this.config();
    if (existing) return existing;
    const config: RoomConfig = {
      room: this.name,
      topic,
      budget,
      spec: `SPEC-${this.name}.md`,
      createdAt: new Date().toISOString(),
    };
    writeAtomic(configPath, JSON.stringify(config, null, 2) + '\n');
    return config;
  }

  config(): RoomConfig | undefined {
    return readJson<RoomConfig>(path.join(this.dir, 'room.json'));
  }

  messages(since = 0): Message[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.messagesDir);
    } catch {
      return [];
    }
    return names
      .filter(n => n.endsWith('.json'))
      .sort()
      .map(n => readJson<Message>(path.join(this.messagesDir, n)))
      .filter((m): m is Message => m !== undefined)
      .filter(m => m.seq > since);
  }

  append(seat: Seat, agent: string, kind: string, text: string): Message {
    fs.mkdirSync(this.messagesDir, { recursive: true });
    const seq = this.messages().length + 1;
    const message: Message = {
      seq,
      at: new Date().toISOString(),
      seat,
      agent,
      kind,
      text,
    };
    // Zero-padded seq keeps readdir().sort() in posting order; the random
    // suffix means two seats posting in the same instant both survive rather
    // than one silently clobbering the other.
    const file = `${String(seq).padStart(4, '0')}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.json`;
    writeAtomic(path.join(this.messagesDir, file), JSON.stringify(message, null, 2) + '\n');
    return message;
  }

  /** Lead posts are the unit of a round: one exchange back and forth. */
  round(): number {
    return this.messages().filter(m => m.seat === 'lead').length;
  }

  turn(): Seat {
    const all = this.messages();
    if (all.length === 0) return 'lead';
    return all[all.length - 1].seat === 'lead' ? 'peer' : 'lead';
  }

  closure(): { reason: string; specPath?: string; at: string } | undefined {
    return readJson(path.join(this.dir, 'closed.json'));
  }

  close(reason: string, specPath?: string): void {
    fs.mkdirSync(this.dir, { recursive: true });
    writeAtomic(
      path.join(this.dir, 'closed.json'),
      JSON.stringify({ reason, specPath, at: new Date().toISOString() }, null, 2) + '\n',
    );
  }

  /** True once the lead has used its round budget. */
  outOfBudget(): boolean {
    const budget = this.config()?.budget ?? Infinity;
    return this.round() >= budget;
  }

  /** Absolute path of the room's one output. */
  specPath(): string {
    return path.join(this.cwd, this.config()?.spec ?? `SPEC-${this.name}.md`);
  }

  hasSpec(): boolean {
    try {
      return fs.statSync(this.specPath()).size > 0;
    } catch {
      return false;
    }
  }

  /** Write the plan. The server owns this file so no agent needs a file tool. */
  writeSpec(text: string): string {
    const target = this.specPath();
    writeAtomic(target, text.endsWith('\n') ? text : text + '\n');
    return target;
  }

  transcript(): string {
    const all = this.messages();
    if (all.length === 0) return '_No messages yet._';
    return all
      .map(m => `### ${m.seq}. ${m.seat} (${m.agent}) — ${m.kind}\n\n${m.text}`)
      .join('\n\n');
  }
}

/**
 * Append a line to the room's log.
 *
 * A room that does not start is otherwise undiagnosable from outside: both
 * agents sit inside their own TUIs, and "connected but waiting", "never
 * connected", and "stopped at a dialog before it ever reached us" all look
 * identical from the transcript, which is empty in every case. The log
 * distinguishes them.
 */
/**
 * What each seat is actually doing, read back from the log.
 *
 * "Both agents are thinking" and "one of them never got its instructions" look
 * identical from outside -- the transcript is short either way and both
 * terminals look busy. A seat that has connected but never called anything has
 * not started; a seat whose last call was `wait_for_message` is parked and
 * listening, which is what a healthy idle seat looks like.
 */
export function seats(dir: string): { seat: string; agent: string; calls: number; last?: string }[] {
  let lines: string[];
  try {
    lines = fs.readFileSync(path.join(dir, 'server.log'), 'utf8').split('\n');
  } catch {
    return [];
  }
  const found = new Map<string, { seat: string; agent: string; calls: number; last?: string }>();
  for (const line of lines) {
    const seat = /\bseat=(\w+)/.exec(line)?.[1];
    if (!seat) continue;
    const entry = found.get(seat) ?? { seat, agent: '', calls: 0 };
    const agent = /\bagent=(.*?) pid=/.exec(line)?.[1];
    if (agent) entry.agent = agent;
    const tool = /\btool=(\w+)/.exec(line)?.[1];
    if (tool) {
      entry.calls++;
      entry.last = tool;
    }
    found.set(seat, entry);
  }
  return [...found.values()];
}

export function note(dir: string, line: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'server.log'), `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    // Logging must never take the server down with it.
  }
}

function writeAtomic(file: string, contents: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents, 'utf8');
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}
