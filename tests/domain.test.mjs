import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPubmedQuery, normalizeSummary, metadataCsv, fileStem, chunks } from '../domain.mjs';
import { makeZip, crc32 } from '../zip.mjs';

test('PubMed filter composition respects explicit fields and OA subset', () => {
  assert.equal(buildPubmedQuery('asthma', { from: '2020', to: '2025', articleType: 'review[pt]', openAccess: true }),
    '(asthma) AND 2020:2025[dp] AND review[pt] AND pubmed pmc open access[filter]');
  assert.equal(buildPubmedQuery('cancer AND CRISPR'), '(cancer AND CRISPR)');
  assert.throws(() => buildPubmedQuery(' '), /關鍵字/);
  assert.throws(() => buildPubmedQuery('asthma', { from: '2030', to: '2020' }), /起始年份/);
});

test('normalize NCBI summary and handle identifiers', () => {
  const doc = normalizeSummary({ uid: '123', title: 'Test', pubdate: '2025 Jan', fulljournalname: 'J', articleids: [{ idtype: 'pmc', value: 'PMC123' }, { idtype: 'doi', value: '10.4/a' }], authors: [{ name: 'Lee' }], attributes: ['Has Abstract'] });
  assert.equal(doc.pmcid, 'PMC123');
  assert.equal(doc.year, '2025');
  assert.equal(doc.doi, '10.4/a');
  assert.equal(doc.hasAbstract, true);
  assert.deepEqual(doc.authors, ['Lee']);
});

test('CSV escapes formula injection, quotes, and preserves UTF-8', () => {
  const csv = metadataCsv([{ pmid: '123', pmcid: '', doi: '', title: '=1+1', authors: ['Dr. "X"'], journal: '中文期刊', year: '2025', date: '2025' }]);
  assert.ok(csv.startsWith('\ufeff'));
  assert.ok(csv.includes('"\'=1+1"'));
  assert.ok(csv.includes('"Dr. ""X"""'));
  assert.ok(csv.includes('中文期刊'));
  assert.ok(!fileStem({ pmid: '42', title: 'Bad / Name: ?' }).includes('/'));
  assert.deepEqual(chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('ZIP writer has valid local, central, and end records', async () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const zip = new Uint8Array(await makeZip([{ name: '中文.txt', content: 'hello 世界' }, { name: 'metadata.csv', content: 'x,y\r\n' }]).arrayBuffer());
  const view = new DataView(zip.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint16(6, true), 0x0800); // UTF-8 flag
  assert.equal(view.getUint32(zip.length - 22, true), 0x06054b50);
  assert.equal(view.getUint16(zip.length - 12, true), 2);
  const centralOffset = view.getUint32(zip.length - 6, true);
  assert.equal(view.getUint32(centralOffset, true), 0x02014b50);
});
