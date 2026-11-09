import { Octokit } from '@octokit/rest';
import { registerTool } from './toolRegistry.js';

export function registerGitHubTools({ token, repository }) {
  if (!token) throw new Error('A GitHub Personal Access Token is required.');
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) throw new Error('Repository must be owner/name.');
  const octokit = new Octokit({ auth: token });
  const [owner, repo] = repository.split('/');
  const unregister = [];
  unregister.push(registerTool({
    name: 'github_get_file',
    description: 'Read a text file from the configured GitHub repository.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, ref: { type: 'string' } }, required: ['path'], additionalProperties: false }
  }, async ({ path, ref }) => {
    const response = await octokit.repos.getContent({ owner, repo, path, ...(ref ? { ref } : {}) });
    if (Array.isArray(response.data) || response.data.type !== 'file') throw new Error('The requested path is not a file.');
    return { path, sha: response.data.sha, content: Buffer.from(response.data.content, 'base64').toString('utf8') };
  }));
  unregister.push(registerTool({
    name: 'github_update_file',
    description: 'Commit a complete replacement for an existing file. Requires the current blob SHA.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, content: { type: 'string' }, sha: { type: 'string', minLength: 1 }, message: { type: 'string', minLength: 1 }, branch: { type: 'string' } }, required: ['path', 'content', 'sha', 'message'], additionalProperties: false }
  }, async ({ path, content, sha, message, branch }) => {
    const response = await octokit.repos.createOrUpdateFileContents({ owner, repo, path, message, content: Buffer.from(content).toString('base64'), sha, ...(branch ? { branch } : {}) });
    return { path, commitSha: response.data.commit.sha, contentSha: response.data.content?.sha };
  }));
  return () => unregister.forEach(fn => fn());
}
