// Keep browser storage JSON-compatible while preserving cursor maps in memory.
export function encodeWorkspace({ rounds, activeRoundId, nextRoundId, selected, abstracts, conversation, fields }) {
  return JSON.stringify({ version: 1, activeRoundId, nextRoundId,
    rounds: rounds.map(round => ({ ...round, snapshot: round.snapshot && {
      ...round.snapshot, cursors: [...round.snapshot.cursors]
    } })),
    selected: [...selected], abstracts: [...abstracts], conversation, fields
  });
}

export function decodeWorkspace(raw) {
  const saved = JSON.parse(raw);
  if (!saved || saved.version !== 1 || !Array.isArray(saved.rounds) || !saved.rounds.length ||
      !Array.isArray(saved.selected) || !Array.isArray(saved.abstracts) || !Array.isArray(saved.conversation) ||
      !saved.fields || typeof saved.fields !== 'object') throw new Error('Invalid workspace');
  const validPaper = paper => paper && typeof paper.pmid === 'string' && /^\d+$/.test(paper.pmid) &&
    typeof paper.pmcid === 'string' && (!paper.pmcid || /^PMC\d+$/.test(paper.pmcid)) &&
    ['doi', 'title', 'journal', 'date', 'year'].every(key => typeof paper[key] === 'string') &&
    Array.isArray(paper.authors) && paper.authors.every(value => typeof value === 'string') &&
    Array.isArray(paper.type) && paper.type.every(value => typeof value === 'string');
  const validPapers = papers => Array.isArray(papers) && papers.every(validPaper);
  const ids = new Set();
  const rounds = saved.rounds.map(round => {
    if (!round || !Number.isSafeInteger(round.id) || round.id < 0 || ids.has(round.id) || typeof round.label !== 'string') throw new Error('Invalid round');
    ids.add(round.id);
    if (!round.snapshot) return { ...round, snapshot: null };
    const snapshot = round.snapshot;
    if (!snapshot.filters || !validPapers(snapshot.items) || !Array.isArray(snapshot.cursors) ||
        !Number.isSafeInteger(snapshot.page) || snapshot.page < 0 || !Number.isFinite(snapshot.total) || snapshot.total < 0 ||
        typeof snapshot.query !== 'string' || typeof snapshot.baseQuery !== 'string' ||
        !['ncbi', 'europepmc'].includes(snapshot.source) || typeof snapshot.sort !== 'string') throw new Error('Invalid snapshot');
    for (const [page, cached] of Object.entries(snapshot.pages || {})) {
      if (!/^\d+$/.test(page) || !cached || !validPapers(cached.items) || !Number.isFinite(cached.total) || cached.total < 0 ||
          !['ncbi', 'europepmc'].includes(cached.source)) throw new Error('Invalid cached page');
    }
    return { ...round, snapshot: { ...snapshot, cursors: new Map(snapshot.cursors), pages: snapshot.pages || {} } };
  });
  if (!ids.has(saved.activeRoundId) || !Number.isSafeInteger(saved.nextRoundId) || saved.nextRoundId <= Math.max(...ids)) throw new Error('Invalid active round');
  for (const round of rounds) if (round.parent !== null && (!ids.has(round.parent) || round.parent >= round.id)) throw new Error('Invalid round ancestry');
  for (const message of saved.conversation) if (!message || !ids.has(message.roundId) || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || (message.searchQuery !== undefined && typeof message.searchQuery !== 'string')) throw new Error('Invalid message');
  if (!saved.selected.every(entry => Array.isArray(entry) && entry.length === 2 && validPaper(entry[1]) && entry[0] === entry[1].pmid) ||
      !saved.abstracts.every(entry => Array.isArray(entry) && entry.length === 2 && /^\d+$/.test(entry[0]) && typeof entry[1] === 'string')) throw new Error('Invalid saved papers');
  return { ...saved, rounds, selected: new Map(saved.selected), abstracts: new Map(saved.abstracts) };
}
