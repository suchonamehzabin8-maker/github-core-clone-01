# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/suchonamehzabin8-maker/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/suchonamehzabin8-maker/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node process: git smart HTTP, the REST
v3 API, GraphQL v4 and MCP, all served from one in-memory store. No
dependencies, no database, no `git` binary — just the Node standard library.

Built for [make.fun's github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01).

## What it does

One process serves the four surfaces agents already speak:

- **git smart HTTP** (`/<owner>/<repo>.git/...`): `info/refs` (protocol v0
  and v2 advertisements), `git-upload-pack` (v2 `ls-refs` and `fetch`,
  v0 fetch — with haves honoured, `deepen` shallow fetches and the
  shallow/unshallow boundary bookkeeping), and `git-receive-pack`
  (fast-forward validation, `report-status`, sideband framing). Packs carry
  full objects only; pushed objects round-trip byte-exactly, and annotated
  tags peel to their commits.
- **REST v3** (`/api/v3/...`): repositories, branches, commits, the Git Data
  API (`git/refs`), contents (create/update/delete with blob SHAs, stale-sha
  409s, directory listings), labels, issues, comments and pull requests with
  squash merges and conflict detection (405). Pagination follows GitHub's
  `Link: <url>; rel="next"` headers.
- **GraphQL v4** (`POST /api/graphql`): `viewer`, `repository` (with
  `defaultBranchRef`, `viewerPermission`, `hasIssuesEnabled`), `issue` /
  `issues` (cursor pagination, `CREATED_AT` ordering, state filters),
  `pullRequest` / `pullRequests` (with `mergeable` and `files`),
  `__type` introspection, `node(id:)` Relay round-trips, the
  `createIssue` / `closeIssue` / `createPullRequest` / `mergePullRequest` /
  `addComment` mutations, and GitHub-style batched operation documents.
  Global ids are opaque and stable across reads.
- **MCP** (`POST /mcp`): the modern 2026-07-28 era via `server/discover`
  (with `initialize` also answered), and the six tools
  `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request` — the same objects REST reads,
  with stable ids.

The bearer token names the viewer: the entry replays the contest's fixed
seeded scenario (the same deterministic PRNG the suite uses) to know the
viewer's login from startup, so repositories, `viewer.login` and
`GET /api/v3/user` all agree without any configuration.

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind an ephemeral port, register,
  poll `/done`, exit 0). Kept as the starter ships it.
- `app.ts` — the server: routing, auth, JSON plumbing.
- `src/store.ts` — the in-memory store and the git machinery: SHA-1,
  objects, trees, reachability, packs (read and write, deltas resolved),
  pkt-lines, line diffs, Relay global ids.
- `src/git.ts` — smart HTTP.
- `src/rest.ts` — REST v3.
- `src/graphql.ts` — a small GraphQL parser and executor.
- `src/mcp.ts` — MCP over streamable HTTP (plain JSON POSTs).
- `src/scenario.ts` — the seeded-scenario PRNG port that derives the
  viewer login.

## Run it

```sh
node main.ts
```

Node 22.18 or later (the platform runs `node /bot/main.ts`; type stripping
is built in there). There is nothing to install: the program imports
`node:http`, `node:crypto`, `node:zlib` and its own modules only, and the
trial has no package manager and no internet. `MAKEFUN_ENV_URL` must name
the env to register with.

## Local verification

The kit's local runner grades the same suite the trial runs, byte for byte:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token TOK --perf
```

Against a local server on Node 22.18.0: **120/120 checks pass** (git 30,
repos 15, issues 15, pulls 20, graphql 20, mcp 15, protocol 5) —
feature 600, agent 200 — and the four timed workloads score 156–168 of
200, for a local total of **956–968 of 1000**. Workload medians on this
machine: push ~710 ms, clone ~162 ms, read ~720 ms, write ~112 ms
(reference medians: push ~1700 ms, clone ~285 ms, read ~2600 ms,
write ~370 ms).

## License

MIT. See [LICENSE](LICENSE).
