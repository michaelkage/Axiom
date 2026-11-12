import { Octokit } from '@octokit/rest';
import { registerTool } from './toolRegistry.js';

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_TEXT_RESULT = 180000;

function decodeContent(content) {
  return new TextDecoder().decode(Uint8Array.from(atob(String(content || '').replace(/\s/g, '')), character => character.charCodeAt(0)));
}

function compactIssue(issue) {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    html_url: issue.html_url,
    user: issue.user?.login || null,
    labels: (issue.labels || []).map(label => typeof label === 'string' ? label : label.name),
    updated_at: issue.updated_at,
    body: String(issue.body || '').slice(0, 4000)
  };
}

export function registerGitHubTools({ token, repository, baseUrl = 'https://api.github.com', fetchImpl = globalThis.fetch }) {
  if (!token) throw new Error('A paired gateway session is required to use GitHub.');
  if (!REPOSITORY_PATTERN.test(repository || '')) throw new Error('Configure a valid GitHub repository in owner/repo format in Settings.');
  const octokit = new Octokit({ auth: token, baseUrl, userAgent: 'Axiom-Mobile/1.0', request: fetchImpl ? { fetch: fetchImpl } : undefined });
  const [owner, repo] = repository.split('/');
  const unregister = [];
  const register = (definition, handler) => unregister.push(registerTool(definition, handler));
  try {
    register({
      name: 'github_get_repository',
      description: 'Get metadata for the single GitHub repository configured in Axiom, including its default branch and visibility.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    }, async (_input, { signal } = {}) => {
      const { data } = await octokit.repos.get({ owner, repo, request: { signal } });
      return {
        full_name: data.full_name,
        description: data.description,
        private: data.private,
        default_branch: data.default_branch,
        html_url: data.html_url,
        updated_at: data.updated_at,
        permissions: data.permissions ? { pull: Boolean(data.permissions.pull), push: Boolean(data.permissions.push), admin: Boolean(data.permissions.admin) } : null
      };
    });

    register({
      name: 'github_list_directory',
      description: 'List files and folders in a directory of the configured GitHub repository. Use an empty path for the repository root.',
      inputSchema: { type: 'object', properties: { path: { type: 'string', maxLength: 1024 }, ref: { type: 'string', maxLength: 256 } }, additionalProperties: false }
    }, async ({ path = '', ref }, { signal } = {}) => {
      const { data } = await octokit.repos.getContent({ owner, repo, path, ...(ref ? { ref } : {}), request: { signal } });
      if (!Array.isArray(data)) throw new Error('The requested path is a file. Use github_get_file to read it.');
      return data.map(item => ({ name: item.name, path: item.path, type: item.type, size: item.size, sha: item.sha, html_url: item.html_url })).slice(0, 200);
    });

    register({
      name: 'github_get_file',
      description: 'Read a UTF-8 text file from the configured GitHub repository. Returns its current blob SHA for safe updates.',
      inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 1024 }, ref: { type: 'string', maxLength: 256 } }, required: ['path'], additionalProperties: false }
    }, async ({ path, ref }, { signal } = {}) => {
      const { data } = await octokit.repos.getContent({ owner, repo, path, ...(ref ? { ref } : {}), request: { signal } });
      if (Array.isArray(data) || data.type !== 'file') throw new Error('The requested path is not a file. Use github_list_directory for folders.');
      if (data.size > MAX_TEXT_RESULT) throw new Error('File exceeds the 180 KB tool output limit. Use a smaller file.');
      const content = decodeContent(data.content);
      return { path, sha: data.sha, size: data.size, content };
    });

    register({
      name: 'github_list_branches',
      description: 'List branches in the configured GitHub repository.',
      inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false }
    }, async ({ limit = 50 }, { signal } = {}) => {
      const { data } = await octokit.repos.listBranches({ owner, repo, per_page: limit, request: { signal } });
      return data.map(branch => ({ name: branch.name, sha: branch.commit.sha, protected: branch.protected }));
    });

    register({
      name: 'github_list_commits',
      description: 'List recent commits from the configured GitHub repository, optionally scoped to a branch or path.',
      inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50 }, branch: { type: 'string', maxLength: 256 }, path: { type: 'string', maxLength: 1024 } }, additionalProperties: false }
    }, async ({ limit = 20, branch, path }, { signal } = {}) => {
      const { data } = await octokit.repos.listCommits({ owner, repo, per_page: limit, ...(branch ? { sha: branch } : {}), ...(path ? { path } : {}), request: { signal } });
      return data.map(commit => ({ sha: commit.sha, message: commit.commit.message.slice(0, 2000), author: commit.commit.author?.name || null, date: commit.commit.author?.date || null, html_url: commit.html_url }));
    });

    register({
      name: 'github_search_code',
      description: 'Search code in the configured GitHub repository. Query should contain code terms, filenames, or identifiers, not a repository selector.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 256 }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['query'], additionalProperties: false }
    }, async ({ query, limit = 10 }, { signal } = {}) => {
      if (/\\b(?:repo|org|user):/i.test(query) || /\\b(?:OR|NOT)\\b/i.test(query)) throw new Error('Search query cannot override repository scope or use boolean operators.');
      const { data } = await octokit.search.code({ q: query + ' repo:' + owner + '/' + repo, per_page: limit, request: { signal } });
      return { total_count: data.total_count, items: data.items.map(item => ({ name: item.name, path: item.path, sha: item.sha, html_url: item.html_url, repository: item.repository.full_name })) };
    });

    register({
      name: 'github_list_issues',
      description: 'List recent open issues in the configured GitHub repository.',
      inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50 }, state: { type: 'string', enum: ['open', 'closed', 'all'] } }, additionalProperties: false }
    }, async ({ limit = 20, state = 'open' }, { signal } = {}) => {
      const { data } = await octokit.issues.listForRepo({ owner, repo, per_page: limit, state, request: { signal } });
      return data.filter(item => !item.pull_request).map(compactIssue);
    });

    register({
      name: 'github_list_pull_requests',
      description: 'List recent pull requests in the configured GitHub repository.',
      inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50 }, state: { type: 'string', enum: ['open', 'closed', 'all'] } }, additionalProperties: false }
    }, async ({ limit = 20, state = 'open' }, { signal } = {}) => {
      const { data } = await octokit.pulls.list({ owner, repo, per_page: limit, state, request: { signal } });
      return data.map(item => ({ number: item.number, title: item.title, state: item.state, draft: item.draft, head: item.head.ref, base: item.base.ref, user: item.user?.login || null, html_url: item.html_url, updated_at: item.updated_at }));
    });

    register({
      name: 'github_update_file',
      requiresApproval: true,
      description: 'Commit a complete replacement for an existing file. Requires the current blob SHA from github_get_file.',
      inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 1024 }, content: { type: 'string', maxLength: 1000000 }, sha: { type: 'string', minLength: 1 }, message: { type: 'string', minLength: 1, maxLength: 200 }, branch: { type: 'string', maxLength: 256 } }, required: ['path', 'content', 'sha', 'message'], additionalProperties: false }
    }, async ({ path, content, sha, message, branch }, { signal } = {}) => {
      const response = await octokit.repos.createOrUpdateFileContents({ owner, repo, path, message, content: btoa(Array.from(new TextEncoder().encode(content), byte => String.fromCharCode(byte)).join('')), sha, ...(branch ? { branch } : {}), request: { signal } });
      return { path, commitSha: response.data.commit.sha, contentSha: response.data.content?.sha };
    });

    register({
      name: 'github_create_file',
      requiresApproval: true,
      description: 'Create a new text file in the configured GitHub repository and commit it.',
      inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 1024 }, content: { type: 'string', maxLength: 1000000 }, message: { type: 'string', minLength: 1, maxLength: 200 }, branch: { type: 'string', maxLength: 256 } }, required: ['path', 'content', 'message'], additionalProperties: false }
    }, async ({ path, content, message, branch }, { signal } = {}) => {
      const response = await octokit.repos.createOrUpdateFileContents({ owner, repo, path, message, content: btoa(Array.from(new TextEncoder().encode(content), byte => String.fromCharCode(byte)).join('')), ...(branch ? { branch } : {}), request: { signal } });
      return { path, commitSha: response.data.commit.sha, contentSha: response.data.content?.sha };
    });
  } catch (error) {
    unregister.forEach(fn => fn());
    throw error;
  }
  return () => unregister.forEach(fn => fn());
}
