// A TextDocument good enough for the providers: offsets, positions, word ranges.
const path = require('path');
const vscode = require('./vscode-stub.cjs');

class FakeDocument {
  constructor(filePath, text) {
    this.fileName = filePath;
    this.uri = vscode.Uri.file(filePath);
    this.languageId = 'target';
    this.version = 1;
    this._text = text;
    this._lines = text.split('\n');
    this._lineStarts = [0];
    for (let i = 0; i < this._lines.length; i++) {
      this._lineStarts.push(this._lineStarts[i] + this._lines[i].length + 1);
    }
  }
  getText(range) {
    // The real API slices when given a range; the providers rely on that to read the
    // word under the cursor.
    if (!range) return this._text;
    return this._text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
  }
  lineAt(posOrLine) {
    const line = typeof posOrLine === 'number' ? posOrLine : posOrLine.line;
    return { text: this._lines[line] ?? '', lineNumber: line };
  }
  offsetAt(pos) { return (this._lineStarts[pos.line] ?? 0) + pos.character; }
  positionAt(offset) {
    let line = 0;
    while (line + 1 < this._lineStarts.length && this._lineStarts[line + 1] <= offset) line++;
    return new vscode.Position(line, offset - this._lineStarts[line]);
  }
  getWordRangeAtPosition(pos, re) {
    const text = this._lines[pos.line] ?? '';
    const rx = new RegExp(re.source, 'g');
    let m;
    while ((m = rx.exec(text)) !== null) {
      if (m.index <= pos.character && pos.character <= m.index + m[0].length) {
        return new vscode.Range(new vscode.Position(pos.line, m.index), new vscode.Position(pos.line, m.index + m[0].length));
      }
    }
    return undefined;
  }
  /** Position of the marker `|` in the source, which is removed from the text. */
  static withCursor(filePath, textWithBar) {
    const idx = textWithBar.indexOf('|');
    const text = textWithBar.replace('|', '');
    const doc = new FakeDocument(filePath, text);
    return { doc, pos: doc.positionAt(idx) };
  }
}
module.exports = { FakeDocument };
