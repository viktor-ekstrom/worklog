export const ENTRY_META = {
  meeting: { label: 'Meeting', className: 'type-meeting', icon: '♟', description: 'Notes, decisions, participants' },
  work: { label: 'Work done', className: 'type-work', icon: '▰', description: 'What you worked on, outcomes' },
  conversation: { label: 'Conversation', className: 'type-conversation', icon: '◌', description: 'Informal discussions, 1:1s' },
  decision: { label: 'Decision', className: 'type-decision', icon: '✓', description: 'Key decisions and rationale' },
  achievement: { label: 'Achievement', className: 'type-achievement', icon: '★', description: 'Milestones and impact' },
  note: { label: 'Quick note', className: 'type-note', icon: '▤', description: 'Miscellaneous notes' }
};

export const pad = value => String(value).padStart(2, '0');

export function toLocalDateInput(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseLocalDate(value) {
  const [y, m, d] = String(value).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function startOfISOWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - day + 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function endOfISOWeek(date) {
  const d = startOfISOWeek(date);
  d.setDate(d.getDate() + 6);
  d.setHours(23, 59, 59, 999);
  return d;
}

export function getISOWeekInfo(date = new Date()) {
  const local = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const utc = new Date(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((((utc - yearStart) / 86400000) + 1) / 7));
  const year = utc.getUTCFullYear();
  const start = startOfISOWeek(local);
  const end = endOfISOWeek(local);
  return { year, week, key: `${year}-W${pad(week)}`, startDate: toLocalDateInput(start), endDate: toLocalDateInput(end) };
}

export function createEmptyWeek(date = new Date()) {
  const info = getISOWeekInfo(date);
  return {
    schemaVersion: 1,
    week: info.key,
    startDate: info.startDate,
    endDate: info.endDate,
    entries: [],
    weeklyReflection: { highlights: [], outcomes: [], challenges: [], learnings: [] }
  };
}

export function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

export function formatDate(date, options = {}) {
  return new Intl.DateTimeFormat('en-GB', options).format(date);
}

export function formatRange(start, end) {
  const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
  if (sameMonth) return `${start.getDate()}–${end.getDate()} ${formatDate(end, { month: 'short', year: 'numeric' })}`;
  return `${formatDate(start, { day: 'numeric', month: 'short' })} – ${formatDate(end, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

export function splitLines(value = '') {
  return String(value).split('\n').map(v => v.trim()).filter(Boolean);
}

export function joinLines(value) {
  if (!value) return '';
  return Array.isArray(value) ? value.join('\n') : String(value);
}

export function normalizeList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  return String(value).split(',').map(v => v.trim()).filter(Boolean);
}

export function escapeHTML(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

export function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    const aKey = `${a.date || ''}T${a.time || '99:99'}`;
    const bKey = `${b.date || ''}T${b.time || '99:99'}`;
    return aKey.localeCompare(bKey);
  });
}

export function entryPreview(entry) {
  const source = entry.summary || entry.decision || entry.content || entry.outcome || entry.notes?.[0] || entry.discussion?.[0] || entry.impact || '';
  return String(source).replace(/\s+/g, ' ').trim();
}

export function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `entry-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
