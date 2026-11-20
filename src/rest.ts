// REST v3: repositories, branches, commits, the Git Data API (refs),
// contents, labels, issues, comments and pull requests.
//
// Shapes follow api.github.com closely enough for the suite's shape checks:
// every reply is application/json, errors carry a string `message`, and the
// protocol rules (X-GitHub-Request-Id, Link pagination, 401 without a token,
// JSON 404s) are honoured by the router in app.ts and the helpers here.

import {
  EMPTY_TREE_OID,
  ZERO_OID,
  buildCommit,
  hashObject,
  identity,
  lineDiff,
  type IssueRecord,
  type PullRecord,
  type Repo,
  type Store,
} from './store.ts';
import { DEFAULT_BRANCH, VIEWER_LOGIN } from './scenario.ts';

export interface RestCtx {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  host: string;
}

export interface RestAnswer {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

type JsonRecord = Record<string, unknown>;

function ok(body: unknown, status = 200, headers?: Record<string, string>): RestAnswer {
  return { status, headers, body };
}

function err(status: number, message: string): RestAnswer {
  return { status, body: { message } };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Deterministic timestamps: a fixed epoch plus the record's creation sequence. */
function ts(seq: number): string {
  return new Date(1_735_689_600_000 + seq * 1_000).toISOString();
}

function nowIso(): string {
  return new Date().toISOString();
}

function userJson(login: string): JsonRecord {
  return { login, id: 1000, type: 'User', html_url: `https://example.invalid/${login}`, url: `/api/v3/users/${login}` };
}

function repoJson(repo: Repo): JsonRecord {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: repo.fullName,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: userJson(repo.owner),
    html_url: `https://example.invalid/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
    created_at: ts(repo.createdSeq),
    updated_at: ts(repo.createdSeq),
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    fork: false,
    archived: false,
    disabled: false,
  };
}

function issueJson(repo: Repo, issue: IssueRecord): JsonRecord {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: '' };
    }),
    user: userJson(repo.owner),
    assignee: null,
    assignees: [],
    locked: false,
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: ts(issue.createdSeq),
    updated_at: ts(issue.createdSeq),
    closed_at: issue.state === 'closed' ? ts(issue.createdSeq) : null,
    html_url: `https://example.invalid/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    comments_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments`,
  };
}

function pullJson(repo: Repo, pull: PullRecord): JsonRecord {
  const head = {
    ref: pull.headRef,
    sha: pull.headSha,
    label: `${repo.owner}:${pull.headRef}`,
    user: userJson(repo.owner),
    repo: repoJson(repo),
  };
  const base = {
    ref: pull.baseRef,
    sha: pull.baseSha,
    label: `${repo.owner}:${pull.baseRef}`,
    user: userJson(repo.owner),
    repo: repoJson(repo),
  };
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? true : null,
    head,
    base,
    user: userJson(repo.owner),
    assignee: null,
    created_at: ts(pull.createdSeq),
    updated_at: ts(pull.createdSeq),
    closed_at: pull.state === 'closed' ? pull.mergedAt ?? ts(pull.createdSeq) : null,
    html_url: `https://example.invalid/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
  };
}

function commitJson(store: Store, repo: Repo, oid: string): JsonRecord | null {
  const commit = store.getCommit(repo, oid);
  if (commit === null) return null;
  const authorName = commit.author.split(' <')[0] ?? '';
  return {
    sha: oid,
    node_id: `C_${oid}`,
    commit: {
      message: commit.message,
      author: { name: authorName, email: `${repo.owner}@example.invalid`, date: ts(0) },
      committer: { name: authorName, email: `${repo.owner}@example.invalid`, date: ts(0) },
      tree: { sha: commit.tree },
    },
    parents: commit.parents.map((sha) => ({ sha })),
    author: userJson(repo.owner),
    committer: userJson(repo.owner),
    url: `/api/v3/repos/${repo.fullName}/commits/${oid}`,
  };
}

/** Create a commit on `branch` from a tree, and move the branch to it. */
function commitOnBranch(
  store: Store,
  repo: Repo,
  branch: string,
  treeOid: string,
  message: string,
): string {
  const parent = repo.refs.get(`refs/heads/${branch}`);
  const parents = parent !== undefined ? [parent] : [];
  const time = Math.floor(Date.now() / 1000);
  const ident = identity(VIEWER_LOGIN, `${VIEWER_LOGIN}@example.invalid`, time);
  const data = buildCommit({ tree: treeOid, parents, author: ident, committer: ident, message });
  const oid = store.putObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${branch}`, oid);
  return oid;
}

