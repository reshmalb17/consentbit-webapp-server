import { promises as fs } from 'fs';
import * as acorn from 'acorn';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node strip-comments.mjs <file...>');
  process.exit(1);
}

for (const file of files) {
  const src = await fs.readFile(file, 'utf8');

  const comments = [];
  try {
    acorn.parse(src, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true,
      allowHashBang: true,
      onComment: (block, text, start, end, startLoc, endLoc) => {
        comments.push({ start, end, startLine: startLoc.line, endLine: endLoc.line });
      },
    });
  } catch (e) {
    console.error(`PARSE FAILED for ${file}: ${e.message}`);
    process.exit(2);
  }

  // Precompute line start offsets (1-indexed lines).
  const lineStart = [0, 0]; // lineStart[1] = 0
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') lineStart.push(i + 1);
  }
  const lineEndOffset = (line) =>
    line + 1 < lineStart.length ? lineStart[line + 1] : src.length; // offset just past the \n (or EOF)

  // Build a set of character indices to delete.
  // Strategy:
  //  - If a comment occupies whole line(s) (only whitespace before it on its first line
  //    and only whitespace after it on its last line), delete those entire lines incl. newline.
  //  - Otherwise (trailing/inline), delete the comment text plus immediately preceding
  //    same-line whitespace.
  const deleteRanges = [];
  for (const c of comments) {
    const firstLineTextStart = lineStart[c.startLine];
    const before = src.slice(firstLineTextStart, c.start);
    const lastLineEnd = lineEndOffset(c.endLine); // includes trailing \n if present
    const afterEndToLineEnd = src.slice(c.end, (c.endLine + 1 < lineStart.length ? lineStart[c.endLine + 1] - 1 : src.length));
    const onlyWsBefore = /^\s*$/.test(before);
    const onlyWsAfter = /^\s*$/.test(afterEndToLineEnd);

    if (onlyWsBefore && onlyWsAfter) {
      // whole-line comment block: remove from start of first line through end of last line (incl newline)
      deleteRanges.push([firstLineTextStart, lastLineEnd]);
    } else {
      // trailing/inline: eat preceding whitespace on the same line too
      let s = c.start;
      while (s > firstLineTextStart && (src[s - 1] === ' ' || src[s - 1] === '\t')) s--;
      deleteRanges.push([s, c.end]);
    }
  }

  // Merge & apply deletions.
  deleteRanges.sort((a, b) => a[0] - b[0]);
  let out = '';
  let cursor = 0;
  for (const [s, e] of deleteRanges) {
    if (s < cursor) { // overlap (nested/adjacent) — extend
      cursor = Math.max(cursor, e);
      continue;
    }
    out += src.slice(cursor, s);
    cursor = e;
  }
  out += src.slice(cursor);

  await fs.writeFile(file, out, 'utf8');
  console.log(`${file}: removed ${comments.length} comments; ${src.length} -> ${out.length} bytes`);
}
