// Loads .env from the project folder (wherever the server is started from)
// and explains what's wrong when no token is found. Tolerates the usual
// Windows/Mac editor mistakes: UTF-16 files, BOMs, .env.txt, a bare token.
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const ROOT = path.join(__dirname, '..');

function decode(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  return buf.toString('utf8').replace(/^﻿/, '');
}

function loadEnv(root = ROOT) {
  const candidates = ['.env', '.env.txt', '.env.rtf'];
  const found = candidates.find((f) => fs.existsSync(path.join(root, f)));
  if (!found) {
    if (!process.env.META_ACCESS_TOKEN) return `No .env file in ${root}. Create it with one line: META_ACCESS_TOKEN=your-token`;
    return null;
  }
  const text = decode(fs.readFileSync(path.join(root, found)));
  if (found === '.env.rtf' || /^\{\\rtf/.test(text)) {
    return `${found} was saved as rich text. Recreate it as plain text (see README).`;
  }
  const parsed = dotenv.parse(text);
  // A file holding only the token, without "META_ACCESS_TOKEN=" in front.
  if (!parsed.META_ACCESS_TOKEN) {
    const bare = text.split(/\r?\n/).map((l) => l.trim().replace(/^["']|["']$/g, '')).find((l) => /^EAA[A-Za-z0-9]{20,}$/.test(l));
    if (bare) parsed.META_ACCESS_TOKEN = bare;
  }
  for (const [k, v] of Object.entries(parsed)) if (!process.env[k]) process.env[k] = v.trim();
  if (!process.env.META_ACCESS_TOKEN) return `${found} was found but has no META_ACCESS_TOKEN=... line.`;
  return null;
}

module.exports = { loadEnv };