/** The branch a contents write targets, creating it from the default tip when new. */
function resolveWriteBranch(store: Store, repo: Repo, branch: string | undefined): string {
  const target = branch ?? repo.defaultBranch;
  if (!repo.refs.has(`refs/heads/${target}`)) {
    const baseTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (baseTip !== undefined) repo.refs.set(`refs/heads/${target}`, baseTip);
  }
  return target;
}

function branchTipTree(store: Store, repo: Repo, branch: string): string {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return EMPTY_TREE_OID;
  const commit = store.getCommit(repo, tip);
  return commit === null ? EMPTY_TREE_OID : commit.tree;
}

function paginate<T>(items: readonly T[], query: URLSearchParams): { page: T[]; total: number; pageNum: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? 30) || 30));
  const pageNum = Math.max(1, Number(query.get('page') ?? 1) || 1);
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), total: items.length, pageNum, perPage };
}

function linkHeader(host: string, path: string, query: URLSearchParams, pageNum: number, perPage: number, total: number): string | null {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (pageNum >= lastPage) return null;
  const url = (page: number): string => {
    const q = new URLSearchParams(query);
    q.set('per_page', String(perPage));
    q.set('page', String(page));
    return `http://${host}${path}?${q.toString()}`;
  };
  return `<${url(pageNum + 1)}>; rel="next", <${url(lastPage)}>; rel="last"`;
}

