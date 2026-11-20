// GraphQL v4: a small parser and executor for the documents `gh` and
// `github-mcp-server` send. The documents are fixed, so the executor only
// needs the subset they use: queries, mutations, variables, fragments
// (spread and inline), enum/object/list literals and __type introspection.
// Unknown fields are reported with a message naming the field, as the
// suite's invalid-field check requires; a batched array body answers an
// array of results in order.

import {
  buildCommit,
  commentGlobalId,
  issueGlobalId,
  parseGlobalId,
  pullGlobalId,
  repoGlobalId,
  type PullRecord,
  type Repo,
  type Store,
} from './store.ts';
import { VIEWER_LOGIN } from './scenario.ts';
import { pullConflicts } from './rest.ts';

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name: string | null;
  variableDefinitions: Array<{ name: string; type: string; defaultValue: ValueNode | null }>;
  selection: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selection: SelectionNode[];
}

type DefinitionNode = OperationNode | FragmentNode;

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (/\s/.test(ch) || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]!:$=@&|'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j] as string;
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  peek(): string | null {
    return this.tokens[this.pos] ?? null;
  }

  next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token} in GraphQL document, got ${got}`);
  }

  parseDocument(): DefinitionNode[] {
    const definitions: DefinitionNode[] = [];
    while (this.peek() !== null) definitions.push(this.parseDefinition());
    return definitions;
  }

  parseDefinition(): DefinitionNode {
    const token = this.peek();
    if (token === 'query' || token === 'mutation') {
      this.next();
      let name: string | null = null;
      if (this.peek() !== null && this.peek() !== '(' && this.peek() !== '{') name = this.next();
      const variableDefinitions = this.parseVariableDefinitions();
      const selection = this.parseSelectionSet();
      return { kind: 'operation', operation: token, name, variableDefinitions, selection };
    }
    if (token === 'fragment') {
      this.next();
      const name = this.next();
      this.expect('on');
      const typeCondition = this.next();
      const selection = this.parseSelectionSet();
      return { kind: 'fragment', name, typeCondition, selection };
    }
    if (token === '{') {
      return { kind: 'operation', operation: 'query', name: null, variableDefinitions: [], selection: this.parseSelectionSet() };
    }
    throw new Error(`unexpected ${token} in GraphQL document`);
  }

  parseVariableDefinitions(): Array<{ name: string; type: string; defaultValue: ValueNode | null }> {
    const defs: Array<{ name: string; type: string; defaultValue: ValueNode | null }> = [];
    if (this.peek() !== '(') return defs;
    this.next();
    while (this.peek() !== ')') {
      this.expect('$');
      const name = this.next();
      this.expect(':');
      const type = this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.peek() === '=') {
        this.next();
        defaultValue = this.parseValue();
      }
      defs.push({ name, type, defaultValue });
    }
    this.next();
    return defs;
  }

  parseType(): string {
    let type = '';
    if (this.peek() === '[') {
      this.next();
      type = `[${this.parseType()}]`;
    } else {
      type = this.next();
    }
    if (this.peek() === '!') {
      this.next();
      type += '!';
    }
    return type;
  }

  parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        const name = this.peek();
        if (name === 'on') {
          this.next();
          const typeCondition = this.next();
          selections.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'spread', name: this.next() });
        }
        continue;
      }
      const first = this.next();
      let alias: string | null = null;
      let name = first;
      if (this.peek() === ':') {
        this.next();
        alias = first;
        name = this.next();
      }
      const args = this.parseArguments();
      let selection: SelectionNode[] = [];
      if (this.peek() === '{') selection = this.parseSelectionSet();
      selections.push({ kind: 'field', alias, name, args, selection });
    }
    this.next();
    return selections;
  }

  parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek() !== '(') return args;
    this.next();
    while (this.peek() !== ')') {
      const name = this.next();
      this.expect(':');
      args.push({ name, value: this.parseValue() });
    }
    this.next();
    return args;
  }

  parseValue(): ValueNode {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const values: ValueNode[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    if (/^-?\d*\.?\d+(e[+-]?\d+)?$/i.test(token)) return { kind: 'float', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

function parseDocument(source: string): DefinitionNode[] {
  return new Parser(tokenize(source)).parseDocument();
}

// ---------------------------------------------------------------- schema

interface TypeField {
  name: string;
  type: string;
}

const SCHEMA_TYPES: Record<string, { kind: 'OBJECT' | 'ENUM'; fields?: TypeField[]; values?: string[] }> = {
  Query: {
    kind: 'OBJECT',
    fields: [
      { name: 'viewer', type: 'User' },
      { name: 'repository', type: 'Repository' },
      { name: 'node', type: 'Node' },
      { name: '__type', type: '__Type' },
    ],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'databaseId', type: 'Int' },
      { name: 'name', type: 'String' },
      { name: 'nameWithOwner', type: 'String' },
      { name: 'owner', type: 'User' },
      { name: 'defaultBranchRef', type: 'Ref' },
      { name: 'viewerPermission', type: 'RepositoryPermission' },
      { name: 'hasIssuesEnabled', type: 'Boolean' },
      { name: 'issue', type: 'Issue' },
      { name: 'issues', type: 'IssueConnection' },
      { name: 'pullRequest', type: 'PullRequest' },
      { name: 'pullRequests', type: 'PullRequestConnection' },
    ],
  },
  Issue: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'number', type: 'Int' },
      { name: 'title', type: 'String' },
      { name: 'body', type: 'String' },
      { name: 'state', type: 'IssueState' },
      { name: 'url', type: 'String' },
      { name: 'createdAt', type: 'String' },
      { name: 'updatedAt', type: 'String' },
      { name: 'author', type: 'User' },
      { name: 'repository', type: 'Repository' },
    ],
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', type: 'Issue' },
      { name: 'pageInfo', type: 'PageInfo' },
      { name: 'totalCount', type: 'Int' },
    ],
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: [
      { name: 'hasNextPage', type: 'Boolean' },
      { name: 'hasPreviousPage', type: 'Boolean' },
      { name: 'startCursor', type: 'String' },
      { name: 'endCursor', type: 'String' },
    ],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'number', type: 'Int' },
      { name: 'title', type: 'String' },
      { name: 'body', type: 'String' },
      { name: 'state', type: 'PullRequestState' },
      { name: 'merged', type: 'Boolean' },
      { name: 'headRefName', type: 'String' },
      { name: 'baseRefName', type: 'String' },
      { name: 'mergeable', type: 'MergeableState' },
      { name: 'files', type: 'PullRequestChangedFileConnection' },
      { name: 'url', type: 'String' },
    ],
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', type: 'PullRequest' },
      { name: 'pageInfo', type: 'PageInfo' },
      { name: 'totalCount', type: 'Int' },
    ],
  },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', type: 'PullRequestChangedFile' },
      { name: 'pageInfo', type: 'PageInfo' },
      { name: 'totalCount', type: 'Int' },
    ],
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: [{ name: 'path', type: 'String' }],
  },
  User: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'login', type: 'String' },
      { name: 'name', type: 'String' },
    ],
  },
  Ref: {
    kind: 'OBJECT',
    fields: [
      { name: 'name', type: 'String' },
      { name: 'target', type: 'String' },
    ],
  },
  Mutation: {
    kind: 'OBJECT',
    fields: [
      { name: 'createIssue', type: 'CreateIssuePayload' },
      { name: 'closeIssue', type: 'CloseIssuePayload' },
      { name: 'createPullRequest', type: 'CreatePullRequestPayload' },
      { name: 'mergePullRequest', type: 'MergePullRequestPayload' },
      { name: 'addComment', type: 'AddCommentPayload' },
    ],
  },
  CreateIssuePayload: { kind: 'OBJECT', fields: [{ name: 'issue', type: 'Issue' }] },
  CloseIssuePayload: { kind: 'OBJECT', fields: [{ name: 'issue', type: 'Issue' }] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: [{ name: 'pullRequest', type: 'PullRequest' }] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: [{ name: 'pullRequest', type: 'PullRequest' }] },
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: [{ name: 'commentEdge', type: 'IssueCommentEdge' }],
  },
  IssueCommentEdge: {
    kind: 'OBJECT',
    fields: [{ name: 'node', type: 'IssueComment' }],
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'body', type: 'String' },
      { name: 'author', type: 'User' },
    ],
  },
  __Type: {
    kind: 'OBJECT',
    fields: [
      { name: 'name', type: 'String' },
      { name: 'kind', type: 'String' },
      { name: 'fields', type: '__Field' },
      { name: 'enumValues', type: '__EnumValue' },
    ],
  },
  __Field: { kind: 'OBJECT', fields: [{ name: 'name', type: 'String' }] },
  __EnumValue: { kind: 'OBJECT', fields: [{ name: 'name', type: 'String' }] },
  IssueState: { kind: 'ENUM', values: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', values: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', values: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', values: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', values: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'ENUM', values: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'] },
  IssueOrderField: { kind: 'ENUM', values: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', values: ['ASC', 'DESC'] },
};

// ---------------------------------------------------------------- executor

type SourceValue =
  | { __type: 'viewer'; login: string }
  | { __type: 'fieldValue'; name: string; of: 'field' | 'enumValue' }
  | { __type: 'repository'; repo: Repo }
  | { __type: 'issue'; repo: Repo; issue: Repo['issues'][number] }
  | { __type: 'issueConnection'; repo: Repo; issues: Repo['issues'][number][]; hasNextPage: boolean; endCursor: string | null }
  | { __type: 'pullRequest'; repo: Repo; pull: PullRecord }
  | { __type: 'pullRequestConnection'; repo: Repo; pulls: PullRecord[] }
  | { __type: 'pullRequestFiles'; repo: Repo; pull: PullRecord }
  | { __type: 'pullRequestFile'; path: string }
  | { __type: 'user'; login: string }
  | { __type: 'ref'; name: string }
  | { __type: 'pageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __type: 'type'; name: string }
  | { __type: 'payload'; value: Record<string, SourceValue | null> }
  | { __type: 'commentEdge'; repo: Repo; issueNumber: number; commentId: number; body: string }
  | { __type: 'comment'; repo: Repo; issueNumber: number; commentId: number; body: string }
  | { __type: 'node'; value: SourceValue | null }
  | { __type: 'root' };

class GraphQLError extends Error {}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'string':
      return node.value;
    case 'int':
    case 'float':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => valueOf(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, variables: Record<string, unknown>): unknown {
  const arg = field.args.find((entry) => entry.name === name);
  return arg === undefined ? undefined : valueOf(arg.value, variables);
}

function typeNameOf(value: SourceValue): string {
  switch (value.__type) {
    case 'viewer':
      return 'User';
    case 'fieldValue':
      return value.of === 'field' ? '__Field' : '__EnumValue';
    case 'repository':
      return 'Repository';
    case 'issue':
      return 'Issue';
    case 'issueConnection':
      return 'IssueConnection';
    case 'pullRequest':
      return 'PullRequest';
    case 'pullRequestConnection':
      return 'PullRequestConnection';
    case 'pullRequestFiles':
      return 'PullRequestChangedFileConnection';
    case 'pullRequestFile':
      return 'PullRequestChangedFile';
    case 'user':
      return 'User';
    case 'ref':
      return 'Ref';
    case 'pageInfo':
      return 'PageInfo';
    case 'type':
      return '__Type';
    case 'payload':
      return 'Payload';
    case 'commentEdge':
      return 'IssueCommentEdge';
    case 'comment':
      return 'IssueComment';
    case 'node':
      return value.value === null ? 'Node' : typeNameOf(value.value);
    case 'root':
      return 'Query';
  }
}

function collectFields(
  selections: SelectionNode[],
  fragments: Map<string, FragmentNode>,
  typeName: string,
): FieldNode[] {
  const fields: FieldNode[] = [];
  const seen = new Set<string>();
  const walk = (nodes: SelectionNode[], type: string): void => {
    for (const node of nodes) {
      if (node.kind === 'field') {
        const key = `${node.alias ?? node.name}:${node.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        fields.push(node);
      } else if (node.kind === 'spread') {
        const fragment = fragments.get(node.name);
        if (fragment !== undefined) walk(fragment.selection, fragment.typeCondition);
      } else if (node.kind === 'inline') {
        if (node.typeCondition === null || node.typeCondition === type) {
          walk(node.selection, node.typeCondition ?? type);
        }
      }
    }
  };
  walk(selections, typeName);
  return fields;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberAfter(cursor: string | null): number | null {
  if (cursor === null) return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = text.match(/^cursor:(\d+)$/);
    return m === null ? null : Number(m[1]);
  } catch {
    return null;
  }
}

