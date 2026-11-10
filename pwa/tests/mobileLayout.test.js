import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [app, styles, html] = await Promise.all([
  readFile(new URL('../src/App.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/index.css', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8')
]);

test('mobile viewport uses dynamic height and safe-area-aware document sizing', () => {
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /interactive-widget=resizes-content/);
  assert.match(styles, /#root\s*\{\s*min-height:\s*100dvh/);
  assert.match(styles, /body\s*\{[^}]*min-height:\s*100dvh/);
  assert.match(styles, /\.safe-bottom\s*\{\s*padding-bottom:\s*calc\(env\(safe-area-inset-bottom\)\s*\+\s*8px\)/);
});

test('chat reserves space for the fixed composer and bottom navigation', () => {
  assert.match(app, /pb-\[calc\(11rem\+env\(safe-area-inset-bottom\)\)\]/);
  assert.match(app, /fixed bottom-0 left-0 right-0 z-40/);
  assert.match(app, /<nav className="glass border-t[^"]*safe-bottom/);
});

test('mobile composer has a touch-sized target and a screen-reader label', () => {
  assert.match(app, /aria-label="Message your local model"/);
  assert.match(app, /enterKeyHint="send"/);
  assert.match(app, /min-h-\[44px\] max-h-32 overflow-y-auto/);
  assert.match(app, /!e\.nativeEvent\.isComposing/);
  assert.match(app, /w-11 h-11 rounded-xl bg-lime-300 text-slate-950 grid place-items-center/);
  assert.match(app, /w-11 h-11 rounded-xl bg-red-400 text-slate-950 grid place-items-center/);
  assert.match(app, /min-h-11 flex items-center gap-1\.5 text-sm rounded-xl/);
  assert.match(app, /useEffect\(\(\)=>\{bottomRef\.current\?\.scrollIntoView\(\{behavior:'smooth'\}\);\},\[messages,busy\]\)/);
  assert.match(app, /min-h-11 flex flex-col items-center justify-center gap-1 py-2 rounded-xl transition/);
});

test('chat messages constrain width and wrap long unbroken content', () => {
  assert.match(app, /max-w-\[calc\(100%_-_2\.75rem\)\] sm:max-w-\[86%\]/);
  assert.match(app, /whitespace-pre-wrap break-words/);
});