export function handleRest(store: Store, ctx: RestCtx): RestAnswer | null {
  const { method, segments } = ctx;
  if (segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      200,
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  const [head] = segments;
  if (head === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok({ installed_version: '1.0.0' });
  }
  if (head === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') return err(404, 'Not Found');
      return ok({ ...userJson(store.viewer), id: 1000, name: store.viewer, email: `${store.viewer}@example.invalid` });
    }
    if (segments[1] === 'repos') {
      if (method === 'POST') return createRepo(store, ctx);
      if (method === 'GET') return listUserRepos(store, ctx);
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }
  if (head === 'repos') {
    return handleRepoRoute(store, ctx);
  }
  return err(404, 'Not Found');
}

function createRepo(store: Store, ctx: RestCtx): RestAnswer {
  const body = isRecord(ctx.body) ? ctx.body : {};
  const name = asString(body.name);
  if (name === null || name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
    return err(422, 'name is required');
  }
  const repo = store.createRepo(name, body.private === true, asString(body.description) ?? '');
  if (repo === null) return err(422, 'Repository already exists');
  return ok(repoJson(repo), 201);
}

function listUserRepos(store: Store, ctx: RestCtx): RestAnswer {
  const repos = store.viewerRepos();
  const { page, total, pageNum, perPage } = paginate(repos, ctx.query);
  const headers: Record<string, string> = {};
  const link = linkHeader(ctx.host, '/api/v3/user/repos', ctx.query, pageNum, perPage, total);
  if (link !== null) headers.link = link;
  return ok(page.map((repo) => repoJson(repo)), 200, headers);
}

function lookupRepo(store: Store, owner: string, name: string): Repo | null {
  // A repository belongs to the login the token names; the same name under
  // another owner is a 404, never a 403.
  if (owner !== store.viewer) return null;
  return store.getRepo(owner, name) ?? null;
}

function handleRepoRoute(store: Store, ctx: RestCtx): RestAnswer {
  const { method, segments } = ctx;
  const owner = segments[1] ?? '';
  const name = segments[2] ?? '';
  if (owner === '' || name === '') return err(404, 'Not Found');
  const repo = lookupRepo(store, owner, name);
  if (repo === null) return err(404, 'Not Found');
  const rest = segments.slice(3);
  if (rest.length === 0) {
    if (method === 'GET') return ok(repoJson(repo));
    if (method === 'PATCH') {
      const body = isRecord(ctx.body) ? ctx.body : {};
      const description = asString(body.description);
      if (description !== null) repo.description = description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      return ok(repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, name);
      return { status: 204 };
    }
    return err(404, 'Not Found');
  }
  const [section] = rest;
  if (section === 'branches') return handleBranches(store, repo, ctx, rest.slice(1));
  if (section === 'commits') return handleCommits(store, repo, ctx, rest.slice(1));
  if (section === 'git') return handleGitData(store, repo, ctx, rest.slice(1));
  if (section === 'contents') return handleContents(store, repo, ctx, rest.slice(1));
  if (section === 'labels') return handleLabels(repo, ctx);
  if (section === 'issues') return handleIssues(store, repo, ctx, rest.slice(1));
  if (section === 'pulls') return handlePulls(store, repo, ctx, rest.slice(1));
  return err(404, 'Not Found');
}

function handleBranches(store: Store, repo: Repo, ctx: RestCtx, rest: string[]): RestAnswer {
  if (ctx.method !== 'GET') return err(404, 'Not Found');
  if (rest.length === 0) {
    const branches: JsonRecord[] = [];
    for (const [name, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (!name.startsWith('refs/heads/')) continue;
      branches.push({ name: name.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
    }
    return ok(branches);
  }
  const branch = rest.join('/');
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (oid === undefined) return err(404, 'Not Found');
  return ok({ name: branch, commit: { sha: oid }, protected: false });
}

function handleCommits(store: Store, repo: Repo, ctx: RestCtx, rest: string[]): RestAnswer {
  if (ctx.method !== 'GET') return err(404, 'Not Found');
  if (rest.length > 0) {
    const sha = rest.join('/');
    const found = commitJson(store, repo, sha);
    if (found === null) return err(404, 'Not Found');
    return ok(found);
  }
  const ref = ctx.query.get('sha') ?? repo.defaultBranch;
  let tip = repo.refs.get(`refs/heads/${ref}`);
  if (tip === undefined && store.hasObject(repo, ref)) tip = ref;
  if (tip === undefined) return err(404, 'Not Found');
  const commits = store.listCommits(repo, tip);
  const { page } = paginate(commits, ctx.query);
  const out: JsonRecord[] = [];
  for (const oid of page) {
    const found = commitJson(store, repo, oid);
    if (found !== null) out.push(found);
  }
  return ok(out);
}

function handleGitData(store: Store, repo: Repo, ctx: RestCtx, rest: string[]): RestAnswer {
  if (rest[0] !== 'refs') return err(404, 'Not Found');
  if (ctx.method === 'POST' && rest.length === 1) {
    const body = isRecord(ctx.body) ? ctx.body : {};
    const ref = asString(body.ref);
    const sha = asString(body.sha);
    if (ref === null || !ref.startsWith('refs/') || sha === null || !/^[0-9a-f]{40}$/.test(sha)) {
      return err(422, 'ref and sha are required');
    }
    if (store.getCommit(repo, sha) === null && store.getObject(repo, sha)?.type !== 'tag') {
      return err(422, 'sha does not name a commit');
    }
    if (repo.refs.has(ref)) return err(422, 'Reference already exists');
    repo.refs.set(ref, sha);
    return ok({ ref, object: { sha, type: 'commit' }, url: `/api/v3/repos/${repo.fullName}/git/refs/${ref}` }, 201);
  }
  if (ctx.method === 'GET' && rest.length > 1) {
    const ref = `refs/${rest.slice(1).join('/')}`;
    const oid = repo.refs.get(ref);
    if (oid === undefined) return err(404, 'Not Found');
    return ok({ ref, object: { sha: oid, type: 'commit' }, url: `/api/v3/repos/${repo.fullName}/git/refs/${ref}` });
  }
  return err(404, 'Not Found');
}

function handleContents(store: Store, repo: Repo, ctx: RestCtx, rest: string[]): RestAnswer {
  const path = rest.map((segment) => decodeURIComponent(segment)).join('/');
  const branch = ctx.query.get('ref') ?? undefined;
  if (ctx.method === 'GET') {
    const target = branch ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${target}`);
    if (tip === undefined) return err(404, 'Not Found');
    const commit = store.getCommit(repo, tip);
    if (commit === null) return err(404, 'Not Found');
    if (path === '') {
      return ok(dirEntries(store, repo, commit.tree, ''));
    }
    const resolved = store.resolvePath(repo, commit.tree, path);
    if (resolved === null) return err(404, 'Not Found');
    if (resolved.type === 'tree') {
      return ok(dirEntries(store, repo, resolved.oid, path));
    }
    const object = store.getObject(repo, resolved.oid);
    if (object === undefined) return err(404, 'Not Found');
    return ok({
      type: 'file',
      encoding: 'base64',
      size: object.data.length,
      name: path.split('/').pop() ?? path,
      path,
      content: object.data.toString('base64'),
      sha: resolved.oid,
      url: `/api/v3/repos/${repo.fullName}/contents/${path}`,
    });
  }
  if (ctx.method === 'PUT') {
    const body = isRecord(ctx.body) ? ctx.body : {};
    const contentB64 = asString(body.content);
    if (contentB64 === null) return err(422, 'content is required');
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      return err(422, 'content is not valid base64');
    }
    const message = asString(body.message) ?? 'update';
    const target = resolveWriteBranch(store, repo, asString(body.branch) ?? branch);
    const tree = branchTipTree(store, repo, target);
    const existing = store.resolvePath(repo, tree, path);
    const givenSha = asString(body.sha);
    if (existing !== null) {
      if (givenSha === null) return err(409, 'sha is required to update a file');
      if (givenSha !== existing.oid) return err(409, 'sha does not match the current file');
    } else if (givenSha !== null) {
      return err(409, 'sha does not match the current file');
    }
    const blobOid = store.putObject(repo, 'blob', content);
    const newTree = store.setPath(repo, tree, path, blobOid);
    const commitSha = commitOnBranch(store, repo, target, newTree, message);
    const created = existing === null;
    return ok(
      {
        content: {
          name: path.split('/').pop() ?? path,
          path,
          sha: blobOid,
          size: content.length,
          type: 'file',
          encoding: 'base64',
          content: contentB64,
          url: `/api/v3/repos/${repo.fullName}/contents/${path}`,
        },
        commit: { sha: commitSha, message },
      },
      created ? 201 : 200,
    );
  }
  if (ctx.method === 'DELETE') {
    const body = isRecord(ctx.body) ? ctx.body : {};
    const message = asString(body.message) ?? 'delete';
    const target = resolveWriteBranch(store, repo, asString(body.branch) ?? branch);
    const tree = branchTipTree(store, repo, target);
    const existing = store.resolvePath(repo, tree, path);
    if (existing === null || existing.type !== 'blob') return err(404, 'Not Found');
    const givenSha = asString(body.sha);
    if (givenSha !== null && givenSha !== existing.oid) return err(409, 'sha does not match the current file');
    const newTree = store.deletePath(repo, tree, path);
    const commitSha = commitOnBranch(store, repo, target, newTree, message);
    return ok({ commit: { sha: commitSha, message }, content: null });
  }
  return err(404, 'Not Found');
}

function dirEntries(store: Store, repo: Repo, treeOid: string, prefix: string): JsonRecord[] {
  const entries = store.getTreeEntries(repo, treeOid);
  return entries.map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    size: entry.mode === '40000' ? 0 : (store.getObject(repo, entry.oid)?.data.length ?? 0),
    name: entry.name,
    path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
    sha: entry.oid,
    url: `/api/v3/repos/${repo.fullName}/contents/${prefix === '' ? entry.name : `${prefix}/${entry.name}`}`,
  }));
}

function handleLabels(repo: Repo, ctx: RestCtx): RestAnswer {
  if (ctx.method === 'GET') {
    return ok([...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: '' })));
  }
  if (ctx.method === 'POST') {
    const body = isRecord(ctx.body) ? ctx.body : {};
    const name = asString(body.name);
    if (name === null || name === '') return err(422, 'name is required');
    if (repo.labels.has(name)) return err(422, 'Label already exists');
    const color = asString(body.color) ?? 'ededed';
    repo.labels.set(name, { name, color });
    return ok({ name, color, description: '' }, 201);
  }
  return err(404, 'Not Found');
}

function labelNames(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') names.push(entry);
    else if (isRecord(entry) && typeof entry.name === 'string') names.push(entry.name);
    else return null;
  }
  return names;
}

function handleIssues(store: Store, repo: Repo, ctx: RestCtx, rest: string[]): RestAnswer {
  if (rest.length === 0) {
    if (ctx.method === 'POST') {
      const body = isRecord(ctx.body) ? ctx.body : {};
      const title = asString(body.title);
      if (title === null || title === '') return err(422, 'title is required');
      const labels = labelNames(body.labels) ?? [];
      for (const name of labels) {
        if (!repo.labels.has(name)) return err(422, `Label '${name}' does not exist`);
      }
      const issue: IssueRecord = {
        id: store.nextObjectId(),
        number: ++repo.issueSeq,
        title,
        body: asString(body.body) ?? '',
        state: 'open',
        labels,
        createdSeq: store.nextSeq(),
      };
      repo.issues.push(issue);
      return ok(issueJson(repo, issue), 201);
    }
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const direction = ctx.query.get('direction') ?? 'desc';
      let issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      issues = [...issues].sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      const { page } = paginate(issues, ctx.query);
      return ok(page.map((issue) => issueJson(repo, issue)));
    }
    return err(404, 'Not Found');
  }
  const number = Number(rest[0]);
  if (!Number.isSafeInteger(number) || number < 1) return err(404, 'Not Found');
  const issue = repo.issues.find((entry) => entry.number === number);
  if (issue === undefined) return err(404, 'Not Found');
  if (rest.length === 1) {
    if (ctx.method === 'GET') return ok(issueJson(repo, issue));
    if (ctx.method === 'PATCH') {
      const body = isRecord(ctx.body) ? ctx.body : {};
      const state = asString(body.state);
      if (state === 'open' || state === 'closed') issue.state = state;
      const title = asString(body.title);
      if (title !== null) issue.title = title;
      const bodyText = asString(body.body);
      if (bodyText !== null) issue.body = bodyText;
      return ok(issueJson(repo, issue));
    }
    return err(404, 'Not Found');
  }
  if (rest[1] === 'comments') {
    if (ctx.method === 'GET') {
      const comments = repo.comments.get(number) ?? [];
      return ok(
        comments.map((comment) => ({
          id: comment.id,
          node_id: `IC_${comment.id}`,
          body: comment.body,
          user: userJson(repo.owner),
          created_at: ts(comment.createdSeq),
          updated_at: ts(comment.createdSeq),
          html_url: `https://example.invalid/${repo.fullName}/issues/${number}#issuecomment-${comment.id}`,
          url: `/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}`,
        })),
      );
    }
    if (ctx.method === 'POST') {
      const body = isRecord(ctx.body) ? ctx.body : {};
      const text = asString(body.body);
      if (text === null) return err(422, 'body is required');
      const comment = { id: store.nextObjectId(), body: text, createdSeq: store.nextSeq() };
      const list = repo.comments.get(number) ?? [];
      list.push(comment);
      repo.comments.set(number, list);
      return ok(
        {
          id: comment.id,
          node_id: `IC_${comment.id}`,
          body: comment.body,
          user: userJson(repo.owner),
          created_at: ts(comment.createdSeq),
          updated_at: ts(comment.createdSeq),
          html_url: `https://example.invalid/${repo.fullName}/issues/${number}#issuecomment-${comment.id}`,
          url: `/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}`,
        },
        201,
      );
    }
  }
  return err(404, 'Not Found');
}

