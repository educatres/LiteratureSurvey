import { makeZip } from './zip.mjs';
import { renderMarkdown } from './markdown.mjs';
import { PAGE_SIZE, MAX_EXPORT, buildPubmedQuery, normalizeSummary, metadataCsv, fileStem, chunks } from './domain.mjs';
import { PROVIDERS, listModels, generateText, buildAnalysisPrompt, extractSearchSuggestion } from './ai.mjs?v=20261029-4';

const NCBI = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest';
const MAX_ZIP_CONTENT = 120 * 1024 * 1024;
const $ = id => document.getElementById(id);
const state = {
  page: 0, total: 0, items: [], selected: new Map(), lastQuery: '',
  abstractCache: new Map(), searchAbort: null, exportAbort: null,
  isSearching: false, isExporting: false, lastNcbiRequestAt: 0,
  searchSource: 'ncbi', epmcCursors: new Map([[0, '*']])
};
const rounds = [{ id: 0, label: '初始對話', parent: null, snapshot: null }];
let activeRoundId = 0;
let nextRoundId = 1;
let ncbiQueue = Promise.resolve();

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
function status(message, isError = false) {
  $('results-notice').textContent = message;
  $('results-notice').classList.toggle('error', isError);
}
function apiConfig() {
  return { key: $('api-key').value.trim(), email: $('contact-email').value.trim() };
}
function abortError() { return new DOMException('Request cancelled', 'AbortError'); }
function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    function stop() { clearTimeout(timer); reject(abortError()); }
    signal?.addEventListener('abort', stop, { once: true });
  });
}

async function ncbiRequestOnce(path, params, signal) {
  const { key, email } = apiConfig();
  const interval = key ? 180 : 420; // Respect NCBI's default 10 / 3 requests per second limits.
  const wait = Math.max(0, interval - (Date.now() - state.lastNcbiRequestAt));
  if (wait > 0) await sleep(wait, signal);
  if (signal?.aborted) throw abortError();
  state.lastNcbiRequestAt = Date.now();
  const url = new URL(`${NCBI}/${path}`);
  for (const [keyName, value] of Object.entries(params)) url.searchParams.set(keyName, String(value));
  url.searchParams.set('tool', 'litfetch_pubmed_batch');
  if (key) url.searchParams.set('api_key', key);
  if (email) url.searchParams.set('email', email);
  const response = await fetch(url.toString(), { signal, credentials: 'omit' });
  if (!response.ok) throw new Error(`PubMed API HTTP ${response.status}。請稍後再試。`);
  const text = await response.text();
  if (text.startsWith('{"error"')) throw new Error('PubMed API 拒絕查詢，請確認 API Key 或搜尋語法。');
  return text;
}

function ncbiRequest(path, params, signal) {
  // Serialize all PubMed calls, including user-triggered abstract previews.
  // Otherwise simultaneous requests could defeat the API's per-second limit.
  const pending = ncbiQueue.then(() => ncbiRequestOnce(path, params, signal));
  ncbiQueue = pending.catch(() => {});
  return pending;
}

async function searchIds(query, offset, max, sort, signal) {
  const raw = await ncbiRequest('esearch.fcgi', {
    db: 'pubmed', term: query, retmode: 'json', retstart: offset, retmax: max, sort
  }, signal);
  const json = JSON.parse(raw);
  if (json.error || json.esearchresult?.ERROR || json.esearchresult?.errorlist?.phrasesnotfound?.length)
    throw new Error(json.error || json.esearchresult?.ERROR || 'PubMed 無法解析部分搜尋詞，請調整語法。');
  if (!json.esearchresult) throw new Error('PubMed 回傳的格式不正確。');
  return { total: Number(json.esearchresult.count) || 0, ids: json.esearchresult.idlist || [] };
}

async function getSummaries(ids, signal) {
  if (!ids.length) return [];
  const raw = await ncbiRequest('esummary.fcgi', { db: 'pubmed', id: ids.join(','), retmode: 'json' }, signal);
  const json = JSON.parse(raw);
  if (json.error || !json.result) throw new Error(json.error || '無法取得 PubMed 文獻資料。');
  return ids.map(id => json.result[id]).filter(Boolean).map(normalizeSummary);
}

function currentFilters() {
  return { from: $('year-from').value, to: $('year-to').value, articleType: $('article-type').value, openAccess: $('open-access').checked };
}

