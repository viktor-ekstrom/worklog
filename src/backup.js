import { normalizeWeek } from './schema.js';

export const BACKUP_FORMAT_VERSION = 1;

export function createBackupPayload(weeks) {
  const normalized = weeks.map((week, index) => normalizeWeek(week, `Backup week ${index + 1}`));
  return {
    backupFormatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    weeks: normalized
  };
}

export function parseImportDocument(text, sourceName = 'JSON file') {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${sourceName} is not valid JSON: ${error.message}`);
  }

  if (parsed && Array.isArray(parsed.weeks)) {
    const version = parsed.backupFormatVersion ?? parsed.schemaVersion ?? 1;
    if (version !== BACKUP_FORMAT_VERSION) throw new Error(`${sourceName} uses unsupported backup format version ${version}.`);
    if (!parsed.weeks.length) throw new Error(`${sourceName} contains no weekly files.`);
    return { kind: 'backup', weeks: parsed.weeks.map((week, index) => normalizeWeek(week, `${sourceName} week ${index + 1}`)) };
  }

  return { kind: 'week', weeks: [normalizeWeek(parsed, sourceName)] };
}

export function mergeImportDocuments(documents) {
  const byWeek = new Map();
  let includesBackup = false;
  for (const document of documents) {
    if (document.kind === 'backup') includesBackup = true;
    for (const week of document.weeks) {
      if (byWeek.has(week.week)) throw new Error(`The selected files contain ${week.week} more than once.`);
      byWeek.set(week.week, week);
    }
  }
  return { kind: includesBackup ? 'backup' : 'weeks', weeks: [...byWeek.values()].sort((a, b) => a.week.localeCompare(b.week)) };
}
