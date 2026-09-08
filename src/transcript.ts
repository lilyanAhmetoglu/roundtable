import { Room, seats, type Message, type RoomConfig } from './room.js';

/**
 * Render a finished room so a person can read it.
 *
 * A room's transcript is one JSON file per message, which is the right shape
 * for two processes sharing a directory without a lock and the wrong shape for
 * anyone who wants to know what was said. Without this, reading a discussion
 * needs an agent to do it for you -- which quietly makes the room depend on
 * whichever assistant you happened to have open. It should not.
 *
 * Markdown goes to a terminal or an editor; HTML is a single self-contained
 * file with no network dependency, so it opens from disk and reads in either
 * light or dark. Neither is written into the worktree unless asked for by
 * `--out`: the spec stays the room's only output.
 */

/** Lead posts are rounds; each round carries the peer replies that answered it. */
interface Round {
  n: number;
  messages: Message[];
}

function rounds(messages: Message[]): Round[] {
  const grouped: Round[] = [];
  for (const message of messages) {
    if (message.seat === 'lead' || grouped.length === 0) {
      if (message.seat === 'lead') {
        grouped.push({ n: grouped.length + 1, messages: [message] });
        continue;
      }
      // A peer message before the lead has spoken is out of protocol, but it
      // happened, so show it rather than dropping it on the floor.
      grouped.push({ n: 0, messages: [message] });
      continue;
    }
    grouped[grouped.length - 1].messages.push(message);
  }
  return grouped;
}

function duration(messages: Message[]): string {
  if (messages.length < 2) return '';
  const from = Date.parse(messages[0].at);
  const to = Date.parse(messages[messages.length - 1].at);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return '';
  const seconds = Math.round((to - from) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function markdown(room: Room): string {
  const config = room.config();
  const messages = room.messages();
  const closure = room.closure();
  const who = seats(room.dir);
  const out: string[] = [];

  out.push(`# ${config?.topic ?? room.name}`, '');
  out.push(`Room \`${room.name}\`. ${messages.length} messages over ${room.round()} of ${config?.budget ?? '?'} rounds.`);
  for (const seat of who) {
    out.push(`- **${seat.seat}** — ${seat.agent || 'unknown agent'}`);
  }
  const span = duration(messages);
  if (span) out.push('', `Ran for ${span}.`);
  out.push('');

  for (const round of rounds(messages)) {
    out.push('---', '', `## Round ${round.n}`, '');
    for (const message of round.messages) {
      out.push(`### ${message.seat} · ${message.agent}`, '', message.text.trim(), '');
    }
  }

  out.push('---', '');
  if (closure) {
    out.push(`Closed: ${closure.reason}`);
    if (closure.specPath) out.push('', `Spec: \`${closure.specPath}\``);
  } else {
    out.push('Still open — this room has not been closed.');
  }
  return out.join('\n') + '\n';
}

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Just enough of the agents' own markdown to read as prose rather than source. */
function inline(text: string): string {
  return escape(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function blocks(text: string): string {
  const out: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | undefined;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = undefined;
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) {
      flushPara();
      flushList();
      continue;
    }
    const heading = /^#{2,4}\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const numbered = /^\d+\.\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      out.push(`<h3>${inline(heading[1])}</h3>`);
    } else if (bullet || numbered) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      if (list?.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push((bullet ?? numbered)![1]);
    } else if (list) {
      // A wrapped continuation of the item above it.
      list.items[list.items.length - 1] += ' ' + line;
    } else {
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return out.join('\n');
}

export function page(room: Room): string {
  const config = room.config() ?? ({} as Partial<RoomConfig>);
  const messages = room.messages();
  const closure = room.closure();
  const who = seats(room.dir);
  const span = duration(messages);

  const facts: [string, string][] = [];
  for (const seat of who) facts.push([seat.seat, seat.agent || 'unknown']);
  facts.push(['Messages', String(messages.length)]);
  facts.push(['Rounds', `${room.round()} / ${config.budget ?? '?'}`]);
  if (span) facts.push(['Duration', span]);

  const body = rounds(messages)
    .map(round => {
      const head = `<div class="round"><span class="round-n">Round ${round.n}</span><span class="round-rule"></span></div>`;
      const said = round.messages
        .map(
          message => `<article class="msg ${message.seat}">
<header class="msg-head"><span class="seat">${escape(message.seat)}</span><span class="agent">${escape(message.agent)}</span></header>
<div class="msg-body">${blocks(message.text)}</div>
</article>`
        )
        .join('\n');
      return head + '\n' + said;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(config.topic ?? room.name)}</title>
<style>
:root{
  --ground:#F4F5F7;--panel:#FFF;--ink:#1A1D24;--ink-soft:#565C69;
  --rule:#DCDFE5;--rule-soft:#E9EBEF;
  --lead:#274B7A;--lead-wash:#EDF1F7;--peer:#7A2C3A;--peer-wash:#F7EDEF;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --serif:Georgia,"Iowan Old Style","Times New Roman",serif;
}
@media (prefers-color-scheme:dark){:root{
  --ground:#12141A;--panel:#181B22;--ink:#E6E8ED;--ink-soft:#9BA3B2;
  --rule:#2A2F3A;--rule-soft:#222630;
  --lead:#8FB3DE;--lead-wash:#1A2230;--peer:#DE9AA6;--peer-wash:#2A1D21;
}}
*{box-sizing:border-box}
body{background:var(--ground);color:var(--ink);font-family:var(--serif);
  font-size:17px;line-height:1.62;margin:0;padding:0 20px 80px}
.wrap{max-width:720px;margin:0 auto}
header.masthead{padding:56px 0 26px;border-bottom:2px solid var(--ink)}
.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.16em;
  text-transform:uppercase;color:var(--ink-soft);margin:0 0 14px}
h1{font-size:36px;line-height:1.12;margin:0;text-wrap:balance;letter-spacing:-.015em}
dl.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));
  gap:1px;background:var(--rule);border:1px solid var(--rule);border-top:none;margin:0}
dl.facts>div{background:var(--panel);padding:13px 15px}
dl.facts dt{font-family:var(--mono);font-size:10px;letter-spacing:.13em;
  text-transform:uppercase;color:var(--ink-soft);margin:0 0 5px}
dl.facts dd{font-family:var(--mono);font-size:14px;margin:0;font-variant-numeric:tabular-nums}
.round{display:flex;align-items:center;gap:12px;margin:48px 0 24px}
.round-n{font-family:var(--mono);font-size:11px;font-weight:600;letter-spacing:.15em;
  text-transform:uppercase}
.round-rule{flex:1;height:1px;background:var(--rule)}
.msg{border-left:3px solid;padding:2px 0 2px 20px;margin:0 0 28px}
.msg.lead{border-color:var(--lead)}
.msg.peer{border-color:var(--peer);margin-left:clamp(0px,4vw,44px)}
.msg-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:9px}
.seat{font-family:var(--mono);font-size:11px;font-weight:600;letter-spacing:.15em;
  text-transform:uppercase}
