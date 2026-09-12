#!/usr/bin/env node
// Generates syntaxes/target.tmLanguage.json from src/data/builtins.json.
//
// The name lists are derived from the same generated data the language features use,
// so colouring and completion can never disagree about what a builtin is.
//   npm run gen   (runs gen-builtins.mjs then this)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const b = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src/data/builtins.json'), 'utf8'));

/** Longest-first keeps a short name from shadowing a longer one that starts with it. */
const alt = (names) =>
  [...new Set(names)].sort((a, x) => x.length - a.length || a.localeCompare(x)).join('|');

const DEVICE_SECTION = new Set(b.devices.map((d) => d.section).filter(Boolean));

const byCategory = (pred) => b.constants.filter(pred).map((c) => c.name);

const keyboardConsts = byCategory((c) => c.category === 'Virtual keyboard interface');
const dxConsts = byCategory((c) => c.category === 'virtual joystick interface' || c.category === 'virtual mouse interface');
const buttonConsts = byCategory((c) => DEVICE_SECTION.has(c.category));
const flagNames = ['L_SHIFT','R_SHIFT','L_ALT','R_ALT','L_CTL','R_CTL','L_WIN','R_WIN','SHF','ALT','CTL',
  'PULSE','DOWN','UP','PROC','JUMP','DELAY','LOCK','KEYON','RNOSTOP','IOTOGGLE','UDTOGGLE',
  'MODE_EXCLUDED','MODE_KEEPENABLED','MODE_FILTERED','CREATE_JOYSTICK','CREATE_KEYBOARD','CREATE_MOUSE',
  'AXIS_NORMAL','AXIS_REVERSED','MAP_ABSOLUTE','MAP_RELATIVE'];
const flagSet = new Set(flagNames);
const otherConsts = b.constants
  .map((c) => c.name)
  .filter((n) => !flagSet.has(n) && !keyboardConsts.includes(n) && !dxConsts.includes(n) && !buttonConsts.includes(n));

const devices = b.devices.map((d) => d.alias);
// EXEC/REXEC get their own scope: their argument is source code, not an ordinary string.
const execFns = ['EXEC', 'REXEC'];
const publicFns = b.functions.filter((f) => !f.internal).map((f) => f.name).filter((n) => !execFns.includes(n));
const internalFns = b.functions.filter((f) => f.internal && !f.name.startsWith('_')).map((f) => f.name);

const KEYWORDS_CONTROL = ['if', 'else', 'do', 'while', 'return', 'goto', 'break'];
const TYPES = ['char', 'byte', 'short', 'word', 'int', 'float', 'alias', 'struct'];

// Patterns valid inside an EXEC("...") argument. Deliberately not `$self`: the argument
// is a single string literal, so it cannot contain comments or blocks, and its nested
// string literals are backslash-escaped. Modelling that subset directly is more accurate
// than recursing and hoping.
const execBody = [
  { include: '#exec-nested-string' },
  { include: '#builtin-functions' },
  { include: '#devices' },
  { include: '#constants' },
  { include: '#numbers' },
  { include: '#exec-escape' },
  { include: '#operators' },
  { include: '#function-call' },
];