class Executor {
  private readonly fragments = new Map<string, FragmentNode>();
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  execute(document: string, variables: Record<string, unknown>): { data: unknown; errors: Array<{ message: string }> } {
    let definitions: DefinitionNode[];
    try {
      definitions = parseDocument(document);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
    }
    for (const definition of definitions) {
      if (definition.kind === 'fragment') this.fragments.set(definition.name, definition);
    }
    const operation = definitions.find((definition) => definition.kind === 'operation') as OperationNode | undefined;
    if (operation === undefined) return { data: null, errors: [{ message: 'no operation in document' }] };
    const vars: Record<string, unknown> = {};
    for (const def of operation.variableDefinitions) {
      if (variables[def.name] !== undefined) vars[def.name] = variables[def.name];
      else if (def.defaultValue !== null) vars[def.name] = valueOf(def.defaultValue, variables);
      else vars[def.name] = null;
    }
    try {
      if (operation.operation === 'query') {
        const data = this.resolveSelection({ __type: 'root' }, 'Query', operation.selection, vars);
        return { data, errors: [] };
      }
      const data = this.resolveMutation(operation.selection, vars);
      return { data, errors: [] };
    } catch (err) {
      if (err instanceof GraphQLError) return { data: null, errors: [{ message: err.message }] };
      throw err;
    }
  }

