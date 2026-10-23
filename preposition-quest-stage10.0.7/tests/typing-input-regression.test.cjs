const fs = require('fs');
const assert = require('assert');
const game = fs.readFileSync('js/game.js', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
assert.match(game, /document\.addEventListener\("keydown",\s*e\s*=>[\s\S]*?e\.stopImmediatePropagation\(\)[\s\S]*?\},\s*true\)/, 'Typing-field keydown guard must run in capture phase');
assert.match(game, /document\.addEventListener\("keyup",\s*e\s*=>[\s\S]*?e\.stopImmediatePropagation\(\)[\s\S]*?\},\s*true\)/, 'Typing-field keyup guard must run in capture phase');
assert.match(html, /id="typingAnswerInput"[^>]*type="text"/, 'Typing answer input must exist');
console.log('PASS: typing input key-capture regression guard is present.');