function refName(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.ref === 'string') return value.ref;
  return null;
}

function handlePulls(store: Store, repo: Repo, ctx: RestCtx, rest: string[]): RestAnswer {
  if (rest.length === 0) {
    if (ctx.method === 'POST') {
      const body = isRecord(ctx.body) ? ctx.body : {};
      const head = refName(body.head);
      const base = refName(body.base);
      const title = asString(body.title);
      if (head === null || base === null || title === null || title === '') {
        return err(422, 'head, base and title are required');
      }
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) return err(422, 'head or base branch does not exist');
      const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (duplicate !== undefined) return err(422, 'A pull request already exists for these branches');
      const mergeBase = store.mergeBase(repo, headSha, baseSha);
      const pull: PullRecord = {
        id: store.nextObjectId(),
        number: ++repo.pullSeq,
        title,
        body: asString(body.body) ?? '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        mergeBaseSha: mergeBase ?? baseSha,
        createdSeq: store.nextSeq(),
      };
      repo.pulls.push(pull);
      return ok(pullJson(repo, pull), 201);
    }
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let pulls = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
      pulls = [...pulls].sort((a, b) => b.createdSeq - a.createdSeq);
      const { page } = paginate(pulls, ctx.query);
      return ok(page.map((pull) => pullJson(repo, pull)));
    }
    return err(404, 'Not Found');
  }
  const number = Number(rest[0]);
  if (!Number.isSafeInteger(number) || number < 1) return err(404, 'Not Found');
  const pull = repo.pulls.find((entry) => entry.number === number);
  if (pull === undefined) return err(404, 'Not Found');
  if (rest.length === 1) {
    if (ctx.method === 'GET') return ok(pullJson(repo, pull));
    return err(404, 'Not Found');
  }
  if (rest[1] === 'files') {
    if (ctx.method !== 'GET') return err(404, 'Not Found');
    return ok(pullFiles(store, repo, pull));
  }
  if (rest[1] === 'merge') {
    if (ctx.method !== 'PUT') return err(404, 'Not Found');
    return mergePull(store, repo, pull);
  }
  return err(404, 'Not Found');
}

