export class TerminalScreen {
  constructor(columns = 80, maxLines = 4000) {
    this.columns = Math.max(2, Math.min(400, Number(columns) || 80));
    this.maxLines = maxLines;
    this.reset();
  }

  reset() {
    this.lines = [[]];
    this.row = 0;
    this.column = 0;
    this.savedCursor = { row: 0, column: 0 };
    this.state = 'normal';
    this.sequence = '';
    this.wrapPending = false;
  }

  resize(columns) {
    this.columns = Math.max(2, Math.min(400, Number(columns) || 80));
    this.wrapPending = false;
    this.column = Math.min(this.column, this.columns - 1);
  }

  line() {
    while (this.lines.length <= this.row) this.lines.push([]);
    return this.lines[this.row];
  }

  ensureRow(row) {
    while (this.lines.length <= row) this.lines.push([]);
  }

  move(row, column) {
    this.row = Math.max(0, Math.min(this.maxLines - 1, row));
    this.column = Math.max(0, Math.min(this.columns - 1, column));
    this.ensureRow(this.row);
    this.wrapPending = false;
  }

  newline() {
    this.row += 1;
    this.ensureRow(this.row);
    this.wrapPending = false;
    if (this.lines.length > this.maxLines) {
      const excess = this.lines.length - this.maxLines;
      this.lines.splice(0, excess);
      this.row = Math.max(0, this.row - excess);
    }
  }

  put(character) {
    if (this.wrapPending) {
      this.newline();
      this.column = 0;
    }
    const line = this.line();
    while (line.length < this.column) line.push(' ');
    line[this.column] = character;
    if (this.column === this.columns - 1) this.wrapPending = true;
    else this.column += 1;
  }

  eraseLine(mode) {
    const line = this.line();
    if (mode === 0) line.splice(this.column);
    else if (mode === 1) {
      for (let index = 0; index <= this.column; index += 1) line[index] = ' ';
    } else if (mode === 2) line.length = 0;
    this.wrapPending = false;
  }

  eraseDisplay(mode) {
    if (mode === 2 || mode === 3) {
      this.lines = [[]];
      this.row = 0;
      this.column = 0;
      this.wrapPending = false;
      return;
    }
    if (mode === 0) {
      this.eraseLine(0);
      this.lines.splice(this.row + 1);
    } else if (mode === 1) {
      this.lines.splice(0, this.row);
      this.row = 0;
      this.eraseLine(1);
    }
  }

  executeCsi(final) {
    const privateMode = this.sequence.startsWith('?');
    const raw = privateMode ? this.sequence.slice(1) : this.sequence;
    const values = raw.split(';').map(value => value === '' ? 0 : Number.parseInt(value, 10));
    const first = values[0] || 0;
    const amount = Math.max(1, first);
    switch (final) {
      case 'A': this.move(this.row - amount, this.column); break;
      case 'B': this.move(this.row + amount, this.column); break;
      case 'C': this.move(this.row, this.column + amount); break;
      case 'D': this.move(this.row, this.column - amount); break;
      case 'E': this.move(this.row + amount, 0); break;
      case 'F': this.move(this.row - amount, 0); break;
      case 'G': case '`': this.move(this.row, Math.max(0, first - 1)); break;
      case 'd': this.move(Math.max(0, first - 1), this.column); break;
      case 'H': case 'f': this.move(Math.max(0, (values[0] || 1) - 1), Math.max(0, (values[1] || 1) - 1)); break;
      case 'J': this.eraseDisplay(first); break;
      case 'K': this.eraseLine(first); break;
      case 'X': {
        const line = this.line();
        for (let index = this.column; index < Math.min(this.columns, this.column + amount); index += 1) line[index] = ' ';
        break;
      }
      case '@': {
        const line = this.line();
        for (let index = 0; index < amount; index += 1) line.splice(this.column, 0, ' ');
        line.length = Math.min(line.length, this.columns);
        break;
      }
      case 'P': this.line().splice(this.column, amount); break;
      case 's': this.savedCursor = { row: this.row, column: this.column }; break;
      case 'u': this.move(this.savedCursor.row, this.savedCursor.column); break;
      case 'm': case 'h': case 'l': case 'r': case 'S': case 'T': break;
      default: break;
    }
    this.sequence = '';
  }

  write(input) {
    for (const character of String(input ?? '')) {
      const code = character.codePointAt(0);
      if (this.state === 'osc') {
        if (character === '\u0007') this.state = 'normal';
        else if (character === '\u001b') this.state = 'osc-escape';
        continue;
      }
      if (this.state === 'osc-escape') {
        this.state = character === '\\' ? 'normal' : 'osc';
        continue;
      }
      if (this.state === 'escape') {
        if (character === '[') { this.state = 'csi'; this.sequence = ''; }
        else if (character === ']') this.state = 'osc';
        else {
          if (character === '7') this.savedCursor = { row: this.row, column: this.column };
          else if (character === '8') this.move(this.savedCursor.row, this.savedCursor.column);
          else if (character === 'D') this.newline();
          else if (character === 'E') { this.newline(); this.column = 0; }
          else if (character === 'M') this.move(Math.max(0, this.row - 1), this.column);
          this.state = 'normal';
        }
        continue;
      }
      if (this.state === 'csi') {
        if (code >= 0x40 && code <= 0x7e) {
          this.executeCsi(character);
          this.state = 'normal';
        } else if (this.sequence.length < 128) this.sequence += character;
        continue;
      }
      if (character === '\u001b') { this.state = 'escape'; continue; }
      if (character === '\r') { this.column = 0; this.wrapPending = false; continue; }
      if (character === '\n') { this.newline(); continue; }
      if (character === '\b' || code === 0x7f) { this.column = Math.max(0, this.column - 1); this.wrapPending = false; continue; }
      if (character === '\t') {
        const next = Math.min(this.columns - 1, (Math.floor(this.column / 8) + 1) * 8);
        while (this.column < next) this.put(' ');
        continue;
      }
      if (code < 0x20 || code === 0x7f) continue;
      this.put(character);
    }
    return this.toString();
  }

  toString() {
    return this.lines.map(line => line.join('').replace(/\s+$/u, '')).join('\n');
  }
}
