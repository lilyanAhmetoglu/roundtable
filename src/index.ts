#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Room, note, seats, type Seat } from './room.js';
import { markdown, page } from './transcript.js';

// Clients cap how long a single tool call may run, so a blocking wait has to be
// short enough to return before that cap and let the agent call again. 55s sits
// under the common 60s floor.
const MAX_WAIT_SECONDS = 55;
const POLL_MS = 400;

interface Options {
  room: string;
  seat: Seat;
  agent: string;
  topic: string;
  budget: number;
  cwd: string;
  /** Where `transcript` writes. Unset means stdout, so the spec stays the only file a room leaves. */
  out?: string;
}

function parseArgs(argv: string[]): Options {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    else flags.set(arg.slice(2), argv[++i] ?? '');
  }
  const pick = (name: string, env: string, fallback = '') =>
    flags.get(name) ?? process.env[env] ?? fallback;

  const seat = pick('seat', 'ROUNDTABLE_SEAT', 'lead');
  if (seat !== 'lead' && seat !== 'peer') {
    throw new Error(`--seat must be "lead" or "peer", got "${seat}"`);
  }
  const budget = Number(pick('budget', 'ROUNDTABLE_BUDGET', '12'));
  if (!Number.isFinite(budget) || budget < 1) {
    throw new Error(`--budget must be a positive number, got "${budget}"`);
  }
  return {
    room: pick('room', 'ROUNDTABLE_ROOM', 'default'),
    seat,
    agent: pick('agent', 'ROUNDTABLE_AGENT', seat),
    topic: pick('topic', 'ROUNDTABLE_TOPIC', '(topic not set)'),
    budget,
    cwd: pick('cwd', 'ROUNDTABLE_CWD', process.cwd()),
    out: flags.get('out'),
  };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Write the two role prompts into the room directory, topic filled in.
 *
 * The prompts ship with this package and are the load-bearing part of the
 * protocol, so a caller that wants to start a room -- the Parallelo extension,
 * a script -- points its agents at these files rather than keeping its own copy
 * to drift out of date.
 */
function seed(options: Options): void {
  const room = new Room(options.cwd, options.room);
  const config = room.ensure(options.topic, options.budget);
  const packaged = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
  const written: string[] = [];
  for (const seat of ['lead', 'peer'] as const) {
    const template = fs.readFileSync(path.join(packaged, `${seat}.md`), 'utf8');
    const target = path.join(room.dir, `${seat}.md`);
    fs.writeFileSync(
      target,
      template.replaceAll('{{TOPIC}}', options.topic).replaceAll('{{SPEC}}', config.spec),
      'utf8'
    );
    written.push(target);
  }
  process.stdout.write(
    JSON.stringify({ room: options.room, dir: room.dir, spec: config.spec, prompts: written }, null, 2) + '\n'
  );
}

/**
 * Print the room as it fills.
 *
 * A room is otherwise invisible while it runs: both agents are inside tool
 * calls, and the peer in particular looks frozen because being parked in
 * `wait_for_message` is what a healthy peer does. This is how you see that
 * something is in fact happening.
 */
