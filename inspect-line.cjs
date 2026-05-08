const {readFileSync} = require('fs');
const s = readFileSync('src/handlers/cdn.js','utf8').replace(/\r\n/g,'\n');
const lines = s.split('\n');
const line = lines[667]; // line 668 (0-indexed)
// Search for backslash followed by 'u'
const bsCode = 92; // '\'
const uCode  = 117; // 'u'
let found = [];
for (let i = 0; i < line.length - 1; i++) {
  if (line.charCodeAt(i) === bsCode && line.charCodeAt(i+1) === uCode) {
    found.push({ col: i+1, after: line.slice(i, i+8) });
    if (found.length >= 10) break;
  }
}
console.log('backslash-u occurrences:', JSON.stringify(found, null, 2));