  private resolveSelection(
    source: SourceValue,
    typeName: string,
    selections: SelectionNode[],
    variables: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const fields = collectFields(selections, this.fragments, typeName);
    for (const field of fields) {
      const responseKey = field.alias ?? field.name;
      out[responseKey] = this.resolveField(source, typeName, field, variables);
    }
    return out;
  }

  private resolveField(
    source: SourceValue,
    typeName: string,
    field: FieldNode,
    variables: Record<string, unknown>,
  ): unknown {
    const known = SCHEMA_TYPES[typeName]?.fields?.some((entry) => entry.name === field.name) ?? false;
    if (!known && field.name !== '__typename') {
      throw new GraphQLError(`Cannot query field "${field.name}" on type "${typeName}".`);
    }
    if (field.name === '__typename') return typeName;
    const value = this.fieldValue(source, typeName, field, variables);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      if (Array.isArray(value)) {
        // A list of objects: resolve each element's sub-selection.
        const elementType = this.listElementType(typeName, field.name);
        if (elementType === null || field.selection.length === 0) return value;
        return (value as SourceValue[]).map((element) => this.resolveSelection(element, elementType, field.selection, variables));
      }
      return value;
    }
    const child = value as SourceValue;
    if (field.selection.length === 0) return null;
    return this.resolveSelection(child, typeNameOf(child), field.selection, variables);
  }

  private listElementType(typeName: string, fieldName: string): string | null {
    if (typeName === 'IssueConnection' && fieldName === 'nodes') return 'Issue';
    if (typeName === 'PullRequestConnection' && fieldName === 'nodes') return 'PullRequest';
    if (typeName === 'PullRequestChangedFileConnection' && fieldName === 'nodes') return 'PullRequestChangedFile';
    if (typeName === '__Type' && (fieldName === 'fields' || fieldName === 'enumValues')) return fieldName === 'fields' ? '__Field' : '__EnumValue';
    return null;
  }

  private fieldValue(
    source: SourceValue,
    typeName: string,
    field: FieldNode,
    variables: Record<string, unknown>,
  ): unknown {
    // Root query fields.
    if (source.__type === 'root') {
      if (field.name === 'viewer') return { __type: 'viewer', login: VIEWER_LOGIN } as SourceValue;
      if (field.name === 'repository') {
        const owner = argValue(field, 'owner', variables) as string | undefined;
        const name = argValue(field, 'name', variables) as string | undefined;
        if (owner === undefined || name === undefined) return null;
        const repo = this.store.getRepo(owner, name);
        if (repo === undefined || repo.owner !== this.store.viewer) return null;
        return { __type: 'repository', repo } as SourceValue;
      }
      if (field.name === 'node') {
        const id = argValue(field, 'id', variables) as string | undefined;
        if (id === undefined) return null;
        const parsed = parseGlobalId(id);
        if (parsed === null) return null;
        if (parsed.kind === 'Repository') {
          const repo = this.store.getRepo(parsed.owner, parsed.repo);
          if (repo === undefined) return null;
          return { __type: 'repository', repo } as SourceValue;
        }
        if (parsed.kind === 'Issue' && parsed.number !== null) {
          const repo = this.store.getRepo(parsed.owner, parsed.repo);
          const issue = repo?.issues.find((entry) => entry.number === parsed.number);
          if (repo === undefined || issue === undefined) return null;
          return { __type: 'issue', repo, issue } as SourceValue;
        }
        if (parsed.kind === 'PullRequest' && parsed.number !== null) {
          const repo = this.store.getRepo(parsed.owner, parsed.repo);
          const pull = repo?.pulls.find((entry) => entry.number === parsed.number);
          if (repo === undefined || pull === undefined) return null;
          return { __type: 'pullRequest', repo, pull } as SourceValue;
        }
        return null;
      }
      if (field.name === '__type') {
        const name = argValue(field, 'name', variables) as string | undefined;
        if (name === undefined || SCHEMA_TYPES[name] === undefined) return null;
        return { __type: 'type', name } as SourceValue;
      }
      return null;
    }
    if (source.__type === 'viewer' || source.__type === 'user') {
      if (field.name === 'login') return source.login;
      if (field.name === 'name') return source.login;
      if (field.name === 'id') return Buffer.from(`v1:User:${source.login}`, 'utf8').toString('base64url');
      return null;
    }
    if (source.__type === 'fieldValue') {
      if (field.name === 'name') return source.name;
      return null;
    }
    if (source.__type === 'repository') {
      const repo = source.repo;
      switch (field.name) {
        case 'id':
          return repoGlobalId(repo.owner, repo.name);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return repo.fullName;
        case 'owner':
          return { __type: 'user', login: repo.owner } as SourceValue;
        case 'defaultBranchRef':
          return { __type: 'ref', name: repo.defaultBranch } as SourceValue;
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const number = argValue(field, 'number', variables) as number | undefined;
          if (number === undefined) return null;
          const issue = repo.issues.find((entry) => entry.number === number);
          return issue === undefined ? null : ({ __type: 'issue', repo, issue } as SourceValue);
        }
        case 'issues': {
          const first = (argValue(field, 'first', variables) as number | undefined) ?? 100;
          const after = (argValue(field, 'after', variables) as string | undefined) ?? null;
          const states = (argValue(field, 'states', variables) as string[] | undefined) ?? null;
          const orderBy = (argValue(field, 'orderBy', variables) as Record<string, string> | undefined) ?? null;
          let issues = [...repo.issues];
          if (states !== null) {
            const wanted = new Set(states.map((state) => state.toLowerCase()));
            issues = issues.filter((issue) => wanted.has(issue.state));
          }
          const direction = orderBy?.direction ?? 'DESC';
          issues.sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
          const afterNumber = numberAfter(after);
          if (afterNumber !== null) {
            const index = issues.findIndex((issue) => issue.number === afterNumber);
            if (index >= 0) issues = issues.slice(index + 1);
          }
          const page = issues.slice(0, first);
          const hasNextPage = issues.length > first;
          const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]?.number as number) : null;
          return { __type: 'issueConnection', repo, issues: page, hasNextPage, endCursor } as SourceValue;
        }
        case 'pullRequest': {
          const number = argValue(field, 'number', variables) as number | undefined;
          if (number === undefined) return null;
          const pull = repo.pulls.find((entry) => entry.number === number);
          return pull === undefined ? null : ({ __type: 'pullRequest', repo, pull } as SourceValue);
        }
        case 'pullRequests': {
          const first = (argValue(field, 'first', variables) as number | undefined) ?? 100;
          const pulls = [...repo.pulls].sort((a, b) => b.createdSeq - a.createdSeq).slice(0, first);
          return { __type: 'pullRequestConnection', repo, pulls } as SourceValue;
        }
        default:
          return null;
      }
    }
    if (source.__type === 'issue') {
      const issue = source.issue;
      switch (field.name) {
        case 'id':
          return issueGlobalId(source.repo.owner, source.repo.name, issue.number);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state.toUpperCase();
        case 'url':
          return `https://example.invalid/${source.repo.fullName}/issues/${issue.number}`;
        case 'createdAt':
        case 'updatedAt':
          return new Date(1_735_689_600_000 + issue.createdSeq * 1_000).toISOString();
        case 'author':
          return { __type: 'user', login: source.repo.owner } as SourceValue;
        case 'repository':
          return { __type: 'repository', repo: source.repo } as SourceValue;
        default:
          return null;
      }
    }
    if (source.__type === 'issueConnection') {
      if (field.name === 'nodes') return source.issues.map((issue) => ({ __type: 'issue', repo: source.repo, issue }) as SourceValue);
      if (field.name === 'totalCount') return source.issues.length;
      if (field.name === 'pageInfo') {
        return { __type: 'pageInfo', hasNextPage: source.hasNextPage, endCursor: source.endCursor } as SourceValue;
      }
      return null;
    }
    if (source.__type === 'pullRequestConnection') {
      if (field.name === 'nodes') return source.pulls.map((pull) => ({ __type: 'pullRequest', repo: source.repo, pull }) as SourceValue);
      if (field.name === 'totalCount') return source.pulls.length;
      if (field.name === 'pageInfo') {
        return { __type: 'pageInfo', hasNextPage: false, endCursor: null } as SourceValue;
      }
      return null;
    }
    if (source.__type === 'pullRequest') {
      const pull = source.pull;
      switch (field.name) {
        case 'id':
          return pullGlobalId(source.repo.owner, source.repo.name, pull.number);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged':
          return pull.merged;
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'mergeable':
          return pull.state === 'open' ? (pullConflicts(this.store, source.repo, pull) ? 'CONFLICTING' : 'MERGEABLE') : 'UNKNOWN';
        case 'files': {
          return { __type: 'pullRequestFiles', repo: source.repo, pull } as SourceValue;
        }
        case 'url':
          return `https://example.invalid/${source.repo.fullName}/pull/${pull.number}`;
        default:
          return null;
      }
    }
    if (source.__type === 'pullRequestFiles') {
      if (field.name === 'nodes') {
        const baseCommit = this.store.getCommit(source.repo, source.pull.mergeBaseSha);
        const headCommit = this.store.getCommit(source.repo, source.pull.headSha);
        if (baseCommit === null || headCommit === null) return [];
        const changes = this.store.diffTrees(source.repo, baseCommit.tree, headCommit.tree);
        return changes.map((change) => ({ __type: 'pullRequestFile', path: change.path }) as SourceValue);
      }
      if (field.name === 'totalCount') {
        const baseCommit = this.store.getCommit(source.repo, source.pull.mergeBaseSha);
        const headCommit = this.store.getCommit(source.repo, source.pull.headSha);
        if (baseCommit === null || headCommit === null) return 0;
        return this.store.diffTrees(source.repo, baseCommit.tree, headCommit.tree).length;
      }
      if (field.name === 'pageInfo') {
        return { __type: 'pageInfo', hasNextPage: false, endCursor: null } as SourceValue;
      }
      return null;
    }
    if (source.__type === 'pullRequestFile') {
      if (field.name === 'path') return source.path;
      return null;
    }
    if (source.__type === 'ref') {
      if (field.name === 'name') return source.name;
      if (field.name === 'target') return null;
      return null;
    }
    if (source.__type === 'pageInfo') {
      if (field.name === 'hasNextPage') return source.hasNextPage;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'endCursor') return source.endCursor;
      if (field.name === 'startCursor') return source.endCursor;
      return null;
    }
    if (source.__type === 'type') {
      const type = SCHEMA_TYPES[source.name];
      if (type === undefined) return null;
      if (field.name === 'name') return source.name;
      if (field.name === 'kind') return type.kind;
      if (field.name === 'fields') {
        return (type.fields ?? []).map((entry) => ({ __type: 'fieldValue', name: entry.name, of: 'field' }) as SourceValue);
      }
      if (field.name === 'enumValues') {
        return (type.values ?? []).map((entry) => ({ __type: 'fieldValue', name: entry, of: 'enumValue' }) as SourceValue);
      }
      return null;
    }
    if (source.__type === 'payload') {
      const value = source.value[field.name];
      if (value === undefined || value === null) return null;
      if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
        return value as SourceValue;
      }
      return value as unknown;
    }
    if (source.__type === 'commentEdge') {
      if (field.name === 'node') {
        return { __type: 'comment', repo: source.repo, issueNumber: source.issueNumber, commentId: source.commentId, body: source.body } as SourceValue;
      }
      return null;
    }
    if (source.__type === 'comment') {
      if (field.name === 'id') return commentGlobalId(source.repo.owner, source.repo.name, source.issueNumber, source.commentId);
      if (field.name === 'body') return source.body;
      if (field.name === 'author') return { __type: 'user', login: source.repo.owner } as SourceValue;
      return null;
    }
    return null;
  }

  private resolveMutation(
    selections: SelectionNode[],
    variables: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const fields = collectFields(selections, this.fragments, 'Mutation');
    for (const field of fields) {
      const responseKey = field.alias ?? field.name;
      const payload = this.mutationValue(field, variables);
      if (payload === null) {
        out[responseKey] = null;
        continue;
      }
      if (field.selection.length === 0) {
        out[responseKey] = null;
        continue;
      }
      out[responseKey] = this.resolveSelection(payload, this.payloadType(field.name), field.selection, variables);
    }
    return out;
  }

  private payloadType(fieldName: string): string {
    switch (fieldName) {
      case 'createIssue':
        return 'CreateIssuePayload';
      case 'closeIssue':
        return 'CloseIssuePayload';
      case 'createPullRequest':
        return 'CreatePullRequestPayload';
      case 'mergePullRequest':
        return 'MergePullRequestPayload';
      case 'addComment':
        return 'AddCommentPayload';
      default:
        return 'Payload';
    }
  }

  private mutationValue(field: FieldNode, variables: Record<string, unknown>): SourceValue | null {
    const input = (argValue(field, 'input', variables) ?? {}) as Record<string, unknown>;
    if (field.name === 'createIssue') {
      const repositoryId = input.repositoryId as string | undefined;
      const title = input.title as string | undefined;
      if (repositoryId === undefined || title === undefined) throw new GraphQLError('createIssue needs repositoryId and title');
      const parsed = parseGlobalId(repositoryId);
      if (parsed === null || parsed.kind !== 'Repository') throw new GraphQLError('createIssue: unknown repository');
      const repo = this.store.getRepo(parsed.owner, parsed.repo);
      if (repo === undefined) throw new GraphQLError('createIssue: unknown repository');
      const issue = {
        id: this.store.nextObjectId(),
        number: ++repo.issueSeq,
        title,
        body: (input.body as string | undefined) ?? '',
        state: 'open' as const,
        labels: [],
        createdSeq: this.store.nextSeq(),
      };
      repo.issues.push(issue);
      return { __type: 'payload', value: { issue: { __type: 'issue', repo, issue } as SourceValue } };
    }
    if (field.name === 'closeIssue') {
      const issueId = input.issueId as string | undefined;
      if (issueId === undefined) throw new GraphQLError('closeIssue needs issueId');
      const parsed = parseGlobalId(issueId);
      if (parsed === null || parsed.kind !== 'Issue' || parsed.number === null) throw new GraphQLError('closeIssue: unknown issue');
      const repo = this.store.getRepo(parsed.owner, parsed.repo);
      const issue = repo?.issues.find((entry) => entry.number === parsed.number);
      if (repo === undefined || issue === undefined) throw new GraphQLError('closeIssue: unknown issue');
      issue.state = 'closed';
      return { __type: 'payload', value: { issue: { __type: 'issue', repo, issue } as SourceValue } };
    }
    if (field.name === 'createPullRequest') {
      const repositoryId = input.repositoryId as string | undefined;
      const headRefName = input.headRefName as string | undefined;
      const baseRefName = input.baseRefName as string | undefined;
      const title = input.title as string | undefined;
      if (repositoryId === undefined || headRefName === undefined || baseRefName === undefined || title === undefined) {
        throw new GraphQLError('createPullRequest needs repositoryId, headRefName, baseRefName and title');
      }
      const parsed = parseGlobalId(repositoryId);
      if (parsed === null || parsed.kind !== 'Repository') throw new GraphQLError('createPullRequest: unknown repository');
      const repo = this.store.getRepo(parsed.owner, parsed.repo);
      if (repo === undefined) throw new GraphQLError('createPullRequest: unknown repository');
      const headSha = repo.refs.get(`refs/heads/${headRefName}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRefName}`);
      if (headSha === undefined || baseSha === undefined) throw new GraphQLError('createPullRequest: head or base branch does not exist');
      const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === headRefName && pull.baseRef === baseRefName);
      if (duplicate !== undefined) throw new GraphQLError('createPullRequest: a pull request already exists for these branches');
      const mergeBase = this.store.mergeBase(repo, headSha, baseSha);
      const pull: PullRecord = {
        id: this.store.nextObjectId(),
        number: ++repo.pullSeq,
        title,
        body: (input.body as string | undefined) ?? '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: headRefName,
        baseRef: baseRefName,
        headSha,
        baseSha,
        mergeBaseSha: mergeBase ?? baseSha,
        createdSeq: this.store.nextSeq(),
      };
      repo.pulls.push(pull);
      return { __type: 'payload', value: { pullRequest: { __type: 'pullRequest', repo, pull } as SourceValue } };
    }
    if (field.name === 'mergePullRequest') {
      const pullRequestId = input.pullRequestId as string | undefined;
      if (pullRequestId === undefined) throw new GraphQLError('mergePullRequest needs pullRequestId');
      const parsed = parseGlobalId(pullRequestId);
      if (parsed === null || parsed.kind !== 'PullRequest' || parsed.number === null) {
        throw new GraphQLError('mergePullRequest: unknown pull request');
      }
      const repo = this.store.getRepo(parsed.owner, parsed.repo);
      const pull = repo?.pulls.find((entry) => entry.number === parsed.number);
      if (repo === undefined || pull === undefined) throw new GraphQLError('mergePullRequest: unknown pull request');
      if (pull.state === 'closed') throw new GraphQLError('mergePullRequest: pull request is already closed');
      // Reuse the REST merge: same conflict rule, same squash commit.
      const merged = mergePullRequest(this.store, repo, pull);
      if (!merged) throw new GraphQLError('mergePullRequest: merge conflict');
      return { __type: 'payload', value: { pullRequest: { __type: 'pullRequest', repo, pull } as SourceValue } };
    }
    if (field.name === 'addComment') {
      const subjectId = input.subjectId as string | undefined;
      const body = input.body as string | undefined;
      if (subjectId === undefined || body === undefined) throw new GraphQLError('addComment needs subjectId and body');
      const parsed = parseGlobalId(subjectId);
      if (parsed === null || parsed.kind !== 'Issue' || parsed.number === null) throw new GraphQLError('addComment: unknown subject');
      const repo = this.store.getRepo(parsed.owner, parsed.repo);
      if (repo === undefined) throw new GraphQLError('addComment: unknown subject');
      const issue = repo.issues.find((entry) => entry.number === parsed.number);
      if (issue === undefined) throw new GraphQLError('addComment: unknown subject');
      const comment = { id: this.store.nextObjectId(), body, createdSeq: this.store.nextSeq() };
      const list = repo.comments.get(parsed.number) ?? [];
      list.push(comment);
      repo.comments.set(parsed.number, list);
      return {
        __type: 'payload',
        value: {
          commentEdge: {
            __type: 'commentEdge',
            repo,
            issueNumber: parsed.number,
            commentId: comment.id,
            body,
          } as SourceValue,
        },
      };
    }
    throw new GraphQLError(`Cannot query field "${field.name}" on type "Mutation".`);
  }
}

