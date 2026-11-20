// git smart HTTP: info/refs (v0 and v2 advertisements), git-upload-pack
// (v0 and v2 fetch, ls-refs) and git-receive-pack (push with report-status).
//
// The wire shapes here are the ones the suite's client (git-client.ts)
// parses: pkt-lines, sideband framing, section delimiters, and the exact
// capability strings it looks for. Packs carry full objects only; the
// client never sends deltas and accepts a pack with zero deltas.

import {
  decodePktLines,
  encodePktLines,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  writePack,
  ZERO_OID,
  type PackObject,
  type Repo,
  type Store,
} from './store.ts';

const AGENT = 'forge/1.0';
const UPLOAD_CAPS_V0 = 'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta multi_ack shallow agent=forge/1.0';
const RECEIVE_CAPS_V0 = 'symref=HEAD:refs/heads/main report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';

export interface GitAnswer {
  status: number;
  contentType: string;
  body: Buffer;
}

function textAnswer(status: number, text: string): GitAnswer {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: text }), 'utf8') };
}

function notFound(): GitAnswer {
  return textAnswer(404, 'Not Found');
}

/** All refs of a repo, sorted heads first then tags, as (oid, name) pairs. */
function sortedRefs(repo: Repo): Array<{ oid: string; name: string }> {
  const out: Array<{ oid: string; name: string }> = [];
  for (const [name, oid] of repo.refs) out.push({ oid, name });
  out.sort((a, b) => {
    const rank = (name: string): number => (name.startsWith('refs/heads/') ? 0 : name.startsWith('refs/tags/') ? 1 : 2);
    return rank(a.name) - rank(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  });
  return out;
}

/** The peeled commit of an annotated tag, or null when the ref is not a tag. */
function peeledOf(store: Store, repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  const peeled = store.peelToCommit(repo, oid);
  return peeled === oid ? null : peeled;
}

// ---------------------------------------------------------------- info/refs

function v0Advertisement(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const lines: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get('refs/heads/main') ?? ZERO_OID;
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    lines.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      lines.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledOf(store, repo, ref.oid);
      if (peeled !== null) lines.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

function v2Advertisement(service: 'git-upload-pack'): Buffer {
  const lines: Buffer[] = [
    pktLine(`# service=${service}\n`),
    pktFlush(),
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ];
  return Buffer.concat(lines);
}

export function infoRefs(
  store: Store,
  repo: Repo | undefined,
  service: string,
  version2: boolean,
): GitAnswer {
  if (repo === undefined) return notFound();
  if (service === 'git-upload-pack') {
    if (version2) {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement(service) };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0Advertisement(store, repo, service) };
  }
  if (service === 'git-receive-pack') {
    // Receive-pack is v0-only: the client throws if it is not.
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement(store, repo, service) };
  }
  return textAnswer(400, 'unknown service');
}

// ---------------------------------------------------------------- upload-pack

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallowBoundaries: string[];
  depth: number | null;
}

/** Parse a v2 upload-pack request body into its command and arguments. */
function parseV2Request(body: Buffer): { command: string; args: FetchArgs } {
  const packets = decodePktLines(body);
  let command = '';
  const args: FetchArgs = { wants: [], haves: [], shallowBoundaries: [], depth: null };
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      continue;
    }
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isSafeInteger(n) && n > 0) args.depth = n;
    }
    // thin-pack, no-progress, ofs-delta, agent, object-format, done, filter: ignored
  }
  return { command, args };
}

/** Parse a v0 upload-pack request body (wants, then haves, two flushes). */
function parseV0Request(body: Buffer): FetchArgs {
  const packets = decodePktLines(body);
  const args: FetchArgs = { wants: [], haves: [], shallowBoundaries: [], depth: null };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        const space = rest.indexOf(' ');
        args.wants.push((space < 0 ? rest : rest.slice(0, space)).trim());
      } else if (line.startsWith('shallow ')) args.shallowBoundaries.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = Number(line.slice(7).trim());
        if (Number.isSafeInteger(n) && n > 0) args.depth = n;
      }
    } else if (line.startsWith('have ')) {
      args.haves.push(line.slice(5).trim());
    }
  }
  return args;
}

