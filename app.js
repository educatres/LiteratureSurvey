import { makeZip } from './zip.mjs';
import { PAGE_SIZE, MAX_EXPORT, buildPubmedQuery, normalizeSummary, metadataCsv, fileStem, chunks } from './domain.mjs';

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

async function performSearch(resetPage = true) {
  let query;
  try { query = buildPubmedQuery($('query').value, currentFilters()); }
  catch (error) { status(error.message, true); $('query').focus(); return; }
  if (state.searchAbort) state.searchAbort.abort();
  const controller = new AbortController();
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
      response = await searchIds(query, state.page * PAGE_SIZE, PAGE_SIZE, $('sort-by').value, controller.signal);
      papers = await getSummaries(response.ids, controller.signal);
    } catch (primaryError) {
      if (controller.signal.aborted || primaryError.name === 'AbortError') throw primaryError;
      try {
        const cursorMark = state.epmcCursors.get(state.page);
        if (!cursorMark) throw new Error('無法取得此頁的備援搜尋游標，請重新搜尋。');
        const fallback = await europePmcSearch(europePmcQuery($('query').value.trim(), { ...currentFilters(), sort: $('sort-by').value }), controller.signal, { cursorMark });
        if (fallback.nextCursorMark) state.epmcCursors.set(state.page + 1, fallback.nextCursorMark);
        response = { total: fallback.hitCount || 0 };
        papers = fallback.resultList.result.map(normalizeEuropePmc).filter(Boolean);
        source = 'europepmc';
      } catch (fallbackError) {
        if (controller.signal.aborted || fallbackError.name === 'AbortError') throw fallbackError;
        throw new Error(`NCBI 與 Europe PMC 都無法連線（${fallbackError.message}）。可能是瀏覽器擴充功能、網路防火牆或跨站連線限制；請嘗試其他瀏覽器或網路。`);
      }
    }
    if (controller.signal.aborted) return;
    state.total = response.total;
    state.items = papers;
    state.searchSource = source;
    for (const p of papers) if (typeof p.abstract === 'string') state.abstractCache.set(p.pmid, p.abstract);
    renderResults();
    status(`顯示第 ${response.total ? state.page * PAGE_SIZE + 1 : 0}–${Math.min((state.page + 1) * PAGE_SIZE, response.total)} 篇；可跨頁挑選文獻。${source === 'europepmc' ? '目前使用 Europe PMC 備援搜尋（PubMed 收錄文獻）；進階 PubMed 語法可能有差異。' : ''}`);
  } catch (error) {
    if (error.name !== 'AbortError' && !controller.signal.aborted) {
      $('results-list').innerHTML = '<div class="empty-state"><h3>搜尋失敗</h3><p>請稍後再試，或調整 PubMed 查詢條件。</p></div>';
      status(error.message || '無法連接 PubMed。', true);
    }
  } finally {
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

$('search-form').addEventListener('submit', event => { event.preventDefault(); performSearch(true); });
$('apply-filters').addEventListener('click', () => performSearch(true));
$('reset-filters').addEventListener('click', () => {
  $('year-from').value = ''; $('year-to').value = ''; $('article-type').value = '';
  $('sort-by').value = 'relevance'; $('open-access').checked = false;
  if ($('query').value.trim()) performSearch(true);
});
document.querySelectorAll('.example-query').forEach(button => button.addEventListener('click', () => {
  $('query').value = button.dataset.query;
  performSearch(true);
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
$('prev-page').addEventListener('click', () => { if (state.page > 0) { state.page--; performSearch(false); } });
$('next-page').addEventListener('click', () => { if ((state.page + 1) * PAGE_SIZE < state.total) { state.page++; performSearch(false); } });
$('download-abstracts').addEventListener('click', () => startExport('abstracts'));
$('download-fulltext').addEventListener('click', () => startExport('fulltext'));
$('cancel-download').addEventListener('click', () => state.exportAbort?.abort());
$('progress-dialog').addEventListener('cancel', event => { event.preventDefault(); state.exportAbort?.abort(); });
for (const id of ['close-abstract', 'close-abstract-bottom']) $(id).addEventListener('click', () => $('abstract-dialog').close());