async function watch(options: Options): Promise<void> {
  const room = new Room(options.cwd, options.room);
  const config = room.config();
  if (!config) {
    process.stderr.write(`No room "${options.room}" under ${options.cwd}.\n`);
    process.exit(1);
  }
  process.stdout.write(
    `# ${config.topic}\n  room ${options.room}, budget ${config.budget}, ends with ${config.spec}\n\n`
  );
  let seen = 0;
  let lastStatus = '';
  for (;;) {
    // Reprint only on change, so the seat line is a state display rather than
    // scrolling noise between messages.
    const status = seats(room.dir)
      .map(s => {
        const state =
          s.calls === 0
            ? 'CONNECTED BUT NEVER STARTED - it has not been given its brief'
            : s.last === 'wait_for_message'
              ? 'parked, listening'
              : `last called ${s.last}`;
        return `  ${s.seat} (${s.agent || '?'}): ${state}`;
      })
      .join('\n');
    if (status && status !== lastStatus) {
      process.stdout.write(`\n[seats]\n${status}\n`);
      lastStatus = status;
    }
    for (const message of room.messages(seen)) {
      process.stdout.write(
        `\n[${message.seq}] ${message.seat} (${message.agent}) - ${message.kind}  ${message.at}\n${message.text}\n`
      );
      seen = message.seq;
    }
    const closure = room.closure();
    if (closure) {
      process.stdout.write(`\n--- closed: ${closure.reason}\n`);
      if (closure.specPath) process.stdout.write(`    spec: ${closure.specPath}\n`);
      return;
    }
    await sleep(700);
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const subcommand = argv[0] && !argv[0].startsWith('--') ? argv.shift() : undefined;
  if (subcommand === 'seed') {
    seed(parseArgs(argv));
    return;
  }
  if (subcommand === 'watch') {
    void watch(parseArgs(argv));
    return;
  }
  if (subcommand === 'transcript') {
    const options = parseArgs(argv);
    const room = new Room(options.cwd, options.room);
    if (!room.config()) {
      process.stderr.write(`No room "${options.room}" under ${options.cwd}.\n`);
      process.exit(1);
    }
    const wantsHtml = argv.includes('--html') || (options.out ?? '').endsWith('.html');
    const text = wantsHtml ? page(room) : markdown(room);
    if (options.out) {
      fs.writeFileSync(options.out, text);
      process.stderr.write(`${options.out}\n`);
    } else {
      process.stdout.write(text);
    }
    return;
  }
  if (subcommand === 'seats') {
    const options = parseArgs(argv);
    const room = new Room(options.cwd, options.room);
    process.stdout.write(JSON.stringify(seats(room.dir), null, 2) + '\n');
    return;
  }
  if (subcommand !== undefined) {
    process.stderr.write(`Unknown subcommand "${subcommand}". Use "seed", "watch", "seats" or "transcript", or no subcommand to run the server.\n`);
    process.exit(2);
  }
  const options = parseArgs(argv);
  const room = new Room(options.cwd, options.room);
  room.ensure(options.topic, options.budget);

  const me = options.seat;
  const other: Seat = me === 'lead' ? 'peer' : 'lead';
  const isLead = me === 'lead';

  // Highest sequence number this seat has already been shown. Starts at 0 so a
  // seat that joins late still receives the whole conversation on first read.
  let lastSeen = 0;

  const status = () => {
    const config = room.config();
    const closure = room.closure();
    return {
      room: options.room,
      topic: config?.topic ?? options.topic,
      you_are: me,
      your_agent: options.agent,
      round: room.round(),
      budget: config?.budget ?? options.budget,
      turn: room.turn(),
      your_turn: room.turn() === me,
      message_count: room.messages().length,
      closed: closure !== undefined,
      closed_reason: closure?.reason,
      spec: config?.spec,
      spec_path: closure?.specPath,
      transcript_dir: room.dir,
    };
  };

  const tools: Tool[] = [
    {
      name: 'room_status',
      description:
        'Where the discussion stands: whose turn it is, which round of the budget you are on, and whether the room has closed.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'read_room',
      description:
        'Read the messages posted so far. Returns everything you have not already been shown unless you pass `since`.',
      inputSchema: {
        type: 'object',
        properties: {
          since: {
            type: 'number',
            description: 'Return only messages after this sequence number. Omit to continue from where you left off.',
          },
        },
      },
    },
    {
      name: 'wait_for_message',
      description:
        `Block until the ${other} posts, then return their message. Returns {"idle": true} if nothing arrives before the timeout — call it again. Returns {"closed": true} when the room is over, which is your signal to stop. This is how you stay in the conversation; do not end your turn while the room is open.`,
      inputSchema: {
        type: 'object',
        properties: {
          timeout_seconds: {
            type: 'number',
            description: `How long to wait before returning idle. Default and maximum ${MAX_WAIT_SECONDS}.`,
          },
        },
      },
    },
    {
      name: 'post',
      description: isLead
        ? 'Post to the room. Each post you make consumes one round of the budget. Use it to set the brief, push back on the peer, or ask a narrower question.'
        : 'Post your reply to the room. Disagree where you actually disagree — agreeing to be agreeable wastes the round.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'What you want to say. Markdown, cite real file paths and line numbers.' },
          kind: {
            type: 'string',
            description: isLead
              ? 'brief | challenge | question | decision'
              : 'answer | objection | proposal | concession',
          },
        },
        required: ['text'],
      },
    },
  ];

  if (isLead) {
    tools.push({
      name: 'write_spec',
      description:
        'Write the plan. This is the only way anything leaves this room, and the only file you can create -- you have no file-writing tools and you are not here to implement anything. Call it once you have converged, then close_room.',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description:
              'The whole document, markdown. Decision first, then reasoning, then the work as steps, then a Dissent section in the peer\'s own words.'
          }
        },
        required: ['text']
      }
    });
    tools.push({
      name: 'close_room',
      description:
        'End the discussion. Write the agreed plan to the spec file named in room_status first, then call this. Defaults to that path.',
      inputSchema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why the room is closing: agreement reached, budget spent, or dead end.' },
          spec_path: { type: 'string', description: 'Path to the spec file you wrote.' },
        },
      },
    });
  }

  const server = new Server(
    { name: 'roundtable', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    note(room.dir, `list_tools seat=${me}`);
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    note(room.dir, `call seat=${me} tool=${request.params.name}`);
    const reply = (value: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    });
    const refuse = (text: string) => ({
      content: [{ type: 'text' as const, text }],
      isError: true,
    });

    switch (request.params.name) {
      case 'room_status':
        return reply(status());

      case 'read_room': {
        const since = typeof args.since === 'number' ? args.since : lastSeen;
        const messages = room.messages(since);
        if (messages.length > 0) lastSeen = Math.max(lastSeen, messages[messages.length - 1].seq);
        return reply({ messages, ...status() });
      }

      case 'wait_for_message': {
        const requested = typeof args.timeout_seconds === 'number' ? args.timeout_seconds : MAX_WAIT_SECONDS;
        const deadline = Date.now() + Math.min(Math.max(requested, 1), MAX_WAIT_SECONDS) * 1000;
        for (;;) {
          const closure = room.closure();
          if (closure) {
            return reply({ closed: true, reason: closure.reason, spec_path: closure.specPath });
          }
          const fresh = room.messages(lastSeen).filter(m => m.seat === other);
          if (fresh.length > 0) {
            lastSeen = Math.max(lastSeen, fresh[fresh.length - 1].seq);
            return reply({ messages: fresh, ...status() });
          }
          if (Date.now() >= deadline) {
            // Keep parking rather than returning early on a spent budget: the
            // close is still coming, and an early return would just spin the
            // peer through pointless turns until it arrived.
            const note =
              !isLead && room.outOfBudget() && room.turn() === 'lead'
                ? 'The round budget is spent. The lead is writing the spec. Wait again and you will get the close.'
                : undefined;
            return reply({ idle: true, note, ...status() });
          }
          await sleep(POLL_MS);
        }
      }

      case 'post': {
        const text = typeof args.text === 'string' ? args.text.trim() : '';
        if (!text) return refuse('post requires non-empty text.');
        if (room.closure()) return refuse('This room is closed. Stop posting and end your turn.');
        if (room.turn() !== me) {
          return refuse(
            `It is the ${other}'s turn. Call wait_for_message to receive their reply before posting again.`,
          );
        }
        if (isLead && room.outOfBudget()) {
          return refuse(
            `The round budget of ${room.config()?.budget} is spent. Write the spec file now, then call close_room.`,
          );
        }
        const kind = typeof args.kind === 'string' && args.kind ? args.kind : isLead ? 'brief' : 'answer';
        const message = room.append(me, options.agent, kind, text);
        lastSeen = Math.max(lastSeen, message.seq);
        return reply({ posted: message.seq, ...status() });
      }

      case 'write_spec': {
        if (!isLead) return refuse('Only the lead writes the spec.');
        const text = typeof args.text === 'string' ? args.text.trim() : '';
        if (!text) return refuse('write_spec requires the document text.');
        const written = room.writeSpec(text);
        return reply({ written, note: 'Now call close_room.' });
      }

      case 'close_room': {
        if (!isLead) return refuse('Only the lead can close the room.');
        // A room that ends with no spec produced nothing. Refusing here is the
        // only thing standing between "we discussed it" and a written decision.
        if (!room.hasSpec()) {
          return refuse(
            `There is no spec yet. Call write_spec with the full document before closing; it goes to ${room.config()?.spec}.`
          );
        }
        const reason = typeof args.reason === 'string' && args.reason ? args.reason : 'closed by lead';
        const specPath =
          typeof args.spec_path === 'string' && args.spec_path ? args.spec_path : room.config()?.spec;
        room.close(reason, specPath);
        return reply({ closed: true, reason, spec_path: specPath, transcript_dir: room.dir });
      }

      default:
        return refuse(`Unknown tool: ${request.params.name}`);
    }
  });

  note(room.dir, `connect seat=${me} agent=${options.agent} pid=${process.pid}`);
  process.on('exit', () => note(room.dir, `disconnect seat=${me} pid=${process.pid}`));

  const transport = new StdioServerTransport();
  void server.connect(transport);
}

main();
