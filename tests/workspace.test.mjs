import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWorkspace, decodeWorkspace, encodeProjectIndex, decodeProjectIndex } from '../workspace.mjs';

test('workspace restores result pages, cursors, selections, abstracts, conversation and draft', () => {
  const paper = { pmid: '123', pmcid: 'PMC123', doi: '', title: 'Study', journal: 'Journal', date: '', year: '2025', authors: [], type: [] };
  const snapshot = { baseQuery: 'cancer', filters: {}, sort: 'relevance', query: '(cancer)', page: 1, total: 21,
    items: [paper], source: 'europepmc', cursors: new Map([[0, '*'], [1, 'next']]),
    pages: { 0: { items: [paper], total: 21, source: 'europepmc' } } };
  const original = { rounds: [{ id: 0, label: '初始對話', parent: null, snapshot }, { id: 1, label: '搜尋', parent: 0, snapshot: null }],
    activeRoundId: 0, nextRoundId: 2, selected: new Map([['123', paper]]), abstracts: new Map([['123', 'Abstract']]),
    abstractAssists: new Map([['123', { translation: '中文翻譯', summary: 'AI 摘要' }]]),
    conversation: [{ roundId: 0, role: 'assistant', content: 'Answer', searchQuery: 'cancer' }], fields: { query: 'draft' } };
  const restored = decodeWorkspace(encodeWorkspace(original));
  assert.equal(restored.rounds[0].snapshot.cursors.get(1), 'next');
  assert.equal(restored.rounds[0].snapshot.pages[0].items[0].pmid, '123');
  assert.equal(restored.selected.get('123').title, 'Study');
  assert.equal(restored.abstracts.get('123'), 'Abstract');
  assert.deepEqual(restored.abstractAssists.get('123'), { translation: '中文翻譯', summary: 'AI 摘要' });
  assert.equal(restored.conversation[0].searchQuery, 'cancer');
  assert.equal(restored.fields.query, 'draft');
});

test('corrupt or unsafe stored data is rejected instead of partially restored', () => {
  assert.throws(() => decodeWorkspace('{'));
  assert.throws(() => decodeWorkspace(JSON.stringify({ version: 1, rounds: [{ id: 0, label: 'x', parent: null, snapshot: null }],
    activeRoundId: 0, nextRoundId: 1, selected: [['123', { pmid: '123" onclick="alert(1)' }]], abstracts: [], conversation: [], fields: {} })));
  assert.throws(() => decodeWorkspace(JSON.stringify({ version: 1, rounds: [{ id: 0, label: 'x', parent: null, snapshot: null }],
    activeRoundId: 0, nextRoundId: 1, selected: [], abstracts: [], abstractAssists: [['123', { translation: 1, summary: '' }]], conversation: [], fields: {} })));
});

test('project index preserves named projects and rejects unsafe entries', () => {
  const original = { activeProjectId: 'project-one', projects: [
    { id: 'project-one', name: '論文整理', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' }
  ] };
  assert.deepEqual(decodeProjectIndex(encodeProjectIndex(original)), { version: 1, ...original });
  assert.throws(() => decodeProjectIndex(JSON.stringify({ version: 1, activeProjectId: 'project-one', projects: [
    { id: 'bad-id', name: 'Unsafe id', createdAt: '', updatedAt: '' }
  ] })));
});