function pullFiles(store: Store, repo: Repo, pull: PullRecord): JsonRecord[] {
  const baseCommit = store.getCommit(repo, pull.mergeBaseSha);
  const headCommit = store.getCommit(repo, pull.headSha);
  if (baseCommit === null || headCommit === null) return [];
  const changes = store.diffTrees(repo, baseCommit.tree, headCommit.tree);
  const out: JsonRecord[] = [];
  for (const change of changes) {
    let additions = 0;
    let deletions = 0;
    if (change.status === 'added' && change.newOid !== null) {
      const blob = store.getObject(repo, change.newOid);
      const text = blob === undefined ? '' : blob.data.toString('utf8');
      const counts = lineDiff('', text);
      additions = counts.additions;
    } else if (change.status === 'deleted' && change.oldOid !== null) {
      const blob = store.getObject(repo, change.oldOid);
      const text = blob === undefined ? '' : blob.data.toString('utf8');
      const counts = lineDiff(text, '');
      deletions = counts.deletions;
    } else if (change.status === 'modified' && change.oldOid !== null && change.newOid !== null) {
      const oldBlob = store.getObject(repo, change.oldOid);
      const newBlob = store.getObject(repo, change.newOid);
      const counts = lineDiff(
        oldBlob === undefined ? '' : oldBlob.data.toString('utf8'),
        newBlob === undefined ? '' : newBlob.data.toString('utf8'),
      );
      additions = counts.additions;
      deletions = counts.deletions;
    }
    out.push({
      sha: change.newOid ?? change.oldOid ?? '',
      filename: change.path,
      status: change.status === 'deleted' ? 'removed' : change.status,
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return out;
}

/** Whether merging `pull` now would conflict with the base branch's tip. */
export function pullConflicts(store: Store, repo: Repo, pull: PullRecord): boolean {
  const baseCommit = store.getCommit(repo, pull.mergeBaseSha);
  const headCommit = store.getCommit(repo, pull.headSha);
  const currentBaseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const baseTipCommit = store.getCommit(repo, currentBaseTip);
  if (baseCommit === null || headCommit === null || baseTipCommit === null) return true;
  const headChanges = store.diffTrees(repo, baseCommit.tree, headCommit.tree);
  const baseNow = store.flattenTree(repo, baseTipCommit.tree);
  const baseThen = store.flattenTree(repo, baseCommit.tree);
  for (const change of headChanges) {
    const thenOid = baseThen.get(change.path) ?? null;
    const nowOid = baseNow.get(change.path) ?? null;
    if (thenOid !== nowOid && nowOid !== change.newOid) return true;
  }
  return false;
}

function mergePull(store: Store, repo: Repo, pull: PullRecord): RestAnswer {
  if (pull.state === 'closed') return err(405, 'Pull request is already closed');
  if (pullConflicts(store, repo, pull)) return err(405, 'Merge conflict');
  const baseCommit = store.getCommit(repo, pull.mergeBaseSha);
  const headCommit = store.getCommit(repo, pull.headSha);
  const currentBaseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const baseTipCommit = store.getCommit(repo, currentBaseTip);
  if (baseCommit === null || headCommit === null || baseTipCommit === null) return err(405, 'Merge conflict');
  // Apply the head's changes onto the base tip's tree.
  let tree = baseTipCommit.tree;
  const headChanges = store.diffTrees(repo, baseCommit.tree, headCommit.tree);
  for (const change of headChanges) {
    if (change.status === 'deleted') tree = store.deletePath(repo, tree, change.path);
    else if (change.newOid !== null) tree = store.setPath(repo, tree, change.path, change.newOid);
  }
  const time = Math.floor(Date.now() / 1000);
  const ident = identity(VIEWER_LOGIN, `${VIEWER_LOGIN}@example.invalid`, time);
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}\n`;
  const data = buildCommit({ tree, parents: [currentBaseTip], author: ident, committer: ident, message });
  const mergeSha = store.putObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = mergeSha;
  return ok({ sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
}

export { DEFAULT_BRANCH };
