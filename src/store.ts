// The in-memory store and the git object machinery: SHA-1 hashing, object
// parsing and building, trees, reachability, packs and pkt-lines.
//
// One process, one trial: everything lives in memory. Objects are stored
// verbatim by their SHA-1 — a pushed object round-trips byte-exactly, and its
// id recomputes from its bytes. Nothing is ever re-serialised from a parse.

import { createHash } from 'node:crypto';
import { inflateSync as zlibInflate, deflateSync as zlibDeflate } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

// ---------------------------------------------------------------- pkt-lines

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface PktLine {
  kind: PktKind;
  payload: Buffer;
}

export function pktLine(data: Buffer | string): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Encode a list of text lines plus 'flush' / 'delim' markers. */
export function encodePktLines(items: ReadonlyArray<string | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/** Decode a whole buffer of pkt-lines (used for request bodies). */
export function decodePktLines(buf: Buffer): PktLine[] {
  const out: PktLine[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const len = parseInt(buf.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (offset + len <= buf.length) {
      out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
      offset += len;
    } else {
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------- pack files

export interface PackObject {
  type: string;
  data: Buffer;
}

const PACK_TYPE_IDS: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_ID_TYPES: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(typeId: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeId << 4) | (size & 0x0f);
  size >>>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let next = size & 0x7f;
    size >>>= 7;
    if (size > 0) next |= 0x80;
    bytes.push(next);
  }
  return Buffer.from(bytes);
}

/** Write a pack of full objects only (no deltas): the suite's client never sends deltas either. */
export function writePack(objects: readonly PackObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const typeId = PACK_TYPE_IDS[object.type];
    if (typeId === undefined) throw new Error(`cannot pack object of type ${object.type}`);
    parts.push(packObjectHeader(typeId, object.data.length));
    parts.push(zlibDeflate(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

export interface ReadPackResult {
  objects: Map<string, PackObject>;
  deltaCount: number;
}
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos] as number;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  readSize(); // base size
  const resultSize = readSize();
  const out: Buffer[] = [];
  let outLen = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[pos] as number, pos += 1;
      if (op & 0x02) offset |= (delta[pos] as number) << 8, pos += 1;
      if (op & 0x04) offset |= (delta[pos] as number) << 16, pos += 1;
      if (op & 0x08) offset |= (delta[pos] as number) << 24, pos += 1;
      if (op & 0x10) size = delta[pos] as number, pos += 1;
      if (op & 0x20) size |= (delta[pos] as number) << 8, pos += 1;
      if (op & 0x40) size |= (delta[pos] as number) << 16, pos += 1;
      if (size === 0) size = 0x10000;
      const chunk = base.subarray(offset, offset + size);
      out.push(chunk);
      outLen += chunk.length;
    } else if (op !== 0) {
      const chunk = delta.subarray(pos, pos + op);
      pos += op;
      out.push(chunk);
      outLen += chunk.length;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out, outLen);
  if (result.length !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

// The pack reader: inflateSync cannot report consumed input length, so each
// object's zlib stream is found by probing increasing end offsets until the
// output length matches the declared size. Packs here are small (a few
// hundred objects at most), and each probe is a single inflate of one
// object's bytes.
export function readPack(buf: Buffer): ReadPackResult {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a pack file');
  }
  const count = buf.readUInt32BE(8);
  let offset = 12;
  const objects = new Map<string, PackObject>();
  const byOffset = new Map<number, PackObject>();
  let deltaCount = 0;
  const inflateAt = (start: number, expectedSize: number): { data: Buffer; next: number } => {
    // inflateSync throws on a truncated stream and ignores trailing bytes, so
    // "inflates" is monotone in the end offset: false below the stream's true
    // end, true at and above it. Find any true end by exponential probing,
    // then binary-search the smallest one: that is the next object's offset.
    const tryInflate = (end: number): Buffer | null => {
      try {
        return zlibInflate(buf.subarray(start, end));
      } catch {
        return null;
      }
    };
    const hi = buf.length - 20; // leave room for the trailer
    let good: number | null = null;
    let probe = Math.min(hi, start + 64);
    for (;;) {
      const data = tryInflate(probe);
      if (data !== null) {
        if (data.length !== expectedSize) throw new Error('pack object size mismatch');
        good = probe;
        break;
      }
      if (probe >= hi) break;
      probe = Math.min(hi, probe * 2);
    }
    if (good === null) throw new Error('could not inflate a pack object');
    let lo = start + 1;
    let hiEnd = good;
    while (lo < hiEnd) {
      const mid = (lo + hiEnd) >> 1;
      const data = tryInflate(mid);
      if (data !== null) {
        if (data.length !== expectedSize) throw new Error('pack object size mismatch');
        hiEnd = mid;
      } else {
        lo = mid + 1;
      }
    }
    const data = tryInflate(lo);
    if (data === null || data.length !== expectedSize) throw new Error('pack object size mismatch');
    return { data, next: lo };
  };
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    const first = buf[offset] as number;
    const typeId = (first >> 4) & 0x7;
    let size = first & 0x0f;
    let shift = 4;
    offset += 1;
    while (((buf[offset - 1] as number) & 0x80) !== 0) {
      size |= ((buf[offset] as number) & 0x7f) << shift;
      shift += 7;
      offset += 1;
    }
    let baseOid: string | null = null;
    let baseOffset = -1;
    if (typeId === 6) {
      let byte = buf[offset] as number;
      offset += 1;
      let value = byte & 0x7f;
      while (byte & 0x80) {
        byte = buf[offset] as number;
        offset += 1;
        value = ((value + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = start - value;
    } else if (typeId === 7) {
      baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const { data, next } = inflateAt(offset, size);
    offset = next;
    if (typeId >= 1 && typeId <= 4) {
      const type = PACK_ID_TYPES[typeId] as string;
      const object: PackObject = { type, data };
      const oid = hashObject(type, data);
      objects.set(oid, object);
      byOffset.set(start, object);
    } else if (typeId === 6 || typeId === 7) {
      deltaCount += 1;
      const base = typeId === 6 ? byOffset.get(baseOffset) : objects.get(baseOid as string);
      if (base === undefined) throw new Error('delta base not found in pack');
      const resolved = applyDelta(base.data, data);
      const object: PackObject = { type: base.type, data: resolved };
      const oid = hashObject(base.type, resolved);
      objects.set(oid, object);
      byOffset.set(start, object);
    } else {
      throw new Error(`unknown pack object type ${typeId}`);
    }
  }
  return { objects, deltaCount };
}

// ---------------------------------------------------------------- object parsing

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  authorTime: number;
  committerTime: number;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank >= 0 ? text.slice(0, blank) : text;
  const message = blank >= 0 ? text.slice(blank + 2) : '';
  const info: CommitInfo = {
    tree: '',
    parents: [],
    author: '',
    committer: '',
    authorTime: 0,
    committerTime: 0,
    message,
  };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      info.author = line.slice(7);
      const m = line.match(/ (\d+) [+-]\d{4}$/);
      if (m) info.authorTime = Number(m[1]);
    } else if (line.startsWith('committer ')) {
      info.committer = line.slice(10);
      const m = line.match(/ (\d+) [+-]\d{4}$/);
      if (m) info.committerTime = Number(m[1]);
    }
  }
  return info;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialise tree entries in git's order (directories sort as name + '/'). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0,
  );
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitBuild {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}

export function buildCommit(build: CommitBuild): Buffer {
  const lines: string[] = [`tree ${build.tree}`];
  for (const parent of build.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${build.author}`);
  lines.push(`committer ${build.committer}`);
  lines.push('');
  lines.push(build.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export function identity(name: string, email: string, timeSec: number): string {
  return `${name} <${email}> ${timeSec} +0000`;
}

// ---------------------------------------------------------------- the store

export interface IssueRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
}

export interface CommentRecord {
  id: number;
  body: string;
  createdSeq: number;
}

export interface PullRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  createdSeq: number;
}

export interface LabelRecord {
  name: string;
  color: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, { type: string; data: Buffer }>;
  refs: Map<string, string>;
  issues: IssueRecord[];
  issueSeq: number;
  pulls: PullRecord[];
  pullSeq: number;
  labels: Map<string, LabelRecord>;
  comments: Map<number, CommentRecord[]>;
  createdSeq: number;
}

export interface GitObject {
  type: string;
  data: Buffer;
}

export class Store {
  readonly viewer: string;
  readonly repos = new Map<string, Repo>();
  private repoSeq = 1;
  private objectSeq = 1;
  private seq = 1;

  constructor(viewer: string) {
    this.viewer = viewer;
  }

  nextSeq(): number {
    return this.seq++;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    const key = this.repoKey(this.viewer, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      id: this.repoSeq++,
      owner: this.viewer,
      name,
      fullName: key,
      isPrivate,
      description,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      issues: [],
      issueSeq: 0,
      pulls: [],
      pullSeq: 0,
      labels: new Map(),
      comments: new Map(),
      createdSeq: this.nextSeq(),
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  viewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === this.viewer) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  // ------------------------------------------------------------ git objects

  putObject(repo: Repo, type: string, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  hasObject(repo: Repo, oid: string): boolean {
    return repo.objects.has(oid);
  }

  getCommit(repo: Repo, oid: string): CommitInfo | null {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data);
  }

  getTreeEntries(repo: Repo, treeOid: string): TreeEntry[] {
    const object = repo.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return [];
    return parseTree(object.data);
  }

  /** Peel an annotated tag (recursively) to its commit, or return the oid unchanged. */
  peelToCommit(repo: Repo, oid: string): string {
    let current = oid;
    for (let i = 0; i < 10; i += 1) {
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'tag') return current;
      const text = object.data.toString('utf8');
      const m = text.match(/^object ([0-9a-f]{40})$/m);
      if (m === null) return current;
      current = m[1] as string;
    }
    return current;
  }

  /** Resolve a path inside a tree to its object (blob or tree). */
  resolvePath(repo: Repo, treeOid: string, path: string): { type: string; oid: string } | null {
    const parts = path.split('/').filter((part) => part !== '');
    let current = treeOid;
    for (let i = 0; i < parts.length; i += 1) {
      const entries = this.getTreeEntries(repo, current);
      const entry = entries.find((candidate) => candidate.name === parts[i]);
      if (entry === undefined) return null;
      if (i === parts.length - 1) {
        const object = repo.objects.get(entry.oid);
        return object === undefined ? null : { type: entry.mode === '40000' ? 'tree' : 'blob', oid: entry.oid };
      }
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return { type: 'tree', oid: current };
  }

  /** List the entries of the tree at `path` ('' is the root). Null when the path is not a tree. */
  listDir(repo: Repo, treeOid: string, path: string): TreeEntry[] | null {
    if (path === '') return this.getTreeEntries(repo, treeOid);
    const resolved = this.resolvePath(repo, treeOid, path);
    if (resolved === null || resolved.type !== 'tree') return null;
    return this.getTreeEntries(repo, resolved.oid);
  }

  /** Return a new root tree with `path` set to `blobOid` (creating intermediate trees). */
  setPath(repo: Repo, baseTreeOid: string, path: string, blobOid: string): string {
    const parts = path.split('/').filter((part) => part !== '');
    const build = (treeOid: string, depth: number): string => {
      const entries = this.getTreeEntries(repo, treeOid);
      const name = parts[depth] as string;
      if (depth === parts.length - 1) {
        const next = entries.filter((entry) => entry.name !== name);
        next.push({ mode: '100644', name, oid: blobOid });
        const data = buildTree(next);
        return this.putObject(repo, 'tree', data);
      }
      const existing = entries.find((entry) => entry.name === name);
      const childOid =
        existing !== undefined && existing.mode === '40000'
          ? build(existing.oid, depth + 1)
          : build(EMPTY_TREE_OID, depth + 1);
      const next = entries.filter((entry) => entry.name !== name);
      next.push({ mode: '40000', name, oid: childOid });
      const data = buildTree(next);
      return this.putObject(repo, 'tree', data);
    };
    return build(baseTreeOid, 0);
  }

  /** Return a new root tree with `path` removed (no-op when absent). */
  deletePath(repo: Repo, baseTreeOid: string, path: string): string {
    const parts = path.split('/').filter((part) => part !== '');
    const build = (treeOid: string, depth: number): string | null => {
      const entries = this.getTreeEntries(repo, treeOid);
      const name = parts[depth] as string;
      if (depth === parts.length - 1) {
        if (!entries.some((entry) => entry.name === name)) return null;
        const next = entries.filter((entry) => entry.name !== name);
        return this.putObject(repo, 'tree', buildTree(next));
      }
      const existing = entries.find((entry) => entry.name === name);
      if (existing === undefined || existing.mode !== '40000') return null;
      const child = build(existing.oid, depth + 1);
      if (child === null) return null;
      const childEntries = this.getTreeEntries(repo, child);
      const next = entries.filter((entry) => entry.name !== name);
      if (childEntries.length > 0) next.push({ mode: '40000', name, oid: child });
      return this.putObject(repo, 'tree', buildTree(next));
    };
    return build(baseTreeOid, 0) ?? baseTreeOid;
  }

  // ------------------------------------------------------------ reachability

  /** All objects reachable from `tips` (commits, their trees and blobs), with generations. */
  reachableObjects(
    repo: Repo,
    tips: readonly string[],
    opts: { maxDepth?: number; cutoffs?: ReadonlySet<string> } = {},
  ): { objects: Map<string, PackObject>; commitGenerations: Map<string, number> } {
    const objects = new Map<string, PackObject>();
    const commitGenerations = new Map<string, number>();
    const queue: Array<{ oid: string; generation: number }> = [];
    for (const tip of tips) {
      // A tag tip is itself an object the fetch must carry: follow the tag
      // chain, adding each tag, until the commit underneath.
      let current = tip;
      for (let i = 0; i < 10; i += 1) {
        const object = repo.objects.get(current);
        if (object === undefined || object.type !== 'tag') break;
        if (!objects.has(current)) objects.set(current, { type: 'tag', data: object.data });
        const m = object.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
        if (m === null) break;
        current = m[1] as string;
      }
      if (!commitGenerations.has(current)) {
        commitGenerations.set(current, 0);
        queue.push({ oid: current, generation: 0 });
      }
    }
    const addTree = (treeOid: string): void => {
      if (objects.has(treeOid)) return;
      const object = repo.objects.get(treeOid);
      if (object === undefined) return;
      objects.set(treeOid, { type: 'tree', data: object.data });
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '40000') {
          addTree(entry.oid);
        } else {
          if (!objects.has(entry.oid)) {
            const blob = repo.objects.get(entry.oid);
            if (blob !== undefined) objects.set(entry.oid, { type: 'blob', data: blob.data });
          }
        }
      }
    };
    while (queue.length > 0) {
      const { oid, generation } = queue.shift() as { oid: string; generation: number };
      if (opts.maxDepth !== undefined && generation >= opts.maxDepth) continue;
      const commit = this.getCommit(repo, oid);
      if (commit === null) continue;
      if (!objects.has(oid)) {
        const object = repo.objects.get(oid);
        if (object !== undefined) objects.set(oid, { type: 'commit', data: object.data });
      }
      addTree(commit.tree);
      // A shallow boundary is a cut-off: the holder has this commit but
      // nothing beyond it, so its parents are not reachable from it.
      if (opts.cutoffs !== undefined && opts.cutoffs.has(oid)) continue;
      for (const parent of commit.parents) {
        if (!commitGenerations.has(parent)) {
          commitGenerations.set(parent, generation + 1);
          queue.push({ oid: parent, generation: generation + 1 });
        }
      }
    }
    return { objects, commitGenerations };
  }

  /** The first common ancestor of two commits (linear histories: walk both parent chains). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    let cursor: string | null = this.peelToCommit(repo, a);
    while (cursor !== null) {
      ancestorsA.add(cursor);
      const commit = this.getCommit(repo, cursor);
      cursor = commit !== null && commit.parents.length > 0 ? (commit.parents[0] as string) : null;
    }
    cursor = this.peelToCommit(repo, b);
    while (cursor !== null) {
      if (ancestorsA.has(cursor)) return cursor;
      const commit = this.getCommit(repo, cursor);
      cursor = commit !== null && commit.parents.length > 0 ? (commit.parents[0] as string) : null;
    }
    return null;
  }

  /** Commits reachable from `fromOid`, newest first (by committer time, then discovery order). */
  listCommits(repo: Repo, fromOid: string): string[] {
    const seen = new Set<string>();
    const order: string[] = [];
    const stack: string[] = [this.peelToCommit(repo, fromOid)];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const commit = this.getCommit(repo, oid);
      if (commit === null) continue;
      seen.add(oid);
      order.push(oid);
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) {
        stack.push(commit.parents[i] as string);
      }
    }
    order.sort((x, y) => {
      const cx = this.getCommit(repo, x);
      const cy = this.getCommit(repo, y);
      return (cy?.committerTime ?? 0) - (cx?.committerTime ?? 0);
    });
    return order;
  }

  /** Flatten a tree to path -> blob oid (recursive). */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, string> {
    const out = new Map<string, string>();
    for (const entry of this.getTreeEntries(repo, treeOid)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') {
        for (const [sub, oid] of this.flattenTree(repo, entry.oid, path)) out.set(sub, oid);
      } else {
        out.set(path, entry.oid);
      }
    }
    return out;
  }

  /** Changed paths between two trees: added / modified / deleted with old and new blob oids. */
  diffTrees(
    repo: Repo,
    baseTreeOid: string,
    headTreeOid: string,
  ): Array<{ path: string; status: 'added' | 'modified' | 'deleted'; oldOid: string | null; newOid: string | null }> {
    const base = this.flattenTree(repo, baseTreeOid);
    const head = this.flattenTree(repo, headTreeOid);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: Array<{ path: string; status: 'added' | 'modified' | 'deleted'; oldOid: string | null; newOid: string | null }> = [];
    for (const path of [...paths].sort()) {
      const oldOid = base.get(path) ?? null;
      const newOid = head.get(path) ?? null;
      if (oldOid === null && newOid !== null) out.push({ path, status: 'added', oldOid, newOid });
      else if (oldOid !== null && newOid === null) out.push({ path, status: 'deleted', oldOid, newOid });
      else if (oldOid !== newOid) out.push({ path, status: 'modified', oldOid, newOid });
    }
    return out;
  }

  nextObjectId(): number {
    return this.objectSeq++;
  }
}

// ---------------------------------------------------------------- line diffs

export interface LineCounts {
  additions: number;
  deletions: number;
}

/** Line-level additions/deletions between two texts (LCS; small files only). */
export function lineDiff(oldText: string, newText: string): LineCounts {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  // Drop a trailing empty line produced by a final newline on both sides.
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  if (oldLines.length * newLines.length > 4_000_000) {
    const oldSet = new Set(oldLines);
    const newSet = new Set(newLines);
    let additions = 0;
    let deletions = 0;
    for (const line of newLines) if (!oldSet.has(line)) additions += 1;
    for (const line of oldLines) if (!newSet.has(line)) deletions += 1;
    return { additions, deletions };
  }
  // LCS lengths via two rows.
  let prev = new Array<number>(newLines.length + 1).fill(0);
  let curr = new Array<number>(newLines.length + 1).fill(0);
  for (let i = 1; i <= oldLines.length; i += 1) {
    for (let j = 1; j <= newLines.length; j += 1) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? (prev[j - 1] as number) + 1 : Math.max(prev[j] as number, curr[j - 1] as number);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
    curr.fill(0);
  }
  const lcs = prev[newLines.length] as number;
  return { additions: newLines.length - lcs, deletions: oldLines.length - lcs };
}

// ---------------------------------------------------------------- global ids

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function repoGlobalId(owner: string, name: string): string {
  return b64url(`v1:Repository:${owner}/${name}`);
}

export function issueGlobalId(owner: string, name: string, number: number): string {
  return b64url(`v1:Issue:${owner}/${name}#${number}`);
}

export function pullGlobalId(owner: string, name: string, number: number): string {
  return b64url(`v1:PullRequest:${owner}/${name}#${number}`);
}

export function commentGlobalId(owner: string, name: string, issueNumber: number, commentId: number): string {
  return b64url(`v1:IssueComment:${owner}/${name}#${issueNumber}:${commentId}`);
}

export interface ParsedGlobalId {
  kind: string;
  owner: string;
  repo: string;
  number: number | null;
  commentId: number | null;
}

export function parseGlobalId(id: string): ParsedGlobalId | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const m = text.match(/^v1:(Repository|Issue|PullRequest|IssueComment):([^/]+)\/([^#:\s]+)(?:#(\d+))?(?::(\d+))?$/);
  if (m === null) return null;
  return {
    kind: m[1] as string,
    owner: m[2] as string,
    repo: m[3] as string,
    number: m[4] !== undefined ? Number(m[4]) : null,
    commentId: m[5] !== undefined ? Number(m[5]) : null,
  };
}
