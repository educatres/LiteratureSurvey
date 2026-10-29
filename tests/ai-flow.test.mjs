import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('a suggested search analyzes the new results, not previously selected papers', async () => {
  class Element {
    constructor() { this.children = []; this.listeners = {}; this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false; this.className = ''; this.classList = { toggle() {} }; }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    dispatch(type, event = {}) { return this.listeners[type]?.({ preventDefault() {}, target: this, ...event }); }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    setAttribute() {}
    querySelector() { return this.span ||= new Element(); }
    focus() {}
    showModal() { this.open = true; }
    close() { this.open = false; this.dispatch('close'); }
  }
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const elements = Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  elements['sort-by'].value = 'relevance';
  const allChildren = root => root.children.flatMap(child => [child, ...allChildren(child)]);
  globalThis.document = {
    getElementById: id => elements[id],
    createElement: () => new Element(),
    querySelectorAll: selector => selector === '.ai-search-button' ? allChildren(elements['ai-conversation']).filter(element => element.className.includes('ai-search-button')) : []
  };
  globalThis.Option = class extends Element { constructor(label, value) { super(); this.textContent = label; this.value = value; } };
  globalThis.window = { confirm: () => true, prompt: () => '自訂搜尋分頁' };
  globalThis.localStorage = { getItem: key => key === 'litfetch.ai.settings.v1' ? JSON.stringify({ provider: 'openai', services: { openai: { key: 'test-key', model: 'text-model' } } }) : null, setItem() {} };
  globalThis.DOMParser = class {
    parseFromString(text) {
      const pmid = text.match(/abstract-(\d+)/)?.[1];
      const record = { querySelector: () => ({ textContent: pmid }), querySelectorAll: () => [{ textContent: `abstract text ${pmid}`, getAttribute: () => null }] };
      return { querySelector: () => null, querySelectorAll: () => pmid ? [record] : [] };
    }
  };
  const prompts = [];
  let failedSearch = false;
  let blockSearch = false;
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'api.openai.com') {
      prompts.push(JSON.parse(options.body).input);
      const text = prompts.length === 1 ? '這個方向可以檢索。\n<pubmed_search>new_topic</pubmed_search>' : '整理新文獻，接著請問研究對象？\n<pubmed_search>fail_topic</pubmed_search>';
      return new Response(JSON.stringify({ output: [{ content: [{ text }] }] }));
    }
    if (parsed.pathname.endsWith('esearch.fcgi')) {
      if (parsed.searchParams.get('term').includes('fail_topic')) {
        if (blockSearch) return await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('cancel', 'AbortError')), { once: true }));
        failedSearch = true;
        return new Response('{}', { status: 503 });
      }
      const isNew = parsed.searchParams.get('term').includes('new_topic');
      const id = isNew ? (parsed.searchParams.get('retstart') === '20' ? '333' : '222') : '111';
      return new Response(JSON.stringify({ esearchresult: { count: isNew ? '21' : '1', idlist: [id] } }));
    }
    if (parsed.pathname.endsWith('esummary.fcgi')) {
      const id = parsed.searchParams.get('id');
      return new Response(JSON.stringify({ result: { [id]: { uid: id, title: `Paper ${id}`, authors: [], articleids: [] } } }));
    }
    if (parsed.pathname.endsWith('efetch.fcgi')) return new Response(`abstract-${parsed.searchParams.get('id')}`);
    if (parsed.hostname === 'www.ebi.ac.uk' && failedSearch) return new Response('{}', { status: 503 });
    throw new Error(`Unexpected request: ${url}`);
  };
  const waitFor = async condition => {
    for (let i = 0; i < 300; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error('Timed out waiting for UI state');
  };
  await import('../app.js');
  elements['ai-example-organize'].dispatch('click');
  assert.match(elements['ai-status'].textContent, /請先.*勾選文獻/);
  assert.equal(prompts.length, 0);
  elements.query.value = 'old_topic';
  elements['search-form'].dispatch('submit');
  await waitFor(() => elements['results-notice'].textContent.includes('顯示第'));
  elements['results-list'].dispatch('change', { target: { matches: () => true, dataset: { pmid: '111' }, checked: true } });
  elements['ai-question'].value = '請協助尋找相關文獻';
  elements['ai-form'].dispatch('submit');
  await waitFor(() => document.querySelectorAll('.ai-search-button').length === 1 && !elements['ai-send'].disabled);
  const button = document.querySelectorAll('.ai-search-button')[0];
  button.dispatch('click');
  await waitFor(() => prompts.length === 2 && !elements['ai-send'].disabled);
  const newRecords = prompts[1].split('文獻資料（JSON）：')[1].split('\n先前對話')[0];
  assert.match(newRecords, /"pmid":"222"/);
  assert.match(newRecords, /abstract text 222/);
  assert.doesNotMatch(newRecords, /"pmid":"111"/);
  assert.match(prompts[1], /只分析目前這一頁/);
  assert.equal(elements.query.value, 'new_topic');
  elements['next-page'].dispatch('click');
  await waitFor(() => elements['results-list'].innerHTML.includes('PMID 333'));
  const resultTabs = elements['results-round-tabs'].children;
  assert.equal(resultTabs.length, 3, 'each successful search gets its own tab');
  resultTabs[1].children[1].dispatch('click', { stopPropagation() {} });
  assert.equal(elements['results-round-tabs'].children[1].children[0].children[0].textContent, '自訂搜尋分頁');
  assert.match(elements['results-list'].innerHTML, /PMID 333/);
  resultTabs[1].dispatch('click');
  assert.match(elements['results-list'].innerHTML, /PMID 111/);
  assert.equal(elements.query.value, 'old_topic');
  assert.match(elements['ai-conversation'].children[1].children[1].textContent, /可以檢索/);
  assert.match(elements['ai-conversation'].children[3].children[1].textContent, /整理新文獻/);
  assert.equal(elements['ai-round-tabs'], undefined, 'the AI workspace uses one conversation without tabs');
  resultTabs[2].dispatch('click');
  assert.match(elements['results-list'].innerHTML, /PMID 333/);
  assert.equal(elements.query.value, 'new_topic');
  assert.match(elements['ai-conversation'].children[3].children[1].textContent, /整理新文獻/);
  elements['ai-example-organize'].dispatch('click');
  await waitFor(() => prompts.length === 3 && !elements['ai-send'].disabled);
  const selectedRecords = prompts[2].split('文獻資料（JSON）：')[1].split('\n先前對話')[0];
  assert.match(selectedRecords, /"pmid":"111"/);
  assert.match(selectedRecords, /abstract text 111/);
  assert.doesNotMatch(selectedRecords, /"pmid":"333"/, 'example must use the basket even in an AI search tab');
  const failButton = document.querySelectorAll('.ai-search-button').at(-1);
  failButton.dispatch('click');
  await waitFor(() => elements['ai-status'].textContent.includes('分析失敗') && !elements['ai-send'].disabled);
  assert.equal(prompts.length, 3, 'failed searches must not invoke AI on stale results');
  assert.match(elements['results-list'].innerHTML, /PMID 333/, 'failed search must preserve the previous round');
  blockSearch = true;
  failButton.dispatch('click');
  await waitFor(() => elements['ai-send'].disabled);
  elements['ai-cancel'].dispatch('click');
  await waitFor(() => elements['ai-status'].textContent.includes('已取消') && !elements['ai-send'].disabled);
  assert.equal(prompts.length, 3, 'cancelled searches must not invoke AI');
  elements['ai-clear-conversation'].dispatch('click');
  assert.equal(elements['ai-conversation'].children.length, 1);
  assert.match(elements['ai-conversation'].children[0].textContent, /選取文獻後開始整理/);
  assert.equal(elements['ai-download'].disabled, true);
  assert.equal(elements['results-round-tabs'].children.length, 3, 'clearing the conversation keeps search history');
  elements['ai-analyze'].dispatch('click');
  await waitFor(() => prompts.length === 4 && !elements['ai-send'].disabled);
  assert.equal(elements['ai-conversation'].children.length, 1, 'the preset analysis question is not rendered as a user message');
  assert.match(elements['ai-conversation'].children[0].className, /ai-assistant/);
  elements['results-list'].dispatch('click', { target: { closest: () => ({ dataset: { preview: '333' } }) } });
  assert.equal(elements['abstract-dialog'].open, true);
  await waitFor(() => elements['abstract-body'].textContent.includes('abstract text 333'));
  assert.match(elements['abstract-body'].textContent, /abstract text 333/);
  assert.match(elements['results-list'].innerHTML, /paper-abstract-badge/);
  assert.match(elements['results-list'].innerHTML, /abstract text 333/);
  elements['abstract-translate'].dispatch('click');
  await waitFor(() => prompts.length === 5 && !elements['abstract-translate'].disabled);
  assert.match(prompts[4], /完整翻譯成繁體中文/);
  assert.equal(elements['abstract-translation-panel'].hidden, false);
  assert.match(elements['abstract-translation'].textContent, /整理新文獻/);
  assert.match(elements['results-list'].innerHTML, /paper-translation-badge/);
  assert.match(elements['results-list'].innerHTML, /paper-ai-tooltip/);
  assert.match(elements['results-list'].innerHTML, /整理新文獻/);
  elements['abstract-summarize'].dispatch('click');
  await waitFor(() => prompts.length === 6 && !elements['abstract-summarize'].disabled);
  assert.match(prompts[5], /研究目的／方法／主要結果／結論/);
  assert.equal(elements['abstract-summary-panel'].hidden, false);
  assert.match(elements['results-list'].innerHTML, /paper-summary-badge/);
  assert.match(elements['results-list'].innerHTML, /查看已保存的 AI 摘要/);
  elements['close-abstract-bottom'].dispatch('click');
  elements['abstract-translation'].textContent = ''; elements['abstract-summary'].textContent = '';
  elements['results-list'].dispatch('click', { target: { closest: () => ({ dataset: { preview: '333' } }) } });
  assert.equal(elements['abstract-translation-panel'].hidden, false, 'saved translation is restored when the preview reopens');
  assert.equal(elements['abstract-summary-panel'].hidden, false, 'saved AI summary is restored when the preview reopens');
  assert.match(elements['abstract-translation'].textContent, /整理新文獻/);
});
