export const MAX_ATTACHMENT_BYTES = 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 1024 * 1024;
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'json', 'js', 'jsx', 'ts', 'tsx', 'css', 'html', 'xml', 'yaml', 'yml', 'toml', 'log', 'csv', 'sql', 'py', 'sh', 'kt', 'java', 'c', 'cpp', 'h', 'hpp', 'rs', 'go']);
const MIME_BY_EXTENSION = new Map([
  ['md', 'text/markdown'], ['json', 'application/json'], ['js', 'text/javascript'],
  ['jsx', 'text/javascript'], ['ts', 'text/plain'], ['tsx', 'text/plain'],
  ['css', 'text/css'], ['html', 'text/html'], ['xml', 'application/xml'],
  ['yaml', 'text/yaml'], ['yml', 'text/yaml'], ['csv', 'text/csv'], ['sql', 'text/plain']
]);

function extensionOf(name) { return String(name || '').split('.').pop().toLowerCase(); }
function makeId() { return globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2); }

async function compressImage(file) {
  if (file.size <= MAX_ATTACHMENT_BYTES) return file;
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    throw new Error('This image exceeds the 1 MiB limit and this browser cannot compress it.');
  }
  const bitmap = await createImageBitmap(file);
  try {
    let width = bitmap.width;
    let height = bitmap.height;
    const canvas = document.createElement('canvas');
    for (let pass = 0; pass < 7; pass += 1) {
      const scale = pass === 0 ? Math.min(1, 1800 / Math.max(width, height)) : 0.82;
      if (pass > 0) { width = Math.max(1, Math.round(width * scale)); height = Math.max(1, Math.round(height * scale)); }
      else { width = Math.max(1, Math.round(width * scale)); height = Math.max(1, Math.round(height * scale)); }
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('Image compression is unavailable.');
      context.drawImage(bitmap, 0, 0, width, height);
      for (const quality of [0.82, 0.68, 0.52, 0.4]) {
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
        if (blob && blob.size <= MAX_ATTACHMENT_BYTES) {
          return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg', lastModified: Date.now() });
        }
      }
    }
    throw new Error('Image is still larger than 1 MiB after compression. Resize it before attaching.');
  } finally {
    bitmap.close?.();
  }
}

export async function prepareAttachment(file) {
  if (!(file instanceof Blob)) throw new TypeError('Choose a valid file.');
  const name = String(file.name || 'attachment').slice(0, 180);
  const extension = extensionOf(name);
  const isImage = String(file.type || '').startsWith('image/') || /\\.(?:png|jpe?g|webp|gif|avif)$/i.test(name);
  const isText = String(file.type || '').startsWith('text/') || TEXT_EXTENSIONS.has(extension) || MIME_BY_EXTENSION.has(extension);
  if (!isImage && !isText) throw new Error('Unsupported file type. Attach an image or a supported project/text file.');
  const prepared = isImage ? await compressImage(file) : file;
  if (prepared.size > MAX_ATTACHMENT_BYTES) throw new Error('Attachments are limited to 1 MiB each. This file is too large.');
  const base = { id: makeId(), name, type: prepared.type || MIME_BY_EXTENSION.get(extension) || 'application/octet-stream', size: prepared.size };
  if (isImage) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read the selected image.'));
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(prepared);
    });
    return { ...base, kind: 'image', dataUrl, base64: dataUrl.split(',')[1] || '' };
  }
  const text = await prepared.text();
  return { ...base, kind: 'text', text };
}

export async function prepareAttachments(files) {
  const results = [];
  for (const file of Array.from(files || [])) results.push(await prepareAttachment(file));
  return results;
}

export function buildAttachmentPrompt(attachments = []) {
  if (!attachments.length) return '';
  const sections = attachments.map(item => {
    if (item.kind === 'text') return '--- FILE: ' + item.name + ' (' + item.type + ') ---\n' + item.text + '\n--- END FILE ---';
    return 'Attached image: ' + item.name + ' (' + item.type + ').';
  });
  return '\n\nUser attachments:\n' + sections.join('\n\n');
}

function uniquePaths(messages) {
  const source = messages.map(message => String(message.content || '')).join('\n');
  const paths = new Set();
  const pattern = /(?:^|[\s`"'(])((?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]{1,12}|[\w.@-]+\.[A-Za-z0-9]{1,12})(?=$|[\s`"'),:])/gm;
  for (const match of source.matchAll(pattern)) {
    const path = match[1];
    if (!/^(?:https?|localhost):/i.test(path) && path.length < 180) paths.add(path);
  }
  return [...paths].slice(0, 20);
}

export function buildOutcomeSummary(messages = [], logs = []) {
  const relevant = messages.filter(message => ['user', 'assistant', 'tool'].includes(message.role));
  const text = relevant.map(message => String(message.content || '')).filter(Boolean);
  const assistant = relevant.filter(message => message.role === 'assistant').map(message => String(message.content || '')).filter(Boolean);
  const lastAssistant = assistant.at(-1) || '';
  const paths = uniquePaths(relevant);
  const combined = text.join('\n').toLowerCase();
  const failed = /\b(failed|failure|error|not pass|did not pass|blocked)\b/.test(combined) || logs.some(item => item.kind === 'error');
  const passed = /\b(passed|success|verified|all tests pass|build succeeded|build passed)\b/.test(combined) || logs.some(item => item.kind === 'success');
  const remaining = text.flatMap(value => value.split('\n')).filter(line => /\b(todo|next step|remaining|still need|not yet|pending|blocked)\b/i.test(line)).map(line => line.trim()).filter(Boolean).slice(-5);
  const changed = lastAssistant.split('\n').map(line => line.trim()).filter(line => /\b(added|updated|changed|fixed|implemented|removed|created|refactored|committed)\b/i.test(line)).slice(0, 5);
  return [
    '## What Changed',
    changed.length ? changed.map(line => '- ' + line.replace(/^[-*]\s*/, '')).join('\n') : '- No concrete change is explicitly recorded in the conversation.',
    '',
    '## Files Touched',
    paths.length ? paths.map(path => '- ' + path).join('\n') : '- No file paths were identified in the conversation.',
    '',
    '## Verification Status',
    failed ? '- Issues or failures are mentioned. Review the execution trace before treating this outcome as complete.' : passed ? '- Successful checks are mentioned in the conversation or execution trace. This summary does not independently rerun them.' : '- No explicit verification result was found.',
    '',
    '## Remaining Next Steps',
    remaining.length ? remaining.map(line => '- ' + line.replace(/^[-*]\s*/, '')).join('\n') : '- No outstanding next steps were explicitly recorded.'
  ].join('\n');
}
