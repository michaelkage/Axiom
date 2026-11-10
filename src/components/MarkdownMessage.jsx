import React from 'react';

function renderInline(source, keyPrefix) {
  const pattern = /(\`[^\`]+\`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\((?:https?:\/\/)[^)]+\))/g;
  const nodes = [];
  let cursor = 0;
  let match;
  let index = 0;

  while ((match = pattern.exec(source)) !== null) {
    if (match.index > cursor) nodes.push(source.slice(cursor, match.index));
    const token = match[0];
    const key = keyPrefix + '-' + index++;
    if (token.startsWith('`')) nodes.push(<code key={key} className="rounded-md bg-black/30 px-1.5 py-0.5 font-mono text-[.9em] text-lime-200 break-words">{token.slice(1, -1)}</code>);
    else if (token.startsWith('**') || token.startsWith('__')) nodes.push(<strong key={key} className="font-semibold text-slate-100">{token.slice(2, -2)}</strong>);
    else if (token.startsWith('*') || token.startsWith('_')) nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    else {
      const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
      if (link) nodes.push(<a key={key} href={link[2]} target="_blank" rel="noopener noreferrer" className="text-lime-300 underline underline-offset-2 break-all">{link[1]}</a>);
      else nodes.push(token);
    }
    cursor = pattern.lastIndex;
  }
  if (cursor < source.length) nodes.push(source.slice(cursor));
  return nodes;
}

export default function MarkdownMessage({ content = '' }) {
  const lines = String(content).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];
  let index = 0;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(<p key={'p-' + index++} className="whitespace-pre-wrap break-words">{renderInline(paragraph.join('\n').trim(), 'p' + index)}</p>);
    paragraph = [];
  };

  while (lines.length) {
    const line = lines.shift();
    const fence = line.match(/^\s*```([\w+-]*)\s*$/);
    if (fence) {
      flushParagraph();
      const code = [];
      while (lines.length && !/^\s*```\s*$/.test(lines[0])) code.push(lines.shift());
      if (lines.length) lines.shift();
      blocks.push(<pre key={'code-' + index++} className="max-w-full overflow-x-auto rounded-xl border border-white/10 bg-[#090d13] p-3 text-xs leading-relaxed text-slate-200"><code className="font-mono whitespace-pre">{code.join('\n')}</code></pre>);
      continue;
    }

    const tableSeparator = lines[0]?.match(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/);
    if (line.includes('|') && tableSeparator) {
      flushParagraph();
      const parseCells = value => value.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
      const headers = parseCells(line);
      lines.shift();
      const rows = [];
      while (lines.length && lines[0].includes('|') && lines[0].trim()) rows.push(parseCells(lines.shift()));
      blocks.push(
        <div key={'table-' + index++} className="max-w-full overflow-x-auto rounded-lg border border-white/10">
          <table className="w-full border-collapse text-left text-xs">
            <thead className="bg-white/[.06]"><tr>{headers.map((cell, cellIndex) => <th key={cellIndex} className="border-b border-white/10 px-3 py-2 font-semibold text-slate-100">{renderInline(cell, 'th' + index + '-' + cellIndex)}</th>)}</tr></thead>
            <tbody>{rows.map((cells, rowIndex) => <tr key={rowIndex} className="even:bg-white/[.025]">{headers.map((_, cellIndex) => <td key={cellIndex} className="border-b border-white/[.06] px-3 py-2 align-top text-slate-300">{renderInline(cells[cellIndex] || '', 'td' + index + '-' + rowIndex + '-' + cellIndex)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
      continue;
    }

    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushParagraph();
      blocks.push(<hr key={'hr-' + index++} className="border-white/10" />);
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      const className = level === 1 ? 'text-lg font-semibold text-slate-100' : level === 2 ? 'text-base font-semibold text-slate-100' : 'text-sm font-semibold text-slate-100';
      blocks.push(React.createElement('h' + level, { key: 'h-' + index++, className }, renderInline(heading[2], 'h' + index)));
      continue;
    }

    const listItem = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
    if (listItem) {
      flushParagraph();
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [listItem[1]];
      while (lines.length) {
        const next = lines[0].match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
        if (!next || /^\s*\d+[.)]\s+/.test(lines[0]) !== ordered) break;
        items.push(next[1]);
        lines.shift();
      }
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(<Tag key={'list-' + index++} className={ordered ? 'list-decimal' : 'list-disc'} style={{ paddingLeft: '1.35rem' }}>{items.map((item, itemIndex) => <li key={itemIndex} className="pl-1">{renderInline(item, 'li' + index + '-' + itemIndex)}</li>)}</Tag>);
      continue;
    }

    const quote = line.match(/^\s*&gt;\s?(.*)$/) || line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      blocks.push(<blockquote key={'q-' + index++} className="border-l-2 border-lime-300/50 pl-3 text-slate-300">{renderInline(quote[1], 'q' + index)}</blockquote>);
      continue;
    }

    if (!line.trim()) flushParagraph();
    else paragraph.push(line);
  }
  flushParagraph();

  return <div className="markdown-content min-w-0 max-w-full space-y-3">{blocks}</div>;
}
