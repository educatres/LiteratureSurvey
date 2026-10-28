import test from 'node:test';
import assert from 'node:assert/strict';
import { listModels, generateText, buildAnalysisPrompt } from '../ai.mjs';

test('Google models are paginated, filtered for text generation, and authenticated via headers', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(calls.length === 1 ? { models: [{ name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embed', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'next' } : { models: [{ name: 'models/gemini-b', supportedGenerationMethods: ['generateContent'] }] }));
  };
  const models = await listModels('google', 'secret');
  assert.deepEqual(models.map(m => m.id), ['gemini-a', 'gemini-b']);
  assert.equal(calls[0].options.headers['x-goog-api-key'], 'secret');
  assert.ok(!calls[0].url.includes('secret'));
  assert.ok(calls[1].url.includes('pageToken=next'));
});

test('providers use their own generation routes and extract returned text', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    const result = String(url).includes('generateContent') ? { candidates: [{ content: { parts: [{ text: 'google' }] } }] } : String(url).endsWith('/responses') ? { output: [{ content: [{ text: 'responses' }] }] } : { choices: [{ message: { content: 'chat' } }] };
    return new Response(JSON.stringify(result));
  };
  assert.equal(await generateText({ provider: 'openai', key: 'k', model: 'm', prompt: 'p' }), 'responses');
  assert.equal(await generateText({ provider: 'cgu', key: 'k', model: 'gpt-oss-120b', prompt: 'p' }), 'chat');
  assert.equal(await generateText({ provider: 'xai', key: 'k', model: 'grok', prompt: 'p' }), 'chat');
  assert.equal(await generateText({ provider: 'google', key: 'k', model: 'gemini', prompt: 'p' }), 'google');
  assert.equal(calls[0].body.store, false);
  assert.equal(calls[1].url, 'https://air.cgu.edu.tw/cgullmapi/v1/chat/completions');
  assert.equal(calls[2].url, 'https://api.x.ai/v1/chat/completions');
  assert.equal(calls[3].options.headers['x-goog-api-key'], 'k');
});

test('analysis explicitly identifies missing abstracts and keeps PMID in the provided context', () => {
  const prompt = buildAnalysisPrompt({ query: 'asthma', papers: [{ pmid: '123', title: 'Example', year: '2024', journal: 'J', abstract: '' }], conversation: [], question: '整理' });
  assert.match(prompt, /123/);
  assert.match(prompt, /無可用摘要/);
  assert.match(prompt, /不能推測研究結果/);
});

test('API errors include status and cancellation remains distinguishable', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401 });
  await assert.rejects(listModels('cgu', 'key'), /401.*invalid key/);
  globalThis.fetch = async () => { throw new DOMException('cancel', 'AbortError'); };
  await assert.rejects(listModels('cgu', 'key'), { name: 'AbortError' });
});