// The REST merge, reused by the GraphQL mergePullRequest mutation so both
// surfaces squash-merge the same way: the head's changes applied onto the
// base tip as one commit.
function mergePullRequest(store: Store, repo: Repo, pull: PullRecord): boolean {
  if (pull.state === 'closed') return false;
  if (pullConflicts(store, repo, pull)) return false;
  const baseCommit = store.getCommit(repo, pull.mergeBaseSha);
  const headCommit = store.getCommit(repo, pull.headSha);
  const currentBaseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const baseTipCommit = store.getCommit(repo, currentBaseTip);
  if (baseCommit === null || headCommit === null || baseTipCommit === null) return false;
  let tree = baseTipCommit.tree;
  const headChanges = store.diffTrees(repo, baseCommit.tree, headCommit.tree);
  for (const change of headChanges) {
    if (change.status === 'deleted') tree = store.deletePath(repo, tree, change.path);
    else if (change.newOid !== null) tree = store.setPath(repo, tree, change.path, change.newOid);
  }
  const time = Math.floor(Date.now() / 1000);
  const ident = `${VIEWER_LOGIN} <${VIEWER_LOGIN}@example.invalid> ${time} +0000`;
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}\n`;
  const data = buildCommit({ tree, parents: [currentBaseTip], author: ident, committer: ident, message });
  const mergeSha = store.putObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = new Date().toISOString();
  pull.mergeCommitSha = mergeSha;
  return true;
}

// ---------------------------------------------------------------- entry point

export interface GraphQLAnswer {
  status: number;
  body: unknown;
}

export function handleGraphQL(store: Store, rawBody: Buffer): GraphQLAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: { errors: [{ message: 'Request body is not valid JSON' }] } };
  }
  const executor = new Executor(store);
  const runOne = (doc: Record<string, unknown>): unknown => {
    const query = doc.query;
    if (typeof query !== 'string') return { errors: [{ message: 'query is required' }] };
    const variables = (doc.variables ?? {}) as Record<string, unknown>;
    const result = executor.execute(query, variables);
    if (result.errors.length > 0) return { data: result.data, errors: result.errors };
    return { data: result.data };
  };
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map((entry) => (entry !== null && typeof entry === 'object' ? runOne(entry as Record<string, unknown>) : { errors: [{ message: 'invalid operation' }] })) };
  }
  if (parsed !== null && typeof parsed === 'object') {
    return { status: 200, body: runOne(parsed as Record<string, unknown>) };
  }
  return { status: 400, body: { errors: [{ message: 'Request body is not a GraphQL operation' }] } };
}
