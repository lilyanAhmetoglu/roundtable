# roundtable

A shared room where two coding agents argue through a plan before you build it.

You give the room a topic. Two agents — running in the same repository, in
separate terminals — take turns posting to a transcript on disk. One holds the
**lead** seat and drives; the other holds the **peer** seat and pushes back.
When they converge, or the round budget runs out, the lead writes a spec file
and closes the room.

## It does not know what an agent is

The room has two seats. It never learns which model or CLI is sitting in one.
Anything that speaks MCP can take either seat, including two instances of the
same thing:

| lead | peer | works |
| --- | --- | --- |
| Claude Code (Opus 5) | Codex | yes |
| Claude Code (Opus 5) | Claude Code (Opus 5) | yes |
| Copilot CLI | Claude Code | yes |

The seat and the room id are the only contract. Each seat is a separate process
with its own server, so there is no special case for two of the same agent —
the server cannot tell.

## Install

```bash
bun add -g roundtable-mcp
```

## Use it

Pick a room name, then register the server with each agent — **the same room,
different seats.**

Claude Code, in the terminal that will lead:

```bash
claude mcp add roundtable -- roundtable \
  --room cache-design --seat lead --agent "opus-5" \
  --topic "Should the cache be write-through" --budget 12
```

and in the terminal that will take the peer seat:

```bash
claude mcp add roundtable -- roundtable \
  --room cache-design --seat peer --agent "opus-5" \
  --topic "Should the cache be write-through" --budget 12
```

For an agent configured by file rather than CLI, the stdio entry is the usual
shape — only `--seat` differs between the two:

```json
{
  "mcpServers": {
    "roundtable": {
      "command": "roundtable",
      "args": ["--room", "cache-design", "--seat", "peer", "--agent", "codex"]
    }
  }
}
```

Every flag also reads from the environment (`ROUNDTABLE_ROOM`,
`ROUNDTABLE_SEAT`, `ROUNDTABLE_AGENT`, `ROUNDTABLE_TOPIC`, `ROUNDTABLE_BUDGET`,
`ROUNDTABLE_CWD`), which is easier when the agent's config format is awkward.

Then paste `prompts/lead.md` into one terminal and `prompts/peer.md` into the
other, with `{{TOPIC}}` filled in. **The seed prompts are not optional** — see
below.

## The seed prompts are the load-bearing part

MCP has no push. A server cannot wake an agent up. An agent only acts while its
own loop is running, and by default an agent answers once and then goes idle
waiting for a human.

Two things make a conversation out of that, and you need both:

1. **`wait_for_message` blocks.** The server holds the call open until the other
   seat posts. The waiting agent is parked *inside* a tool call — its turn is
   still alive. When the other seat posts, the call returns and it keeps going.
2. **The prompt has to say "loop".** The protocol cannot make an agent call
   `wait_for_message` again. `prompts/lead.md` and `prompts/peer.md` say it
   explicitly. Skip them and you get exactly one exchange, then silence.

Waits return after 55 seconds with `{"idle": true}` rather than blocking
forever, because MCP clients cap how long a single tool call may run. The
prompts tell the agent to call again on idle.

## Tools

Both seats get `room_status`, `read_room`, `wait_for_message`, and `post`. Only
the lead gets `close_room`.

The server enforces the rest, so an agent cannot talk its way around it:

- **Turn taking.** Posting out of turn is refused with an instruction to call
  `wait_for_message`. Neither seat can monologue.
- **Round budget.** Each lead post spends one round. At zero, the lead's posts
  are refused and it is told to write the spec and close.
- **Closure.** After `close_room`, posts are refused and any parked
  `wait_for_message` returns `{"closed": true}`.

Seats are set by the flag the server was launched with, not by anything the
agent says, so neither can claim the other's authority.

## What lands on disk

```
.roundtable/<room>/
  room.json              topic, budget, created
  closed.json            appears when the room ends
  messages/
    0001-....json        one file per message
```

Every message is its own file, written to a temp name and renamed into place.
Renames are atomic and nothing is ever mutated after it is written, so two
processes share a room without a lock. Round, turn, and closure are *derived*
from those files rather than stored, so there is no shared mutable state to
corrupt when an agent dies mid-turn.

The transcript is plain JSON in your repo. Read it, diff it, delete it. Add
`.roundtable/` to `.gitignore` if you would rather not keep it.

## What you get out

The lead writes a spec file itself, with its own file tools — the server never
writes your content. The prompt asks for the problem, the decision, the
reasoning, the steps, and a **Dissent** section holding anything the peer still
disagrees with, in its own words. That section is the point: two agents left
alone will converge into agreement, and the disagreement they flattened on the
way there is usually the part worth your attention.

## Things worth knowing before you run it

- **Two agents will talk forever.** They do not get bored and they do not run
  out of refinements. The round budget is not a safety rail, it is the
  termination condition. Twelve is a lot; eight is usually plenty.
- **It costs double.** Two premium agents reasoning over the same codebase.
  A room is worth it for a decision you would otherwise get wrong, not for
  choosing a variable name.
- **Both seats share the working directory.** If they both start editing files
  you have two agents writing to one worktree. Rooms are for planning; give the
  implementation to one agent afterwards.
- **The peer has no context from your session.** It reads the same `CLAUDE.md` /
  `AGENTS.md` in the same repo, but it did not see your conversation. The
  opening brief is the only handoff, so put the constraints in it.

## Reading a room afterwards

The transcript is one JSON file per message, which is right for two processes
sharing a directory without a lock and wrong for anyone who wants to know what
was said. `transcript` renders it:

```bash
roundtable transcript --room <name> --cwd <worktree>              # Markdown, to stdout
roundtable transcript --room <name> --cwd <worktree> --out r.html # a standalone page
```

Markdown for a terminal or an editor; HTML for a self-contained file with no
network dependency, readable in light or dark. Neither is written into the
worktree unless you name a path with `--out` — the spec stays the room's only
output.

It works on an open room too, and says so at the end instead of claiming a
close that has not happened.

## Development

```bash
bun install
bun run build
bun run smoke     # spawns two servers, checks they actually wake each other
```

The smoke test runs the same agent label in both seats on purpose.

## Licence

MIT
