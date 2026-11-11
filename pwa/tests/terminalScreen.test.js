import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalScreen } from '../src/lib/terminalScreen.js';

test('terminal screen handles carriage-return redraws and backspace editing', () => {
  const screen = new TerminalScreen(40);
  screen.write('prompt $ npm\b\b\b\b\bnode\r\nprompt $ node\r\n');
  assert.equal(screen.toString(), 'prompt $ node\nprompt $ node');
});

test('terminal screen interprets ANSI clear-line and cursor movement sequences', () => {
  const screen = new TerminalScreen(20);
  screen.write('downloading 10%');
  screen.write('\r\u001b[2Kdownloading 100%\u001b[0m');
  assert.equal(screen.toString(), 'downloading 100%');
});

test('terminal screen preserves partial escape sequences between PTY chunks', () => {
  const screen = new TerminalScreen(20);
  screen.write('hello\u001b[');
  screen.write('2Kworld');
  assert.equal(screen.toString(), 'world');
});

test('terminal screen wraps long prompts at the configured PTY width', () => {
  const screen = new TerminalScreen(8);
  screen.write('abcdefghijk');
  assert.equal(screen.toString(), 'abcdefgh\nijk');
});

test('terminal screen bounds retained scrollback', () => {
  const screen = new TerminalScreen(20, 3);
  screen.write('one\ntwo\nthree\nfour');
  assert.equal(screen.toString(), 'two\nthree\nfour');
});
