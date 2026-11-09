import { Octokit } from '@octokit/rest';
import { registerTool } from './toolRegistry.js';

export function registerGitHubTools({ token, repository }) {
  if (!token) throw new Error('A GitHub Personal Access Token is required.');
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) throw new Error('Repository must be owner/name.');
  const octokit = new Octokit({ auth: token });
  const [owner, repo] = repository.split('/');
  const unregister = [];
  try {
  unregister.push(registerTool({
    name: 'github_get_file',
    description: 'Read a text file from the configured GitHub repository.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, ref: { type: 'string' } }, required: ['path'], additionalProperties: false }
  }, async ({ path, ref }, { signal } = {}) => {
    const response = await octokit.repos.getContent({ owner, repo, path, ...(ref ? { ref } : {}), request: { signal } });
    if (Array.isArray(response.data) || response.data.type !== 'file') throw new Error('The requested path is not a file.');
    return { path, sha: response.data.sha, content: new TextDecoder().decode(Uint8Array.from(atob(response.data.content.replace(/\s/g, '')), c => c.charCodeAt(0))) };
  }));
  unregister.push(registerTool({
    name: 'github_update_file',
    requiresApproval: true,
    description: 'Commit a complete replacement for an existing file. Requires the current blob SHA.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, content: { type: 'string' }, sha: { type: 'string', minLength: 1 }, message: { type: 'string', minLength: 1 }, branch: { type: 'string' } }, required: ['path', 'content', 'sha', 'message'], additionalProperties: false }
  }, async ({ path, content, sha, message, branch }, { signal } = {}) => {
    const response = await octokit.repos.createOrUpdateFileContents({ owner, repo, path, message, content: btoa(Array.from(new TextEncoder().encode(content), byte => String.fromCharCode(byte)).join('')), sha, ...(branch ? { branch } : {}), request: { signal } });
    return { path, commitSha: response.data.commit.sha, contentSha: response.data.content?.sha };
  }));
  unregister.push(registerTool({
    name: 'github_create_file',
    requiresApproval: true,
    description: 'Create a new text file in the configured GitHub repository and commit it.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, content: { type: 'string' }, message: { type: 'string', minLength: 1 }, branch: { type: 'string' } }, required: ['path', 'content', 'message'], additionalProperties: false }
  }, async ({ path, content, message, branch }, { signal } = {}) => {
    const response = await octokit.repos.createOrUpdateFileContents({ owner, repo, path, message, content: btoa(Array.from(new TextEncoder().encode(content), byte => String.fromCharCode(byte)).join('')), ...(branch ? { branch } : {}), request: { signal } });
    return { path, commitSha: response.data.commit.sha, contentSha: response.data.content?.sha };
  }));
  } catch (error) {
    unregister.forEach(fn => fn());
    throw error;
  }
  return () => unregister.forEach(fn => fn());
}