/** Wrap pack bytes in sideband band-1 pkt-lines (plus a closing flush). */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const framed = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pktLine(framed));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface FetchPlan {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

/** Work out what a fetch sends: reachable(wants) minus reachable(haves), depth-limited. */
function planFetch(store: Store, repo: Repo, args: FetchArgs): FetchPlan {
  const wants = args.wants.filter((oid) => store.hasObject(repo, oid));
  const haves = args.haves.filter((oid) => store.hasObject(repo, oid));
  const maxDepth = args.depth ?? undefined;
  const wanted = store.reachableObjects(repo, wants, { maxDepth });
  const held = store.reachableObjects(repo, haves, { cutoffs: new Set(args.shallowBoundaries) });
  const send: PackObject[] = [];
  for (const [oid, object] of wanted.objects) {
    if (!held.objects.has(oid)) send.push(object);
  }
  // Shallow boundaries: the commits at the depth cut-off that still have parents.
  const shallow: string[] = [];
  if (args.depth !== null) {
    for (const [oid, generation] of wanted.commitGenerations) {
      if (generation !== args.depth - 1) continue;
      const commit = store.getCommit(repo, oid);
      if (commit !== null && commit.parents.length > 0) shallow.push(oid);
    }
  }
  // Unshallow: the client's old boundaries that are now fully included.
  const unshallow: string[] = [];
  for (const boundary of args.shallowBoundaries) {
    const generation = wanted.commitGenerations.get(boundary);
    if (generation === undefined) continue;
    const fullyIncluded = args.depth === null || generation < args.depth - 1;
    if (fullyIncluded) unshallow.push(boundary);
  }
  const acks = haves;
  return { pack: writePack(send), shallow, unshallow, acks };
}

function lsRefsResponse(store: Store, repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data' || !inArgs) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    // unborn is never requested: the server does not advertise it.
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headOid = repo.refs.get('refs/heads/main');
  if (symrefs && headOid !== undefined && keep('HEAD')) {
    parts.push(pktLine(`${headOid} HEAD symref-target:refs/heads/main\n`));
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = peeledOf(store, repo, ref.oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function fetchV2Response(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktDelim());
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(plan.pack));
  return Buffer.concat(parts);
}

function fetchV0Response(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(plan.pack));
  return Buffer.concat(parts);
}

export function uploadPack(
  store: Store,
  repo: Repo | undefined,
  body: Buffer,
  version2: boolean,
): GitAnswer {
  if (repo === undefined) return notFound();
  try {
    if (version2) {
      const { command, args } = parseV2Request(body);
      if (command === 'ls-refs') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefsResponse(store, repo, body) };
      }
      if (command === 'fetch') {
        const plan = planFetch(store, repo, args);
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV2Response(plan) };
      }
      return textAnswer(400, `unknown command ${command}`);
    }
    const args = parseV0Request(body);
    const plan = planFetch(store, repo, args);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV0Response(plan) };
  } catch (err) {
    return textAnswer(400, err instanceof Error ? err.message : 'bad upload-pack request');
  }
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Split a receive-pack body into command lines and the pack that follows. */
function parseReceiveBody(body: Buffer): { commands: PushCommand[]; sideband: boolean; pack: Buffer } {
  const commands: PushCommand[] = [];
  let sideband = false;
  let offset = 0;
  let packStart = body.length;
  while (offset + 4 <= body.length) {
    const lenText = body.subarray(offset, offset + 4).toString('ascii');
    const len = parseInt(lenText, 16);
    if (Number.isNaN(len) || len < 0) break;
    if (len === 0) {
      offset += 4;
      packStart = offset;
      break;
    }
    if (offset + len > body.length) break;
    const payload = body.subarray(offset + 4, offset + len);
    offset += len;
    const line = payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    let caps = '';
    let command = line;
    if (nul >= 0) {
      command = line.slice(0, nul);
      caps = line.slice(nul + 1);
      if (caps.split(' ').includes('side-band-64k')) sideband = true;
    }
    const parts = command.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
  }
  return { commands, sideband, pack: body.subarray(packStart) };
}

/** Whether `ancestor` is reachable from `descendant` (tags peeled first). */
function isAncestor(store: Store, repo: Repo, ancestor: string, descendant: string): boolean {
  const target = store.peelToCommit(repo, ancestor);
  let cursor: string | null = store.peelToCommit(repo, descendant);
  const seen = new Set<string>();
  const stack: string[] = cursor === null ? [] : [cursor];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === target) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = store.getCommit(repo, oid);
    if (commit === null) continue;
    for (const parent of commit.parents) stack.push(parent);
  }
  return false;
}

export function receivePack(store: Store, repo: Repo | undefined, body: Buffer): GitAnswer {
  if (repo === undefined) return notFound();
  let commands: PushCommand[] = [];
  let sideband = false;
  let pack = Buffer.alloc(0);
  try {
    const parsed = parseReceiveBody(body);
    commands = parsed.commands;
    sideband = parsed.sideband;
    pack = parsed.pack;
  } catch (err) {
    return reportReceive([], `unpack ${err instanceof Error ? err.message : 'bad request'}`, false);
  }
  if (commands.length === 0) {
    return reportReceive([], 'unpack no commands', sideband);
  }
  // Unpack first: the report says `unpack ok` even when a ref is refused.
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      const { objects } = readPack(pack);
      for (const [oid, object] of objects) {
        const actual = store.putObject(repo, object.type, object.data);
        if (actual !== oid) throw new Error(`pack object ${oid} does not hash to itself`);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const lines: string[] = [];
  lines.push(unpackOk ? 'unpack ok' : `unpack ${unpackDetail}`);
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    let ok = false;
    let reason = '';
    if (!unpackOk) {
      reason = 'unpack failed';
    } else if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) reason = 'no such ref';
      else if (command.oldOid !== current) reason = 'non-fast-forward';
      else ok = true;
    } else if (!store.hasObject(repo, command.newOid)) {
      reason = 'missing object';
    } else if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) reason = 'already exists';
      else ok = true;
    } else if (current === undefined) {
      reason = 'no such ref';
    } else if (command.oldOid !== current) {
      reason = 'non-fast-forward';
    } else if (command.newOid === current) {
      ok = true;
    } else if (!isAncestor(store, repo, command.oldOid, command.newOid)) {
      reason = 'non-fast-forward';
    } else {
      ok = true;
    }
    if (ok) {
      if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
      else repo.refs.set(command.ref, command.newOid);
      lines.push(`ok ${command.ref}`);
    } else {
      lines.push(`ng ${command.ref} ${reason}`);
    }
  }
  return reportReceive(lines, null, sideband);
}

function reportReceive(lines: string[], unpackLine: string | null, sideband: boolean): GitAnswer {
  const all = unpackLine !== null ? [unpackLine, ...lines] : lines;
  let body: Buffer;
  if (sideband) {
    const parts: Buffer[] = [];
    for (const line of all) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.from(`${line}\n`, 'utf8')])));
    }
    parts.push(pktFlush());
    body = Buffer.concat(parts);
  } else {
    body = encodePktLines([...all.map((line) => `${line}\n`), 'flush']);
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body };
}