.lead .seat{color:var(--lead)}
.peer .seat{color:var(--peer)}
.agent{font-family:var(--mono);font-size:11px;color:var(--ink-soft)}
.msg-body>*:first-child{margin-top:0}
.msg-body>*:last-child{margin-bottom:0}
.msg-body p{margin:0 0 14px}
.msg-body h3{font-family:var(--mono);font-size:12px;font-weight:600;letter-spacing:.1em;
  text-transform:uppercase;color:var(--ink-soft);margin:22px 0 9px}
.msg-body ul,.msg-body ol{margin:0 0 14px;padding-left:22px}
.msg-body li{margin:0 0 7px}
code{font-family:var(--mono);font-size:.86em;background:var(--rule-soft);
  padding:.1em .32em;border-radius:2px;overflow-wrap:break-word}
.lead code{background:var(--lead-wash)}
.peer code{background:var(--peer-wash)}
.outcome{margin-top:48px;border-top:2px solid var(--ink);padding-top:22px;
  font-family:var(--mono);font-size:14px}
.outcome .path{color:var(--ink-soft)}
@media (max-width:560px){h1{font-size:28px}body{font-size:16px}}
</style>
</head>
<body>
<div class="wrap">
<header class="masthead">
<p class="eyebrow">Roundtable transcript &middot; room ${escape(room.name)}</p>
<h1>${escape(config.topic ?? room.name)}</h1>
</header>
<dl class="facts">
${facts.map(([k, v]) => `<div><dt>${escape(k)}</dt><dd>${escape(v)}</dd></div>`).join('\n')}
</dl>
${body}
<section class="outcome">
${
  closure
    ? `Closed: ${escape(closure.reason)}` +
      (closure.specPath ? `<br><span class="path">${escape(closure.specPath)}</span>` : '')
    : 'Still open &mdash; this room has not been closed.'
}
</section>
</div>
</body>
</html>
`;
}
