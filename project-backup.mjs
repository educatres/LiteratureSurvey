import { encodeWorkspace, decodeWorkspace, encodeProjectIndex, decodeProjectIndex } from './workspace.mjs';

export const PROJECT_INDEX_STORAGE = 'literaturesurvey.projects.v1';
export const PROJECT_WORKSPACE_PREFIX = 'literaturesurvey.project.';
const BACKUP_FIELDS = ['query', 'year-from', 'year-to', 'article-type', 'sort-by', 'open-access', 'results-keyword', 'contact-email', 'ai-question'];

function normalizeWorkspace(value) {
  const workspace = decodeWorkspace(JSON.stringify(value));
  const fields = {};
  for (const key of BACKUP_FIELDS) {
    const field = workspace.fields[key];
    if (field === undefined) continue;
    if (typeof field !== (key === 'open-access' ? 'boolean' : 'string')) throw new Error('Invalid workspace field');
    fields[key] = field;
  }
  for (const message of workspace.conversation) {
    if ((message.id !== undefined && (typeof message.id !== 'string' || !/^conversation-\d+$/.test(message.id))) ||
        (message.chatId !== undefined && (typeof message.chatId !== 'string' || !/^chat-\d+$/.test(message.chatId))) ||
        ['hidden', 'noted', 'hasSearchSuggestion'].some(key => message[key] !== undefined && typeof message[key] !== 'boolean')) {
      throw new Error('Invalid conversation');
    }
  }
  return JSON.parse(encodeWorkspace({ ...workspace, fields }));
}

export function decodeProjectBackup(raw) {
  const backup = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (!backup || backup.format !== 'literaturesurvey-project' || backup.version !== 1 || !backup.project ||
      typeof backup.project.name !== 'string' || !backup.project.name.trim() || backup.project.name.length > 80 ||
      ['createdAt', 'updatedAt'].some(key => typeof backup.project[key] !== 'string' || !Number.isFinite(Date.parse(backup.project[key])))) {
    throw new Error('Invalid project backup');
  }
  return {
    format: 'literaturesurvey-project', version: 1,
    project: { name: backup.project.name.trim(), createdAt: backup.project.createdAt, updatedAt: backup.project.updatedAt },
    workspace: normalizeWorkspace(backup.workspace)
  };
}

export function encodeProjectBackup(project, rawWorkspace) {
  const backup = decodeProjectBackup(JSON.stringify({
    format: 'literaturesurvey-project', version: 1, project, workspace: JSON.parse(rawWorkspace)
  }));
  return JSON.stringify({ ...backup, exportedAt: new Date().toISOString() }, null, 2);
}

export function storeImportedProject(storage, index, backup, id, now = new Date().toISOString()) {
  // A backup always becomes a new project, including when importing it twice.
  const validated = decodeProjectBackup(JSON.stringify(backup));
  const usedNames = new Set(index.projects.map(project => project.name.toLocaleLowerCase()));
  let name = validated.project.name;
  for (let sequence = 2; usedNames.has(name.toLocaleLowerCase()); sequence++) {
    const suffix = ` (${sequence})`;
    name = `${validated.project.name.slice(0, 80 - suffix.length)}${suffix}`;
  }
  const project = { id, name, createdAt: validated.project.createdAt, updatedAt: now };
  const nextIndex = { ...index, projects: [...index.projects, project] };
  decodeProjectIndex(encodeProjectIndex(nextIndex));
  const key = `${PROJECT_WORKSPACE_PREFIX}${encodeURIComponent(id)}`;
  if (storage.getItem(key) !== null) throw new Error('Project already exists');
  storage.setItem(key, JSON.stringify(validated.workspace));
  try {
    storage.setItem(PROJECT_INDEX_STORAGE, encodeProjectIndex(nextIndex));
  } catch (error) {
    try { storage.removeItem(key); } catch { /* Preserve the storage failure. */ }
    throw error;
  }
  return { project, index: nextIndex };
}