function textFromHtml(html) {
  const withBreaks = String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:h[1-6]|p|div|li)>/gi, '\n\n');
  const parsed = new DOMParser().parseFromString(withBreaks, 'text/html');
  return (parsed.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

async function europePmcSearch(query, signal, overrides = {}) {
  const params = new URLSearchParams({
    query, format: 'json', resultType: 'core', pageSize: String(overrides.pageSize || PAGE_SIZE),
    cursorMark: overrides.cursorMark || '*'
  });
  const response = await fetch(`${EPMC}/search?${params}`, { signal, credentials: 'omit' });
  if (!response.ok) throw new Error(`Europe PMC API HTTP ${response.status}`);
  const data = await response.json();
  if (!data.resultList || !Array.isArray(data.resultList.result)) throw new Error('Europe PMC 回傳資料格式不正確。');
  return data;
}

function europePmcQuery(base, options = {}) {
  const clauses = ['SRC:MED', `(${base})`];
  const { from, to, articleType, openAccess, sort } = options;
  if (from || to) clauses.push(`FIRST_PDATE:[${from || '1800'}-01-01 TO ${to || new Date().getFullYear()}-12-31]`);
  if (openAccess) clauses.push('OPEN_ACCESS:Y');
  const types = {
    'review[pt]': 'PUB_TYPE:Review',
    'systematic review[pt]': 'PUB_TYPE:"Systematic Review"',
    'meta-analysis[pt]': 'PUB_TYPE:"Meta-Analysis"',
    'clinical trial[pt]': 'PUB_TYPE:"Clinical Trial"',
    'randomized controlled trial[pt]': 'PUB_TYPE:"Randomized Controlled Trial"'
  };
  if (types[articleType]) clauses.push(types[articleType]);
  return clauses.join(' AND ') + (sort === 'pub date' ? ' sort_date:y' : '');
}

function normalizeEuropePmc(r) {
  const pmid = String(r.pmid || (r.source === 'MED' ? r.id : '') || '');
  if (!/^\d+$/.test(pmid)) return null;
  const types = r.pubTypeList?.pubType || [];
  const authors = (r.authorList?.author || []).map(a => a.fullName || a.lastName).filter(Boolean);
  const pmcid = /^PMC\d+$/i.test(r.pmcid || '') ? r.pmcid.toUpperCase() : '';
  return {
    pmid, pmcid, doi: r.doi || '', title: textFromHtml(r.title || '未提供標題'),
    journal: r.journalTitle || r.journalInfo?.journal?.title || '未提供期刊',
    date: r.firstPublicationDate || r.firstIndexDate || r.pubYear || '',
    year: r.pubYear || '', authors: authors.length ? authors : (r.authorString || '').split(/,\s*/).filter(Boolean),
    type: Array.isArray(types) ? types : [], hasAbstract: Boolean(r.abstractText),
    abstract: textFromHtml(r.abstractText || '')
  };
}

async function performSearch(resetPage = true, externalSignal) {
  let query;
  const baseQuery = $('query').value.trim();
  const filters = currentFilters();
  const sort = $('sort-by').value;
  try { query = buildPubmedQuery(baseQuery, filters); }
  catch (error) { status(error.message, true); $('query').focus(); if (externalSignal) throw error; return; }
  if (externalSignal?.aborted) throw abortError();
  if (state.searchAbort) state.searchAbort.abort();
  const controller = new AbortController();
  const cancelSearch = () => controller.abort();
  externalSignal?.addEventListener('abort', cancelSearch, { once: true });
  state.searchAbort = controller;
  if (resetPage || query !== state.lastQuery) {
    state.page = 0;
    state.epmcCursors = new Map([[0, '*']]);
  }
  state.lastQuery = query;
  state.isSearching = true;
  $('search-button').disabled = true;
  $('search-button').querySelector('span').textContent = '搜尋中…';
  $('results-list').innerHTML = '<div class="loading-shimmer"></div><div class="loading-shimmer"></div><div class="loading-shimmer"></div>';
  $('pagination').hidden = true;
  status('正在搜尋 PubMed 官方資料庫…');
  try {
    let response;
    let papers;
    let source = 'ncbi';
    try {
      response = await searchIds(query, state.page * PAGE_SIZE, PAGE_SIZE, sort, controller.signal);
      papers = await getSummaries(response.ids, controller.signal);
    } catch (primaryError) {
      if (controller.signal.aborted || primaryError.name === 'AbortError') throw primaryError;
      try {
        const cursorMark = state.epmcCursors.get(state.page);
        if (!cursorMark) throw new Error('無法取得此頁的備援搜尋游標，請重新搜尋。');
        const fallback = await europePmcSearch(europePmcQuery(baseQuery, { ...filters, sort }), controller.signal, { cursorMark });
        if (fallback.nextCursorMark) state.epmcCursors.set(state.page + 1, fallback.nextCursorMark);
        response = { total: fallback.hitCount || 0 };
        papers = fallback.resultList.result.map(normalizeEuropePmc).filter(Boolean);
        source = 'europepmc';
      } catch (fallbackError) {
        if (controller.signal.aborted || fallbackError.name === 'AbortError') throw fallbackError;
        throw new Error(`NCBI 與 Europe PMC 都無法連線（${fallbackError.message}）。可能是瀏覽器擴充功能、網路防火牆或跨站連線限制；請嘗試其他瀏覽器或網路。`);
      }
    }
    if (controller.signal.aborted) throw abortError();
    state.total = response.total;
    state.items = papers;
    state.searchSource = source;
    for (const p of papers) if (typeof p.abstract === 'string') state.abstractCache.set(p.pmid, p.abstract);
    renderResults();
    status(`顯示第 ${response.total ? state.page * PAGE_SIZE + 1 : 0}–${Math.min((state.page + 1) * PAGE_SIZE, response.total)} 篇；可跨頁挑選文獻。${source === 'europepmc' ? '目前使用 Europe PMC 備援搜尋（PubMed 收錄文獻）；進階 PubMed 語法可能有差異。' : ''}`);
    return { papers: [...papers], total: response.total, query, source, baseQuery, filters, sort };
  } catch (error) {
    if (externalSignal && (error.name === 'AbortError' || controller.signal.aborted)) throw abortError();
    if (error.name !== 'AbortError' && !controller.signal.aborted) {
      $('results-list').innerHTML = '<div class="empty-state"><h3>搜尋失敗</h3><p>請稍後再試，或調整 PubMed 查詢條件。</p></div>';
      status(error.message || '無法連接 PubMed。', true);
    }
    if (externalSignal) throw error;
  } finally {
    externalSignal?.removeEventListener('abort', cancelSearch);
    if (state.searchAbort === controller) {
      state.isSearching = false;
      state.searchAbort = null;
      $('search-button').disabled = false;
      $('search-button').querySelector('span').textContent = '搜尋文獻';
    }
  }
}

function renderResults() {
  $('result-count').textContent = state.total ? state.total.toLocaleString('en-US') + ' 篇' : '0 篇';
  const list = $('results-list');
  if (!state.items.length) {
    list.innerHTML = '<div class="empty-state"><h3>沒有符合的文獻</h3><p>試著放寬年份、文章類型或開放取用限制。</p></div>';
  } else {
    list.innerHTML = state.items.map((p, index) => {
      const selected = state.selected.has(p.pmid);
      const authors = p.authors.slice(0, 4).join(', ') + (p.authors.length > 4 ? ' et al.' : '');
      const articleType = p.type.find(x => /review|trial|meta-analysis/i.test(x)) || '';
      return `<article class="paper-card${selected ? ' is-selected' : ''}">
        <input type="checkbox" class="paper-checkbox" aria-label="選取 ${escapeHtml(p.title)}" data-pmid="${p.pmid}" ${selected ? 'checked' : ''}>
        <div class="paper-main"><div class="paper-top"><span class="paper-number">PAPER ${String(state.page * PAGE_SIZE + index + 1).padStart(3, '0')}</span><div class="paper-pills">${p.pmcid ? '<span class="pill pmc">PMC 收錄</span>' : ''}${articleType ? `<span class="pill type">${escapeHtml(articleType)}</span>` : ''}</div></div>
        <h3 class="paper-title">${escapeHtml(p.title)}</h3><p class="paper-authors">${escapeHtml(authors || '未提供作者')}</p><div class="paper-publication"><span>${escapeHtml(p.journal)}</span><span>${escapeHtml(p.date || p.year)}</span><span>PMID ${p.pmid}</span></div>
        <div class="paper-footer"><button type="button" data-preview="${p.pmid}">查看摘要 ↗</button><a href="https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/" target="_blank" rel="noopener noreferrer">PubMed ↗</a>${p.pmcid ? `<a href="https://pmc.ncbi.nlm.nih.gov/articles/${p.pmcid}/" target="_blank" rel="noopener noreferrer">PMC 全文頁 ↗</a>` : ''}${p.doi ? `<a class="doi" href="https://doi.org/${encodeURIComponent(p.doi)}" target="_blank" rel="noopener noreferrer">DOI ↗</a>` : ''}</div></div></article>`;
    }).join('');
  }
  $('pagination').hidden = state.total <= PAGE_SIZE;
  $('page-label').textContent = `第 ${state.page + 1} / ${Math.ceil(state.total / PAGE_SIZE) || 1} 頁`;
  $('prev-page').disabled = state.page === 0;
  $('next-page').disabled = (state.page + 1) * PAGE_SIZE >= state.total;
  $('select-page').disabled = state.items.length === 0 || state.isExporting;
  updateBasket();
}

function updateBasket() {
  const papers = [...state.selected.values()];
  const size = papers.length;
  $('basket-count').textContent = size;
  $('selected-count').textContent = `${size} 篇`;
  $('clear-selection').disabled = size === 0 || state.isExporting;
  $('download-abstracts').disabled = size === 0 || state.isExporting;
  $('download-fulltext').disabled = size === 0 || state.isExporting;
  $('basket-items').innerHTML = size ? papers.map((p, i) => `<div class="basket-item"><span class="basket-item-index">${String(i + 1).padStart(2, '0')}</span><div><div class="basket-item-title" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</div><div class="basket-item-meta">${escapeHtml(p.year)} · PMID ${p.pmid}</div></div><button class="basket-item-remove" data-remove="${p.pmid}" title="移除文獻" aria-label="移除 ${escapeHtml(p.title)}">×</button></div>`).join('') : '<p class="basket-empty">尚未選取文獻。<br>點選搜尋結果旁的方框加入清單。</p>';
  if (state.items.length) $('select-page').textContent = state.items.every(p => state.selected.has(p.pmid)) ? '取消全選此頁' : '全選此頁';
  updateAiScope();
}

function togglePaper(pmid, checked) {
  if (state.isExporting) return;
  if (checked) {
    const paper = state.items.find(p => p.pmid === pmid);
    if (!paper) return;
    if (!state.selected.has(pmid) && state.selected.size >= MAX_EXPORT) {
      status(`最多一次選取 ${MAX_EXPORT} 篇文獻，請先下載或移除部分文獻。`, true);
      renderResults();
      return;
    }
    state.selected.set(pmid, paper);
  } else state.selected.delete(pmid);
  for (const cb of document.querySelectorAll(`.paper-checkbox[data-pmid="${pmid}"]`)) {
    cb.checked = checked;
    cb.closest('.paper-card')?.classList.toggle('is-selected', checked);
  }
  updateBasket();
}

function parseXml(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('API 回傳的 XML 格式無法解析。');
  return doc;
}

function parsePubmedAbstracts(xmlText) {
  const xml = parseXml(xmlText);
  const map = new Map();
  for (const record of xml.querySelectorAll('PubmedArticle')) {
    const pmid = record.querySelector('MedlineCitation > PMID')?.textContent?.trim();
    if (!pmid) continue;
    const fragments = [...record.querySelectorAll('MedlineCitation > Article > Abstract > AbstractText')].map(n => {
      const label = n.getAttribute('Label') || n.getAttribute('NlmCategory');
      return `${label && label !== 'UNASSIGNED' ? label + ': ' : ''}${n.textContent.trim()}`;
    }).filter(Boolean);
    map.set(pmid, fragments.join('\n\n'));
  }
  return map;
}

async function getAbstracts(ids, signal) {
  try {
    const xml = await ncbiRequest('efetch.fcgi', { db: 'pubmed', id: ids.join(','), retmode: 'xml' }, signal);
    return parsePubmedAbstracts(xml);
  } catch (error) {
    if (signal?.aborted || error.name === 'AbortError') throw error;
    const pmids = ids.filter(id => /^\d+$/.test(id));
    const query = `SRC:MED AND (${pmids.map(id => `EXT_ID:${id}`).join(' OR ')})`;
    const result = await europePmcSearch(query, signal, { pageSize: pmids.length });
    return new Map(result.resultList.result.map(r => [String(r.pmid || r.id), textFromHtml(r.abstractText || '')]));
  }
}

async function showAbstract(pmid) {
  const p = state.items.find(item => item.pmid === pmid) || state.selected.get(pmid);
  if (!p) return;
  $('abstract-title').textContent = p.title;
  $('abstract-meta').textContent = `${p.authors.slice(0, 4).join(', ')} · ${p.journal} · ${p.date} · PMID ${p.pmid}`;
  $('abstract-body').textContent = '正在讀取摘要…';
  $('abstract-pubmed-link').href = `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`;
  $('abstract-dialog').showModal();
  if (state.abstractCache.has(pmid)) { $('abstract-body').textContent = state.abstractCache.get(pmid) || '此篇沒有可用的摘要。'; return; }
  try {
    const fetched = await getAbstracts([pmid]);
    const text = fetched.get(pmid) || '';
    state.abstractCache.set(pmid, text);
    if ($('abstract-dialog').open && $('abstract-pubmed-link').href.includes(`/${pmid}/`)) $('abstract-body').textContent = text || '此篇沒有可用的摘要。';
  } catch (error) { if ($('abstract-dialog').open) $('abstract-body').textContent = `無法讀取摘要：${error.message}`; }
}

function openProgress(mode) {
  $('progress-title').textContent = mode === 'abstracts' ? '正在整理摘要…' : '正在取得開放全文…';
  $('progress-description').textContent = '準備下載中…';
  $('download-progress').value = 0;
  $('progress-dialog').showModal();
}
function progress(done, total, message) {
  $('download-progress').value = Math.round((done / Math.max(total, 1)) * 100);
  $('progress-description').textContent = `${message}（${done} / ${total}）`;
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  const retry = $('retry-download');
  retry.href = url;
  retry.download = name;
  retry.hidden = false;
  setTimeout(() => {
    if (retry.getAttribute('href') === url) {
      retry.hidden = true;
      retry.removeAttribute('href');
    }
    URL.revokeObjectURL(url);
  }, 120_000);
}
function selectedFilesBase(papers) { return [{ name: 'metadata.csv', content: metadataCsv(papers) }]; }

async function exportAbstracts(papers, signal) {
  const files = selectedFilesBase(papers);
  const missing = [];
  let done = 0;
  for (const group of chunks(papers, 40)) {
    const abstracts = await getAbstracts(group.map(p => p.pmid), signal);
    for (const p of group) {
      const abstract = abstracts.get(p.pmid) || '';
      if (!abstract) missing.push(p.pmid);
      state.abstractCache.set(p.pmid, abstract);
      files.push({ name: `abstracts/${fileStem(p)}.txt`, content: [p.title, '', `Authors: ${p.authors.join(', ')}`, `Journal: ${p.journal}`, `Published: ${p.date}`, `PMID: ${p.pmid}`, `PMCID: ${p.pmcid || 'N/A'}`, `DOI: ${p.doi || 'N/A'}`, `PubMed: https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`, '', 'ABSTRACT', abstract || '[No abstract available in PubMed]', ''].join('\n') });
      done++;
    }
    progress(done, papers.length, '擷取摘要');
  }
  files.push({ name: 'download_report.txt', content: `Downloaded metadata and abstract records: ${papers.length}\nNo abstract text provided for PMID: ${missing.join(', ') || 'none'}\nSource: NCBI PubMed E-utilities\nPlease respect the copyright of each abstract.\n` });
  return files;
}

async function getOpenAccessIds(papers, signal) {
  const eligible = new Set();
  for (const group of chunks(papers, 40)) {
    const term = `(${group.map(p => `${p.pmid}[uid]`).join(' OR ')}) AND pubmed pmc open access[filter]`;
    try {
      const result = await searchIds(term, 0, group.length, 'relevance', signal);
      result.ids.forEach(id => eligible.add(String(id)));
    } catch (error) {
      if (signal.aborted || error.name === 'AbortError') throw error;
      const query = `SRC:MED AND OPEN_ACCESS:Y AND (${group.map(p => `EXT_ID:${p.pmid}`).join(' OR ')})`;
      const result = await europePmcSearch(query, signal, { pageSize: group.length });
      result.resultList.result.filter(p => p.isOpenAccess === 'Y' && p.pmcid).forEach(p => eligible.add(String(p.pmid || p.id)));
    }
  }
  return eligible;
}

async function exportFulltexts(papers, signal) {
  const files = selectedFilesBase(papers);
  progress(0, papers.length, '確認 PMC 開放取用資格');
  const eligible = await getOpenAccessIds(papers, signal);
  const skipped = [];
  let done = 0;
  let totalBytes = 0;
  let downloaded = 0;
  for (const p of papers) {
    if (signal.aborted) throw abortError();
    if (!eligible.has(p.pmid)) skipped.push(`${p.pmid}: Not in PMC Open Access Subset`);
    else if (!p.pmcid) skipped.push(`${p.pmid}: PMCID is unavailable`);
    else {
      try {
        const url = `${EPMC}/${encodeURIComponent(p.pmcid)}/fullTextXML`;
        const response = await fetch(url, { signal, credentials: 'omit' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const xml = await response.text();
        const doc = parseXml(xml);
        if (doc.documentElement?.localName !== 'article') throw new Error('Full text is not available');
        const size = new TextEncoder().encode(xml).length;
        totalBytes += size;
        if (totalBytes > MAX_ZIP_CONTENT) throw new Error('ZIP 超過 120 MB，請減少勾選數量');
        files.push({ name: `fulltext/${p.pmcid}.xml`, content: xml });
        downloaded++;
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        if (totalBytes > MAX_ZIP_CONTENT) throw error;
        skipped.push(`${p.pmid}: ${error.message}`);
      }
      // Keep calls to the independent Europe PMC service comfortably paced.
      await sleep(220, signal);
    }
    done++;
    progress(done, papers.length, '取得全文 XML');
  }
  files.push({ name: 'download_report.txt', content: `PMC Open Access full-text XML downloaded: ${downloaded} / ${papers.length}\n\nSkipped records:\n${skipped.join('\n') || 'none'}\n\nThe XML contains each article's license statement. Check the license before redistribution or reuse.\nSources: NCBI PubMed / PMC Open Access, Europe PMC fullTextXML API.\n` });
  return { files, downloaded, skipped: skipped.length };
}

async function startExport(mode) {
  if (state.isExporting || !state.selected.size) return;
  const papers = [...state.selected.values()];
  const controller = new AbortController();
  state.exportAbort = controller;
  state.isExporting = true;
  updateBasket();
  $('select-page').disabled = true;
  openProgress(mode);
  try {
    const output = mode === 'abstracts' ? { files: await exportAbstracts(papers, controller.signal), downloaded: papers.length } : await exportFulltexts(papers, controller.signal);
    if (controller.signal.aborted) return;
    progress(papers.length, papers.length, '建立 ZIP 檔案');
    const name = `pubmed_${mode}_${new Date().toISOString().slice(0, 10)}.zip`;
    downloadBlob(makeZip(output.files), name);
    status(`已產生 ${name}（${output.downloaded} 篇${mode === 'fulltext' ? `全文、${output.skipped} 篇略過` : '摘要'}）。請查看 ZIP 內的下載報告。`);
  } catch (error) {
    if (error.name !== 'AbortError') status(`匯出失敗：${error.message}`, true);
    else status('已取消下載。');
  } finally {
    $('progress-dialog').close();
    state.isExporting = false;
    state.exportAbort = null;
    $('select-page').disabled = !state.items.length;
    updateBasket();
  }
}

$('search-form').addEventListener('submit', event => { event.preventDefault(); manualSearch(); });
$('apply-filters').addEventListener('click', () => manualSearch());
$('reset-filters').addEventListener('click', () => {
  $('year-from').value = ''; $('year-to').value = ''; $('article-type').value = '';
  $('sort-by').value = 'relevance'; $('open-access').checked = false;
  if ($('query').value.trim()) manualSearch();
});
document.querySelectorAll('.example-query').forEach(button => button.addEventListener('click', () => {
  $('query').value = button.dataset.query;
  manualSearch();
}));
$('results-list').addEventListener('change', event => {
  if (event.target.matches('.paper-checkbox')) togglePaper(event.target.dataset.pmid, event.target.checked);
});
$('results-list').addEventListener('click', event => {
  const button = event.target.closest('[data-preview]');
  if (button) showAbstract(button.dataset.preview);
});
$('basket-items').addEventListener('click', event => {
  const button = event.target.closest('[data-remove]');
  if (button) togglePaper(button.dataset.remove, false);
});
$('select-page').addEventListener('click', () => {
  const allSelected = state.items.every(p => state.selected.has(p.pmid));
  for (const p of state.items) togglePaper(p.pmid, !allSelected);
});
$('clear-selection').addEventListener('click', () => { state.selected.clear(); renderResults(); });
$('prev-page').addEventListener('click', () => { if (state.page > 0) changeResultPage(state.page - 1); });
$('next-page').addEventListener('click', () => { if ((state.page + 1) * PAGE_SIZE < state.total) changeResultPage(state.page + 1); });
$('download-abstracts').addEventListener('click', () => startExport('abstracts'));
$('download-fulltext').addEventListener('click', () => startExport('fulltext'));
$('cancel-download').addEventListener('click', () => state.exportAbort?.abort());
$('progress-dialog').addEventListener('cancel', event => { event.preventDefault(); state.exportAbort?.abort(); });
for (const id of ['close-abstract', 'close-abstract-bottom']) $(id).addEventListener('click', () => $('abstract-dialog').close());

// Provider credentials are explicitly saved per provider in this browser only.
const AI_STORAGE = 'litfetch.ai.settings.v1';
let aiSettings = { provider: 'cgu', services: {} };
try {
  const saved = JSON.parse(localStorage.getItem(AI_STORAGE) || '{}');
  if (saved && typeof saved === 'object') aiSettings = { provider: PROVIDERS[saved.provider] ? saved.provider : 'cgu', services: saved.services && typeof saved.services === 'object' ? saved.services : {} };
} catch { /* Storage may be blocked; settings can still be used in memory. */ }
let aiConversation = [];
let aiAbort = null;
let aiTestAbort = null;

function activeRound() { return rounds.find(round => round.id === activeRoundId); }
function saveRoundResults(round, result) {
  round.snapshot = { baseQuery: result.baseQuery, filters: { ...result.filters }, sort: result.sort,
    query: result.query, page: state.page, total: state.total, items: [...state.items],
    source: state.searchSource, cursors: new Map(state.epmcCursors) };
}
function restoreRound(round) {
  const snapshot = round.snapshot;
  if (snapshot) {
    $('query').value = snapshot.baseQuery;
    $('year-from').value = snapshot.filters.from; $('year-to').value = snapshot.filters.to;
    $('article-type').value = snapshot.filters.articleType; $('open-access').checked = snapshot.filters.openAccess;
    $('sort-by').value = snapshot.sort;
    state.page = snapshot.page; state.total = snapshot.total; state.items = [...snapshot.items];
    state.lastQuery = snapshot.query; state.searchSource = snapshot.source; state.epmcCursors = new Map(snapshot.cursors);
    renderResults();
    status(`${round.label}：顯示第 ${snapshot.total ? snapshot.page * PAGE_SIZE + 1 : 0}–${Math.min((snapshot.page + 1) * PAGE_SIZE, snapshot.total)} 篇。${snapshot.source === 'europepmc' ? '目前使用 Europe PMC 備援搜尋。' : ''}`);
  } else {
    $('query').value = '';
    state.page = 0; state.total = 0; state.items = []; state.lastQuery = '';
    state.epmcCursors = new Map([[0, '*']]);
    renderResults();
    status(`${round.label}尚未搜尋文獻。`);
  }
}
function roundContext(round) {
  const lineage = [];
  for (let node = round; node; node = rounds.find(item => item.id === node.parent)) lineage.unshift(node.id);
  return aiConversation.filter(message => lineage.includes(message.roundId)).map(({ role, content, searchQuery }) => ({ role, content, ...(searchQuery ? { searchQuery } : {}) }));
}
function addRound(label, parent = activeRoundId) {
  const round = { id: nextRoundId++, label, parent, snapshot: null };
  rounds.push(round); activeRoundId = round.id;
  return round;
}
function renderRoundTabs() {
  for (const id of ['results-round-tabs', 'ai-round-tabs']) {
    const container = $(id); container.replaceChildren();
    for (const round of rounds) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'round-tab';
      button.textContent = round.label; button.title = round.label; button.setAttribute('aria-pressed', String(round.id === activeRoundId));
      button.disabled = Boolean(aiAbort || state.isSearching);
      button.addEventListener('click', () => {
        if (aiAbort || state.isSearching || round.id === activeRoundId) return;
        activeRoundId = round.id; restoreRound(round); renderRoundTabs(); renderAiConversation(); aiMessage('');
      });
      container.append(button);
    }
  }
}
async function manualSearch() {
  if (aiAbort || state.isSearching) return;
  const previous = activeRound();
  const pending = performSearch(true); renderRoundTabs();
  const result = await pending;
  if (result) {
    const round = addRound(`搜尋 ${nextRoundId} · ${result.baseQuery}`);
    saveRoundResults(round, result); renderRoundTabs(); renderAiConversation(); updateAiScope();
  } else { const notice = $('results-notice').textContent; restoreRound(previous); status(notice, true); renderRoundTabs(); }
}
async function changeResultPage(page) {
  if (aiAbort || state.isSearching || !activeRound().snapshot) return;
  const round = activeRound();
  restoreRound(round); state.page = page;
  const pending = performSearch(false); renderRoundTabs();
  const result = await pending;
  if (result) saveRoundResults(round, result);
  else { const notice = $('results-notice').textContent; restoreRound(round); status(notice, true); }
  renderRoundTabs();
}

function aiMessage(message, error = false) {
  $('ai-status').textContent = message;
  $('ai-status').classList.toggle('error', error);
}
function aiSettingsMessage(message, error = false) {
  $('ai-settings-status').textContent = message;
  $('ai-settings-status').classList.toggle('error', error);
}
function saveAiSettings() {
  try { localStorage.setItem(AI_STORAGE, JSON.stringify(aiSettings)); return true; }
  catch { return false; }
}
function currentAiConfig() {
  return { provider: $('ai-provider').value, key: $('ai-key').value.trim(), model: $('ai-model').value.trim() };
}
function loadAiProvider() {
  const saved = aiSettings.services[$('ai-provider').value] || {};
  $('ai-key').value = typeof saved.key === 'string' ? saved.key : '';
  $('ai-model').value = typeof saved.model === 'string' ? saved.model : '';
  $('ai-model-list').replaceChildren(new Option('請先讀取模型', ''));
  aiSettingsMessage('');
}
function updateAiScope() {
  const useSelected = state.selected.size > 0;
  const count = useSelected ? state.selected.size : state.items.length;
  $('ai-scope').textContent = count ? `分析範圍：${useSelected ? '已選取文獻' : '目前分頁的搜尋結果這一頁'} ${count} 篇；送出前會取得可用摘要。` : '尚無文獻：可先描述研究方向，AI 會協助擬定搜尋條件。';
}
function renderAiConversation() {
  const container = $('ai-conversation');
  container.replaceChildren();
  const messages = aiConversation.filter(message => message.roundId === activeRoundId);
  if (!messages.length) {
    const empty = document.createElement('p'); empty.className = 'ai-empty'; empty.textContent = '選取文獻後開始整理，也可以直接輸入研究問題。'; container.append(empty);
  }
  for (const message of messages) {
    const item = document.createElement('div'); item.className = `ai-message ${message.role === 'user' ? 'ai-user' : 'ai-assistant'}`;
    const label = document.createElement('strong'); label.textContent = message.role === 'user' ? '你的問題' : 'AI 研究助理';
    const body = document.createElement('div'); body.className = 'ai-message-body';
    const formatted = message.role === 'assistant' ? renderMarkdown(message.content) : null;
    if (formatted === null) body.textContent = message.content; else body.innerHTML = formatted;
    item.append(label, body);
    if (message.role === 'assistant' && message.searchQuery) {
      const suggestion = document.createElement('div'); suggestion.className = 'ai-suggestion';
      const hint = document.createElement('label'); hint.textContent = '建議的 PubMed 搜尋式（可修改）';
      const input = document.createElement('textarea'); input.rows = 3; input.value = message.searchQuery; input.maxLength = 1500; input.setAttribute('aria-label', '建議的 PubMed 搜尋式');
      const button = document.createElement('button'); button.type = 'button'; button.className = 'ai-primary ai-search-button'; button.textContent = '搜尋 PubMed 並分析摘要 →'; button.disabled = Boolean(aiAbort);
      button.addEventListener('click', () => searchAndAnalyze(input.value));
      suggestion.append(hint, input, button); item.append(suggestion);
    }
    container.append(item);
  }
  $('ai-download').disabled = !aiConversation.some(message => message.role === 'assistant');
}
function setAiBusy(busy) {
  for (const id of ['ai-analyze', 'ai-send', 'ai-new', 'ai-settings-toggle', 'ai-example-organize', 'ai-example-compare', 'ai-example-extend']) $(id).disabled = busy;
  $('ai-cancel').hidden = !busy;
  document.querySelectorAll('.ai-search-button').forEach(button => { button.disabled = busy; });
  renderRoundTabs();
}
function requireAiConfig() {
  const config = currentAiConfig();
  if (!config.key || !config.model) { aiMessage('請先開啟「連接你的 AI」，輸入 API Key 並選擇或輸入模型。', true); $('ai-settings').hidden = false; $('ai-settings-toggle').setAttribute('aria-expanded', 'true'); return null; }
  return config;
}
async function runAiAnalysis(question, { papers, query, config, controller }) {
  aiMessage(`正在取得 ${papers.length} 篇文獻的摘要…`);
  const missing = papers.filter(p => !state.abstractCache.has(p.pmid));
  for (const group of chunks(missing, 40)) {
    const abstracts = await getAbstracts(group.map(p => p.pmid), controller.signal);
    if (controller.signal.aborted) throw abortError();
    for (const p of group) state.abstractCache.set(p.pmid, abstracts.get(p.pmid) || '');
  }
  const records = papers.map(p => ({ ...p, abstract: state.abstractCache.get(p.pmid) || '' }));
  const available = records.filter(p => p.abstract).length;
  const prompt = buildAnalysisPrompt({ query, papers: records, conversation: roundContext(activeRound()), question });
  if (prompt.length > 240000) throw new Error('文獻摘要與對話過長，請減少選取篇數或開始新對話。');
  if (controller.signal.aborted) throw abortError();
  aiMessage(`已取得 ${available}/${papers.length} 篇摘要，正在傳送給 ${PROVIDERS[config.provider].label} 分析…`);
  const answer = await generateText({ ...config, prompt, signal: controller.signal });
  if (controller.signal.aborted) throw abortError();
  const suggestion = extractSearchSuggestion(answer);
  aiConversation.push({ role: 'user', content: question, roundId: activeRoundId }, { role: 'assistant', content: suggestion.text, searchQuery: suggestion.query, roundId: activeRoundId });
  renderAiConversation();
  aiMessage(`分析完成：使用 ${papers.length} 篇文獻，其中 ${available} 篇有摘要。請核對原文。`);
  $('ai-question').value = '';
}
async function withAiTask(work) {
  if (aiAbort) return;
  const config = requireAiConfig();
  if (!config) return;
  const controller = new AbortController(); aiAbort = controller; setAiBusy(true);
  try {
    await work(config, controller);
  } catch (error) {
    aiMessage(error.name === 'AbortError' ? '已取消分析。' : `分析失敗：${error.message}`, error.name !== 'AbortError');
  } finally { aiAbort = null; setAiBusy(false); }
}
async function askAi(question, { requireSelection = false } = {}) {
  if (requireSelection && !state.selected.size) { aiMessage('請先在搜尋結果勾選文獻，加入「我的文獻清單」。', true); return; }
  const papers = [...(state.selected.size ? state.selected.values() : state.items)];
  const query = state.lastQuery;
  await withAiTask((config, controller) => runAiAnalysis(question, { papers, query, config, controller }));
}
async function searchAndAnalyze(suggestion) {
  const query = suggestion.trim();
  if (!query) { aiMessage('請輸入 PubMed 搜尋式。', true); return; }
  await withAiTask(async (config, controller) => {
    const previous = activeRound();
    $('query').value = query;
    aiMessage('正在搜尋 PubMed，完成後會讀取目前搜尋結果的摘要…');
    let result;
    try { result = await performSearch(true, controller.signal); }
    catch (error) { restoreRound(previous); throw error; }
    if (!result) throw new Error('搜尋未完成，請重試。');
    const round = addRound(`AI 搜尋 ${nextRoundId} · ${result.baseQuery}`);
    round.fromAiSearch = true;
    saveRoundResults(round, result);
    renderRoundTabs(); renderAiConversation(); updateAiScope();
    const sourceNote = result.source === 'europepmc' ? '因 PubMed 連線失敗，使用 Europe PMC 備援搜尋，PubMed 進階語法可能不完全相同。' : '';
    const question = `請根據剛才搜尋「${result.query}」的結果，整理這次取得的 ${result.papers.length} 篇文獻摘要（總搜尋結果 ${result.total} 篇，只分析目前這一頁），標示 PMID、說明限制並提出具體追問，協助我進一步縮小範圍。${sourceNote}${result.papers.length ? '' : '此次沒有搜尋到文獻，請勿虛構搜尋結果，請建議如何調整搜尋式。'}`;
    await runAiAnalysis(question, { papers: result.papers, query: result.query, config, controller });
  });
}

$('ai-provider').value = aiSettings.provider;
loadAiProvider();
updateAiScope();
renderRoundTabs();
$('ai-settings-toggle').addEventListener('click', () => {
  $('ai-settings').hidden = !$('ai-settings').hidden;
  $('ai-settings-toggle').setAttribute('aria-expanded', String(!$('ai-settings').hidden));
});
$('ai-provider').addEventListener('change', () => { aiTestAbort?.abort(); loadAiProvider(); });
$('ai-model-list').addEventListener('change', () => { if ($('ai-model-list').value) $('ai-model').value = $('ai-model-list').value; });
$('ai-save').addEventListener('click', () => {
  const { provider, key, model } = currentAiConfig();
  aiSettings.provider = provider; aiSettings.services[provider] = { key, model };
  const saved = saveAiSettings();
  aiSettingsMessage(saved ? '設定已儲存在此瀏覽器。' : '瀏覽器無法儲存設定；目前僅保留在頁面記憶體。', !saved);
});
$('ai-clear').addEventListener('click', () => {
  aiTestAbort?.abort();
  const provider = $('ai-provider').value;
  delete aiSettings.services[provider]; $('ai-key').value = ''; $('ai-model').value = '';
  $('ai-model-list').replaceChildren(new Option('請先讀取模型', ''));
  aiSettingsMessage(saveAiSettings() ? '已清除此服務儲存的 Key 與模型。' : '無法更新瀏覽器儲存空間，請檢查瀏覽器設定。');
});
$('ai-test').addEventListener('click', async () => {
  if (aiTestAbort) return;
  const { provider, key, model } = currentAiConfig();
  if (!key) { aiSettingsMessage('請先輸入 API Key。', true); return; }
  const controller = new AbortController(); aiTestAbort = controller; $('ai-test').disabled = true; aiSettingsMessage('正在連線並讀取模型清單…');
  try {
    const models = await listModels(provider, key, controller.signal);
    if (controller.signal.aborted || $('ai-provider').value !== provider || $('ai-key').value.trim() !== key) return;
    $('ai-model-list').replaceChildren(new Option('選擇模型', ''), ...models.map(item => new Option(item.label === item.id ? item.id : `${item.label}（${item.id}）`, item.id)));
    if (models.some(item => item.id === model)) $('ai-model-list').value = model;
    aiSettingsMessage(models.length ? `連線成功，取得 ${models.length} 個模型。請選擇支援文字生成的模型並儲存設定。` : '連線成功，但沒有可列舉的模型；可手動輸入模型 ID。');
  } catch (error) { if (error.name !== 'AbortError') aiSettingsMessage(`連線失敗：${error.message}`, true); }
  finally { aiTestAbort = null; $('ai-test').disabled = false; }
});
$('ai-analyze').addEventListener('click', () => askAi('請根據目前提供的文獻摘要整理研究主題、主要發現與差異，標示 PMID，並提出能協助我縮小研究範圍的問題。'));
$('ai-example-organize').addEventListener('click', () => askAi('請整理「我的文獻清單」中各篇文獻摘要，按研究主題歸類，標示 PMID、主要發現與證據限制；缺少摘要的文獻請明確註明。', { requireSelection: true }));
$('ai-example-compare').addEventListener('click', () => askAi('請逐篇摘要「我的文獻清單」中的文獻，比較各篇的研究對象、方法、主要結果與差異，標示 PMID；摘要未提及的資訊請註明未提供。', { requireSelection: true }));
$('ai-example-extend').addEventListener('click', () => askAi('請根據「我的文獻清單」的摘要，歸納研究方向與可能的研究缺口，提出能幫助我縮小範圍的問題；資訊足夠時，提供適合延伸查找相關文獻的 PubMed 搜尋式。', { requireSelection: true }));
$('ai-form').addEventListener('submit', event => { event.preventDefault(); const question = $('ai-question').value.trim(); if (question) askAi(question); });
$('ai-cancel').addEventListener('click', () => aiAbort?.abort());
$('ai-new').addEventListener('click', () => {
  const snapshot = activeRound().snapshot;
  const round = addRound(`新對話 ${nextRoundId}`, null);
  round.snapshot = snapshot;
  restoreRound(round); renderRoundTabs(); renderAiConversation(); aiMessage('已開始新對話。');
});
$('ai-download').addEventListener('click', () => {
  const report = aiConversation.map(message => `【${rounds.find(round => round.id === message.roundId)?.label || '對話'}｜${message.role === 'user' ? '研究問題' : 'AI 研究助理'}】\n${message.content}${message.searchQuery ? `\n\n【建議的 PubMed 搜尋式】\n${message.searchQuery}` : ''}`).join('\n\n');
  const url = URL.createObjectURL(new Blob([report], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = 'litfetch-ai-report.txt'; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
});
