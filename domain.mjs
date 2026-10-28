export const PAGE_SIZE = 20;
export const MAX_EXPORT = 100;

export function buildPubmedQuery(query, { from = '', to = '', articleType = '', openAccess = false } = {}) {
  const base = query.trim();
  if (!base) throw new Error('請先輸入搜尋關鍵字。');
  const low = from === '' ? '' : Number(from);
  const high = to === '' ? '' : Number(to);
  if ((from !== '' && (!Number.isInteger(low) || low < 1800 || low > 2100)) ||
      (to !== '' && (!Number.isInteger(high) || high < 1800 || high > 2100))) throw new Error('請輸入有效的出版年份（1800–2100）。');
  if (low && high && low > high) throw new Error('起始年份不可大於結束年份。');
  const sections = [`(${base})`];
  if (low || high) sections.push(`${low || 1800}:${high || new Date().getFullYear()}[dp]`);
  if (articleType) sections.push(articleType);
  if (openAccess) sections.push('pubmed pmc open access[filter]');
  return sections.join(' AND ');
}

export function getArticleId(article, type) {
  const ids = Array.isArray(article.articleids) ? article.articleids : [];
  return ids.find(item => item.idtype === type)?.value || '';
}

export function normalizeSummary(article) {
  const pmid = String(article.uid || '');
  if (!/^\d+$/.test(pmid)) throw new Error('Invalid PMID in NCBI response');
  const pmcid = getArticleId(article, 'pmc');
  const doi = getArticleId(article, 'doi');
  return {
    pmid,
    pmcid: /^PMC\d+$/i.test(pmcid) ? pmcid.toUpperCase() : '',
    doi,
    title: article.title || '未提供標題',
    journal: article.fulljournalname || article.source || '未提供期刊',
    date: article.pubdate || '',
    year: (article.pubdate || '').match(/\b(?:18|19|20)\d{2}\b/)?.[0] || '',
    authors: Array.isArray(article.authors) ? article.authors.map(a => a.name).filter(Boolean) : [],
    type: Array.isArray(article.pubtype) ? article.pubtype : [],
    hasAbstract: (article.attributes || []).includes('Has Abstract')
  };
}

export function csvEscape(value) {
  let str = String(value ?? '').replace(/\r\n?/g, '\n');
  // Prevent spreadsheet formula execution when imported into Excel/Sheets.
  if (/^[\s]*[=+@\-\t\r]/.test(str)) str = `'${str}`;
  return `"${str.replaceAll('"', '""')}"`;
}

export function metadataCsv(papers) {
  const rows = [['PMID', 'PMCID', 'DOI', 'Title', 'Authors', 'Journal', 'Year', 'Publication date', 'PubMed URL', 'PMC URL']];
  for (const p of papers) rows.push([
    p.pmid, p.pmcid, p.doi, p.title, p.authors.join('; '), p.journal,
    p.year, p.date, `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`,
    p.pmcid ? `https://pmc.ncbi.nlm.nih.gov/articles/${p.pmcid}/` : ''
  ]);
  return '\ufeff' + rows.map(row => row.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

export function fileStem(article) {
  return `${article.pmid}_${article.title}`.normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/\s+/g, '_').replace(/_+/g, '_').slice(0, 105).replace(/[. ]+$/, '');
}

export function chunks(items, count) {
  const out = [];
  for (let i = 0; i < items.length; i += count) out.push(items.slice(i, i + count));
  return out;
}