const grammar = {
  $schema: 'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json',
  name: 'TARGET Script',
  scopeName: 'source.target',
  $generated: 'Do not edit by hand - produced by tools/gen-grammar.mjs from src/data/builtins.json',
  fileTypes: ['tmc', 'tmh', 'ttm'],
  patterns: [
    { include: '#comments' },
    { include: '#directives' },
    { include: '#exec-call' },
    { include: '#strings' },
    { include: '#char-literal' },
    { include: '#usb-lookup' },
    { include: '#function-definition' },
    { include: '#device-ref' },
    { include: '#keywords' },
    { include: '#reserved-not-in-target' },
    { include: '#types' },
    { include: '#builtin-functions' },
    { include: '#devices' },
    { include: '#constants' },
    { include: '#numbers' },
    { include: '#operators' },
    { include: '#function-call' },
  ],
  repository: {
    comments: {
      patterns: [
        {
          name: 'comment.block.target',
          begin: '/\\*',
          end: '\\*/',
          beginCaptures: { 0: { name: 'punctuation.definition.comment.begin.target' } },
          endCaptures: { 0: { name: 'punctuation.definition.comment.end.target' } },
        },
        {
          name: 'comment.line.double-slash.target',
          begin: '//',
          end: '$',
          beginCaptures: { 0: { name: 'punctuation.definition.comment.target' } },
        },
      ],
    },

    directives: {
      patterns: [
        {
          // include "target.tmh"  - quotes only, never angle brackets
          name: 'meta.preprocessor.include.target',
          match: '^\\s*(include)\\s+(")([^"]*)(")',
          captures: {
            1: { name: 'keyword.control.directive.include.target' },
            2: { name: 'punctuation.definition.string.begin.target' },
            3: { name: 'string.quoted.double.include.target' },
            4: { name: 'punctuation.definition.string.end.target' },
          },
        },
        {
          // define NAME value   - object-like macros only
          name: 'meta.preprocessor.define.target',
          match: '^\\s*(define)\\s+([A-Za-z_]\\w*)',
          captures: {
            1: { name: 'keyword.control.directive.define.target' },
            2: { name: 'entity.name.constant.preprocessor.target' },
          },
        },
      ],
    },

    // ---- EXEC("...") : TARGET source inside a string literal ----------------
    'exec-call': {
      name: 'meta.function-call.exec.target',
      begin: `\\b(${alt(execFns)})\\s*(\\()`,
      beginCaptures: {
        1: { name: 'support.function.exec.target' },
        2: { name: 'punctuation.section.arguments.begin.target' },
      },
      end: '(\\))',
      endCaptures: { 1: { name: 'punctuation.section.arguments.end.target' } },
      patterns: [
        { include: '#comments' },
        {
          // Adjacent string literals concatenate, so each is matched on its own.
          name: 'meta.embedded.target',
          begin: '"',
          end: '"',
          beginCaptures: { 0: { name: 'punctuation.definition.string.begin.target' } },
          endCaptures: { 0: { name: 'punctuation.definition.string.end.target' } },
          contentName: 'meta.embedded.block.target',
          patterns: execBody,
        },
        { include: '#numbers' },
        { include: '#constants' },
        { include: '#operators' },
        { include: '#function-call' },
      ],
    },
    'exec-nested-string': {
      // \"...\" - a string literal one escape level down
      name: 'string.quoted.double.nested.target',
      begin: '\\\\"',
      end: '\\\\"',
      patterns: [{ match: '\\\\\\\\.', name: 'constant.character.escape.target' }],
    },
    'exec-escape': {
      name: 'constant.character.escape.target',
      match: '\\\\.',
    },

    strings: {
      name: 'string.quoted.double.target',
      begin: '"',
      // End at the closing quote OR at end of line. TARGET has no multi-line string,
      // and without the newline alternative one stray quote colours every line below
      // it as string until the next quote appears. The hand-written lexer already
      // stops at end of line; this keeps the grammar agreeing with it.
      end: '"|(?=$)',
      beginCaptures: { 0: { name: 'punctuation.definition.string.begin.target' } },
      endCaptures: { 0: { name: 'punctuation.definition.string.end.target' } },
      patterns: [{ name: 'constant.character.escape.target', match: '\\\\(x[0-9A-Fa-f]+|[0-7]{1,3}|.)' }],
    },
    'char-literal': {
      name: 'string.quoted.single.target',
      // One OR MORE characters: layer constants are written 'i', 'o', 'iu', 'ium',
      // which the extension's own parameter help documents, and a single-character
      // pattern left the multi-character ones unstyled.
      match: "'(\\\\(x[0-9A-Fa-f]+|[0-7]{1,3}|.)|[^'\\\\])+'",
    },

    'usb-lookup': {
      // USB[0x2C] - the USB scancode table, indexed by hex literal
      name: 'meta.usb-lookup.target',
      match: '\\b(USB)\\s*(\\[)\\s*(0[xX][0-9A-Fa-f]+|\\d+)\\s*(\\])',
      captures: {
        1: { name: 'support.constant.usb.target' },
        2: { name: 'punctuation.section.brackets.begin.target' },
        3: { name: 'constant.numeric.hex.usb.target' },
        4: { name: 'punctuation.section.brackets.end.target' },
      },
    },

    'function-definition': {
      // `int name(...)` defines a function; `int name;` declares a variable that an
      // event construct is later assigned to. Only the former is matched here.
      match: `^\\s*(${alt(TYPES)})\\s+([A-Za-z_]\\w*)\\s*(?=\\()`,
      captures: {
        1: { name: 'storage.type.target' },
        2: { name: 'entity.name.function.target' },
      },
    },

    'device-ref': {
      // &Joystick - how a device is passed to the mapping functions
      match: `(&)\\s*\\b(${alt(devices)})\\b`,
      captures: {
        1: { name: 'keyword.operator.address-of.target' },
        2: { name: 'support.class.device.target' },
      },
    },

    keywords: {
      name: 'keyword.control.target',
      match: `\\b(${alt(KEYWORDS_CONTROL)})\\b`,
    },
    'reserved-not-in-target': {
      // TARGET has no for / switch / continue. Colouring them as ordinary identifiers
      // would hide the mistake; diagnostics explain it.
      name: 'invalid.illegal.keyword-not-in-target.target',
      // sizeof is deliberately absent: sys.tmh declares `int sizeof(alias var)`, so it
      // is a real builtin here, and both NOT_IN_TARGET and the diagnostics treat it as
      // valid. Listing it made the grammar contradict the extension's own data.
      match: '\\b(for|switch|case|continue|typedef|enum|const|static|unsigned|signed)\\b(?=\\s*[\\(\\{\\s;])',
    },
    types: {
      name: 'storage.type.target',
      match: `\\b(${alt(TYPES)})\\b`,
    },

    'builtin-functions': {
      patterns: [
        { name: 'support.function.exec.target', match: `\\b(${alt(execFns)})\\b(?=\\s*\\()` },
        { name: 'support.function.target', match: `\\b(${alt(publicFns)})\\b(?=\\s*\\()` },
        { name: 'support.function.internal.target', match: `\\b(${alt(internalFns)})\\b(?=\\s*\\()` },
        // Composition helpers read as calls even when nested bare.
        { name: 'support.function.target', match: `\\b(${alt(publicFns)})\\b` },
      ],
    },

    devices: {
      name: 'support.class.device.target',
      match: `\\b(${alt(devices)})\\b`,
    },

    constants: {
      patterns: [
        { name: 'support.constant.flag.target', match: `\\b(${alt(flagNames)})\\b` },
        { name: 'support.constant.button.target', match: `\\b(${alt(buttonConsts)})\\b` },
        { name: 'support.constant.directx.target', match: `\\b(${alt(dxConsts)})\\b` },
        { name: 'support.constant.keyboard.target', match: `\\b(${alt(keyboardConsts)})\\b` },
        { name: 'support.constant.target', match: `\\b(${alt(otherConsts)})\\b` },
      ],
    },

    numbers: {
      patterns: [
        { name: 'constant.numeric.hex.target', match: '\\b0[xX][0-9A-Fa-f]+\\b' },
        { name: 'constant.numeric.float.target', match: '\\b\\d+\\.\\d*([eE][-+]?\\d+)?\\b|\\b\\d+\\.(?!\\w)' },
        { name: 'constant.numeric.integer.target', match: '\\b\\d+\\b' },
      ],
    },

    operators: {
      patterns: [
        { name: 'keyword.operator.logical.target', match: '&&|\\|\\||!(?!=)' },
        { name: 'keyword.operator.comparison.target', match: '==|!=|<=|>=|<(?![<])|>(?![>])' },
        { name: 'keyword.operator.bitwise.target', match: '>>|<<|&|\\||\\^|~' },
        { name: 'keyword.operator.arithmetic.target', match: '\\+|-|\\*|/|%' },
        { name: 'keyword.operator.assignment.target', match: '=' },
      ],
    },

    'function-call': {
      match: '\\b([A-Za-z_]\\w*)\\s*(?=\\()',
      captures: { 1: { name: 'entity.name.function.call.target' } },
    },

  },
};

const outPath = path.join(repoRoot, 'syntaxes', 'target.tmLanguage.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(grammar, null, 2));
console.log(`Wrote ${path.relative(repoRoot, outPath)}`);
console.log(`  builtin functions : ${publicFns.length} public + ${internalFns.length} internal + ${execFns.length} exec`);
console.log(`  devices           : ${devices.length}`);
console.log(`  constants         : flags ${flagNames.length}, buttons ${buttonConsts.length}, dx ${dxConsts.length}, keyboard ${keyboardConsts.length}, other ${otherConsts.length}`);
