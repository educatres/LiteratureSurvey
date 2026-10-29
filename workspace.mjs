// Keep browser storage JSON-compatible while preserving cursor maps in memory.
export function encodeWorkspace({ rounds, activeRoundId, nextRoundId, selected, abstracts, abstractAssists = new Map(), conversation, fields, activeChatId = 'chat-1', chatSequence = 1 }) {
  return JSON.stringify({ version: 1, activeRoundId, nextRoundId,
    rounds: rounds.map(round => ({ ...round, snapshot: round.snapshot && {
      ...round.snapshot, cursors: [...round.snapshot.cursors]
    } })),
    selected: [...selected], abstracts: [...abstracts], abstractAssists: [...abstractAssists], conversation, fields, activeChatId, chatSequence
  });
}

export function decodeWorkspace(raw) {
  const saved = JSON.parse(raw);
  if (!saved || saved.version !== 1 || !Array.isArray(saved.rounds) || !saved.rounds.length ||
      !Array.isArray(saved.selected) || !Array.isArray(saved.abstracts) || !Array.isArray(saved.conversation) ||
      !saved.fields || typeof saved.fields !== 'object') throw new Error('Invalid workspace');
  const abstractAssists = saved.abstractAssists === undefined ? [] : saved.abstractAssists;
  if (!Array.isArray(abstractAssists)) throw new Error('Invalid abstract assists');
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
  if (!abstractAssists.every(entry => Array.isArray(entry) && entry.length === 2 && /^\d+$/.test(entry[0]) && entry[1] &&
      typeof entry[1].translation === 'string' && typeof entry[1].summary === 'string')) throw new Error('Invalid abstract assists');
  const activeChatId = typeof saved.activeChatId === 'string' && /^chat-\d+$/.test(saved.activeChatId) ? saved.activeChatId : 'chat-1';
  const chatSequence = Number.isSafeInteger(saved.chatSequence) && saved.chatSequence >= 1 ? saved.chatSequence : 1;
  return { ...saved, rounds, selected: new Map(saved.selected), abstracts: new Map(saved.abstracts), abstractAssists: new Map(abstractAssists), activeChatId, chatSequence };
}

export function encodeProjectIndex({ projects, activeProjectId = null }) {
  return JSON.stringify({ version: 1, activeProjectId, projects });
}

export function decodeProjectIndex(raw) {
  const saved = JSON.parse(raw);
  if (!saved || saved.version !== 1 || !Array.isArray(saved.projects)) throw new Error('Invalid project index');
  const ids = new Set();
  const projects = saved.projects.map(project => {
    if (!project || typeof project.id !== 'string' || !/^project-[A-Za-z0-9_-]+$/.test(project.id) || ids.has(project.id) ||
        typeof project.name !== 'string' || !project.name.trim() || project.name.length > 80 ||
        typeof project.createdAt !== 'string' || typeof project.updatedAt !== 'string') throw new Error('Invalid project');
    ids.add(project.id);
    return { id: project.id, name: project.name, createdAt: project.createdAt, updatedAt: project.updatedAt };
  });
  const activeProjectId = saved.activeProjectId === null || saved.activeProjectId === undefined ? null : saved.activeProjectId;
  if (activeProjectId !== null && (typeof activeProjectId !== 'string' || !ids.has(activeProjectId))) throw new Error('Invalid active project');
  return { version: 1, activeProjectId, projects };
}
