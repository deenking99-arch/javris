import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SentenceChunker, speakable } from '../server/voice/sentences.js';
import { ConversationStateMachine, S } from '../server/core/stateMachine.js';
import { validateInput } from '../server/tools/registry.js';

test('SentenceChunker: liefert Sätze sofort, respektiert Abkürzungen und Datumsangaben', () => {
  const out = [];
  const c = new SentenceChunker((s) => out.push(s));
  for (const part of ['Guten Abend. Du hast ', 'heute z.B. zwei Termine, am 3. Mai ', 'ist Deadline! Noch ', 'etwas?']) c.push(part);
  assert.deepEqual(out, ['Guten Abend.', 'Du hast heute z.B. zwei Termine, am 3. Mai ist Deadline!']);
  c.flush();
  assert.equal(out.at(-1), 'Noch etwas?');
});

test('speakable: entfernt Markdown, Links und Emojis', () => {
  assert.equal(speakable('**Wichtig:** siehe [Doku](https://x.y) 🚀 und `code`'), 'Wichtig: siehe Doku und code');
  assert.equal(speakable('- Punkt eins\n- Punkt zwei'), 'Punkt eins Punkt zwei');
});

test('State-Machine: erlaubte und verbotene Übergänge', () => {
  const sm = new ConversationStateMachine();
  assert.ok(sm.transition(S.LISTENING));
  assert.ok(sm.transition(S.PROCESSING));
  assert.ok(sm.transition(S.EXECUTING));
  assert.ok(sm.transition(S.SPEAKING));
  assert.ok(sm.transition(S.INTERRUPTED));
  assert.ok(sm.transition(S.LISTENING));
  assert.ok(sm.transition(S.ERROR));
  assert.ok(!sm.transition(S.SPEAKING), 'Error → Speaking ist nicht erlaubt');
  assert.ok(sm.transition(S.IDLE));
  assert.ok(!sm.transition(S.INTERRUPTED), 'Idle → Interrupted ist nicht erlaubt');
});

test('validateInput: prüft Pflichtfelder, Typen und Enums', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' }, p: { type: 'string', enum: ['x', 'y'] }, n: { type: 'integer' } }, required: ['a'] };
  assert.equal(validateInput(schema, { a: 'ok' }), null);
  assert.match(validateInput(schema, {}), /Pflichtfeld/);
  assert.match(validateInput(schema, { a: 1 }), /falschen Typ/);
  assert.match(validateInput(schema, { a: 'x', p: 'z' }), /einer von/);
  assert.match(validateInput(schema, { a: 'x', n: 1.5 }), /falschen Typ/);
});
