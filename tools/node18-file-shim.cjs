// vsce pulls in undici, which assumes the global `File` that Node 20 added. This repo
// targets Node 18 (see @types/node), where packaging otherwise dies with
// "ReferenceError: File is not defined" before doing any work. Preloaded by the
// package script; harmless on Node 20+, where the global already exists.
if (typeof globalThis.File === 'undefined') {
  const { Blob } = require('buffer');
  class File extends Blob {
    constructor(chunks, name, options = {}) {
      super(chunks, options);
      this.name = String(name);
      this.lastModified = options.lastModified ?? Date.now();
    }
    get [Symbol.toStringTag]() {
      return 'File';
    }
  }
  globalThis.File = File;
}
