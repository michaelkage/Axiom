import test from 'node:test';
import assert from 'node:assert/strict';
import { registerGitHubTools } from '../src/lib/githubTools.js';
import { executeTool, listTools } from '../src/lib/toolRegistry.js';

const response = value => new Response(JSON.stringify(value), {
  status: 200,
  headers: { 'content-type': 'application/json' }
});

test('GitHub integration registers repository-scoped read and approval-gated write tools', async () => {
  const requests = [];
  const cleanup = registerGitHubTools({
    token: 'gateway-session-token',
    repository: 'acme/project',
    baseUrl: 'https://gateway.example.test/api/github',
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith('/repos/acme/project')) {
        return response({ full_name: 'acme/project', default_branch: 'main', private: true, html_url: 'https://github.com/acme/project' });
      }
      if (String(url).includes('/contents/')) {
        return response([{ name: 'README.md', path: 'README.md', type: 'file', size: 10, sha: 'blob', html_url: 'https://github.com/acme/project/blob/main/README.md' }]);
      }
      if (String(url).includes('/search/code')) {
        return response({ total_count: 1, items: [{ name: 'server.mjs', path: 'gateway/server.mjs', sha: 'blob', html_url: 'https://github.com/acme/project/blob/main/gateway/server.mjs', repository: { full_name: 'acme/project' } }] });
      }
      return response([]);
    }
  });
  try {
    const names = listTools().map(tool => tool.name);
    for (const name of ['github_get_repository', 'github_list_directory', 'github_get_file', 'github_list_branches', 'github_list_commits', 'github_search_code', 'github_list_issues', 'github_list_pull_requests', 'github_update_file', 'github_create_file']) {
      assert.ok(names.includes(name), 'missing ' + name);
    }
    assert.equal(listTools().find(tool => tool.name === 'github_update_file').requiresApproval, true);
    assert.equal(listTools().find(tool => tool.name === 'github_create_file').requiresApproval, true);

    const repository = await executeTool('github_get_repository', {});
    assert.equal(repository.full_name, 'acme/project');
    const root = await executeTool('github_list_directory', { path: '' });
    assert.equal(root[0].path, 'README.md');
    const search = await executeTool('github_search_code', { query: 'gateway' });
    assert.equal(search.total_count, 1);
    assert.ok(requests.some(item => item.url.includes('/search/code') && item.url.includes('repo%3Aacme%2Fproject')));
  } finally {
    cleanup();
  }
  assert.equal(listTools().some(tool => tool.name.startsWith('github_')), false);
});

test('GitHub integration validates credentials and repository configuration', () => {
  assert.throws(() => registerGitHubTools({ token: '', repository: 'acme/project' }), /gateway session/);
  assert.throws(() => registerGitHubTools({ token: 'gateway-session-token', repository: 'not-a-repository' }), /owner\/repo/);
});
