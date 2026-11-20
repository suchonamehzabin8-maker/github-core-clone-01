// MCP over streamable HTTP (plain JSON POSTs; no SSE needed): the modern
// 2026-07-28 era via `server/discover`, with `initialize` also answered for
// a pre-discover client. Six tools, one store shared with REST, GraphQL and
// git, so a repository or issue created over MCP is the same object over
// REST, with stable ids.
//
// JSON-RPC errors: unknown tool -32602 (the suite also accepts -32601),
// missing required arguments -32602, malformed JSON body HTTP 400 with
// -32700, no Authorization header HTTP 401.

import { buildCommit, type Repo, type Store } from './store.ts';
import { pullConflicts } from './rest.ts';

const SERVER_NAME = 'github-core-clone-01';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOLS_JSON = JSON.stringify(TOOLS);

export interface McpAnswer {
  status: number;
  body: unknown;
}

function rpcResult(id: unknown, result: unknown): McpAnswer {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpAnswer {
  return { status, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

function toolText(payload: unknown): { content: Array<{ type: 'text'; text: string }>; structuredContent: unknown } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
}

function toolErrorText(message: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function lookupRepo(store: Store, owner: unknown, repo: unknown): Repo | null {
  if (typeof owner !== 'string' || typeof repo !== 'string') return null;
  if (owner !== store.viewer) return null;
  return store.getRepo(owner, repo) ?? null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): { result: unknown } | { error: string } {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) return { error: `unknown tool ${name}` };
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { error: `missing required argument ${required}` };
    }
  }
  if (name === 'create_repo') {
    const repoName = args.name as string;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repoName)) return { error: 'invalid repository name' };
    const repo = store.createRepo(repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
    if (repo === null) return { error: 'Repository already exists' };
    return {
      result: toolText({
        id: repo.id,
        name: repo.name,
        full_name: repo.fullName,
        private: repo.isPrivate,
        description: repo.description,
        default_branch: repo.defaultBranch,
        owner: { login: repo.owner },
      }),
    };
  }
  if (name === 'get_repo') {
    const repo = lookupRepo(store, args.owner, args.repo);
    if (repo === null) return { error: 'Repository not found' };
    return {
      result: toolText({
        id: repo.id,
        name: repo.name,
        full_name: repo.fullName,
        private: repo.isPrivate,
        description: repo.description,
        default_branch: repo.defaultBranch,
        owner: { login: repo.owner },
      }),
    };
  }
  if (name === 'create_issue') {
    const repo = lookupRepo(store, args.owner, args.repo);
    if (repo === null) return { error: 'Repository not found' };
    const title = args.title as string;
    const issue = {
      id: store.nextObjectId(),
      number: ++repo.issueSeq,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open' as const,
      labels: [] as string[],
      createdSeq: store.nextSeq(),
    };
    repo.issues.push(issue);
    return {
      result: toolText({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        repository: repo.fullName,
      }),
    };
  }
  if (name === 'list_issues') {
    const repo = lookupRepo(store, args.owner, args.repo);
    if (repo === null) return { error: 'Repository not found' };
    const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
    const issues = repo.issues
      .filter((issue) => state === 'all' || issue.state === state)
      .map((issue) => ({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state }));
    return { result: toolText(issues) };
  }
  if (name === 'create_pull_request') {
    const repo = lookupRepo(store, args.owner, args.repo);
    if (repo === null) return { error: 'Repository not found' };
    const head = args.head as string;
    const base = args.base as string;
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) return { error: 'head or base branch does not exist' };
    const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
    if (duplicate !== undefined) return { error: 'A pull request already exists for these branches' };
    const mergeBase = store.mergeBase(repo, headSha, baseSha);
    const pull = {
      id: store.nextObjectId(),
      number: ++repo.pullSeq,
      title: args.title as string,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open' as const,
      merged: false,
      mergedAt: null as string | null,
      mergeCommitSha: null as string | null,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      mergeBaseSha: mergeBase ?? baseSha,
      createdSeq: store.nextSeq(),
    };
    repo.pulls.push(pull);
    return {
      result: toolText({
        id: pull.id,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: { ref: head, sha: headSha },
        base: { ref: base, sha: baseSha },
      }),
    };
  }
  if (name === 'merge_pull_request') {
    const repo = lookupRepo(store, args.owner, args.repo);
    if (repo === null) return { error: 'Repository not found' };
    const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull === undefined) return { error: 'Pull request not found' };
    if (pull.state === 'closed') return { error: 'Pull request is already closed' };
    if (pullConflicts(store, repo, pull)) return { error: 'Merge conflict' };
    const baseCommit = store.getCommit(repo, pull.mergeBaseSha);
    const headCommit = store.getCommit(repo, pull.headSha);
    const currentBaseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const baseTipCommit = store.getCommit(repo, currentBaseTip);
    if (baseCommit === null || headCommit === null || baseTipCommit === null) return { error: 'Merge conflict' };
    let tree = baseTipCommit.tree;
    for (const change of store.diffTrees(repo, baseCommit.tree, headCommit.tree)) {
      if (change.status === 'deleted') tree = store.deletePath(repo, tree, change.path);
      else if (change.newOid !== null) tree = store.setPath(repo, tree, change.path, change.newOid);
    }
    const time = Math.floor(Date.now() / 1000);
    const ident = `${store.viewer} <${store.viewer}@example.invalid> ${time} +0000`;
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}\n`;
    const data = buildCommit({ tree, parents: [currentBaseTip], author: ident, committer: ident, message });
    const mergeSha = store.putObject(repo, 'commit', data);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date().toISOString();
    pull.mergeCommitSha = mergeSha;
    return {
      result: toolText({
        number: pull.number,
        merged: true,
        state: pull.state,
        sha: pull.mergeCommitSha,
      }),
    };
  }
  return { error: `unknown tool ${name}` };
}

/** Handle one POST /mcp body. `authorized` is false when no bearer token was presented. */
export function handleMcp(store: Store, rawBody: Buffer, authorized: boolean): McpAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  const request = parsed as Record<string, unknown>;
  const id = (request.id ?? null) as unknown;
  const method = request.method;
  if (typeof method !== 'string') return rpcError(id, -32600, 'Invalid Request');
  // A notification (no id) needs no answer.
  const isNotification = request.id === undefined;
  if (!authorized) {
    return rpcError(id, -32000, 'Unauthorized', 401);
  }
  if (method === 'server/discover') {
    const result = {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    };
    if (isNotification) return { status: 202, body: undefined };
    return rpcResult(id, result);
  }
  if (method === 'initialize') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const protocolVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : SUPPORTED_VERSIONS[0];
    const result = {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    };
    if (isNotification) return { status: 202, body: undefined };
    return rpcResult(id, result);
  }
  if (method === 'notifications/initialized') {
    return { status: 202, body: undefined };
  }
  if (method === 'tools/list') {
    if (isNotification) return { status: 202, body: undefined };
    return rpcResult(id, { tools: JSON.parse(TOOLS_JSON) as unknown });
  }
  if (method === 'tools/call') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const name = params.name;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (typeof name !== 'string') return rpcError(id, -32602, 'Invalid params: tool name is required');
    const called = callTool(store, name, args);
    if ('error' in called) {
      if (called.error.startsWith('unknown tool')) return rpcError(id, -32602, called.error);
      if (called.error.startsWith('missing required argument')) return rpcError(id, -32602, called.error);
      return rpcResult(id, toolErrorText(called.error));
    }
    if (isNotification) return { status: 202, body: undefined };
    return rpcResult(id, called.result);
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}
