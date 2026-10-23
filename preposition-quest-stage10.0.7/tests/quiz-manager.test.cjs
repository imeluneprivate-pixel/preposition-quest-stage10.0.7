const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'quiz-manager.js'), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(source, sandbox, { filename: 'quiz-manager.js' });
const q = sandbox.window.PrepositionQuizManager;
assert.ok(q, 'Quiz Manager is exposed');
assert.deepEqual(Array.from(q.supportedModes), ['multiple-choice','picture-sentence','drag-drop','typing','speaking']);
assert.equal(q.normalizeAnswer(' IN-FRONT-OF! '), 'in front of');
assert.equal(q.validateChoice('OVER', { correct: 'over' }), true);
assert.equal(q.validateTypedAnswer('The character goes through the tunnel.', { correct: 'through', acceptedAnswers: ['the character goes through the tunnel'] }), true);
assert.equal(q.validateTypedAnswer('   ', { correct: 'over' }), false);
assert.deepEqual([0,1,2,3].map(q.calculatePoints), [3,2,1,0]);
assert.deepEqual([0,3,4,5,6,7].map(q.worldForQuestion), ['FOREST TRAIL','FOREST TRAIL','MYSTERY CAVE','MYSTERY CAVE','SKY TEMPLE','SKY TEMPLE']);
for (const mode of q.supportedModes) {
  assert.equal(q.getMode({ mode }), mode);
}
assert.equal(q.getMode({ mode: 'unknown' }), 'multiple-choice');
console.log('PASS: Quiz Manager unit checks');
