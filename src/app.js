import {
  ENTRY_META, addDays, addMonths, createEmptyWeek, endOfISOWeek, entryPreview, escapeHTML,
  formatDate, formatRange, getISOWeekInfo, isSameDay, joinLines, normalizeList, parseLocalDate,
  sortEntries, splitLines, startOfISOWeek, toLocalDateInput, uid
} from './utils.js';
import {
  chooseDirectory, downloadBackup, ensurePermission, forgetDirectory, getRememberedDirectory,
  inspectImportFiles, getImportConflicts, applyImport, readAllWeeks, readWeek, supportsFileSystemAccess, saveEntry, removeEntry, saveReflection
} from './storage.js';

const state = {
  view: 'week',
  cursor: new Date(),
  directory: null,
  connected: false,
  currentWeek: createEmptyWeek(new Date()),
  allWeeks: [],
  search: '',
  searchType: 'all',
  monthTab: 'entries'
};

const els = {
  content: document.querySelector('#content'),
  notice: document.querySelector('#notice-area'),
  title: document.querySelector('#page-title'),
  subtitle: document.querySelector('#page-subtitle'),
  eyebrow: document.querySelector('#eyebrow'),
  previous: document.querySelector('#previous-btn'),
  next: document.querySelector('#next-btn'),
  today: document.querySelector('#today-btn'),
  add: document.querySelector('#add-btn'),
  modal: document.querySelector('#modal-root'),
  toast: document.querySelector('#toast-root')
};

const theme = localStorage.getItem('worklog-theme') || 'system';
applyTheme(theme);

function applyTheme(value) {
  const resolved = value === 'system'
    ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : value;
  document.documentElement.dataset.theme = resolved;
}

matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  if ((localStorage.getItem('worklog-theme') || 'system') === 'system') applyTheme('system');
});

function toast(message, error = false) {
  const node = document.createElement('div');
  node.className = `toast${error ? ' error' : ''}`;
  node.textContent = message;
  els.toast.appendChild(node);
  setTimeout(() => node.remove(), 3200);
}

let modalDirty = false;
let modalBusy = false;
let modalFocus = null;
function setModal(html) {
  modalFocus = document.activeElement;
  modalDirty = false;
  els.modal.innerHTML = html;
  const dialog = els.modal.querySelector('.modal');
  dialog?.setAttribute('role', 'dialog');
  dialog?.setAttribute('aria-modal', 'true');
  dialog?.setAttribute('aria-label', dialog.querySelector('h2')?.textContent || 'Entry');
  els.modal.querySelectorAll('.field').forEach((field, i) => {
    const input = field.querySelector('input, textarea, select');
    const label = field.querySelector('label');
    if (input && label) { input.id ||= `modal-field-${i}`; label.htmlFor = input.id; }
  });
  els.modal.querySelectorAll('.close-btn').forEach(button => button.setAttribute('aria-label', 'Close'));
  els.modal.querySelector('form')?.addEventListener('input', () => { modalDirty = true; });
  els.modal.querySelector('input, textarea, button')?.focus();
  const backdrop = els.modal.querySelector('.modal-backdrop');
  backdrop?.addEventListener('mousedown', event => {
    if (event.target === backdrop) closeModal();
  });
  els.modal.querySelectorAll('[data-close-modal]').forEach(btn => btn.addEventListener('click', closeModal));
}

function closeModal(force = false) {
  if (modalBusy) return;
  if (force !== true && modalDirty && !confirm('Discard unsaved changes?')) return;
  els.modal.innerHTML = ''; modalDirty = false; modalFocus?.focus();
}
window.addEventListener('beforeunload', event => { if (modalDirty || modalBusy) { event.preventDefault(); event.returnValue = ''; } });

async function initialize() {
  bindGlobalEvents();
  try {
    state.directory = await getRememberedDirectory();
    if (state.directory) state.connected = await ensurePermission(state.directory, false);
  } catch (error) { state.readError = error.message; }
  await refreshData(false);
}
window.addEventListener('worklog-storage-warning', event => { state.storageWarning = event.detail; toast(event.detail, true); });

function bindGlobalEvents() {
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', async () => {
    state.view = button.dataset.view;
    if (state.view === 'today') state.cursor = new Date();
    updateNavigation();
    await refreshData(false);
  }));

  els.previous.addEventListener('click', async () => {
    state.cursor = navigateCursor(-1);
    await refreshData(false);
  });
  els.next.addEventListener('click', async () => {
    state.cursor = navigateCursor(1);
    await refreshData(false);
  });
  els.today.addEventListener('click', async () => {
    state.cursor = new Date();
    await refreshData(false);
  });
  els.add.addEventListener('click', () => openEntryTypeModal());

  document.addEventListener('keydown', event => {
    if (!els.modal.innerHTML && (event.key === 'n' || event.key === 'N') && !event.metaKey && !event.ctrlKey && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) {
      event.preventDefault();
      openEntryTypeModal();
    }
    if (event.key === 'Tab' && els.modal.innerHTML) {
      const focusable = [...els.modal.querySelectorAll('button, input, textarea, select, a[href]')].filter(el => !el.disabled);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    if (event.key === 'Escape' && els.modal.innerHTML) closeModal();
  });
}

function navigateCursor(direction) {
  if (state.view === 'today') return addDays(state.cursor, direction);
  if (state.view === 'week') return addDays(state.cursor, 7 * direction);
  if (state.view === 'month') return addMonths(state.cursor, direction);
  if (state.view === 'analytics') {
    const d = new Date(state.cursor);
    d.setFullYear(d.getFullYear() + direction);
    return d;
  }
  return addDays(state.cursor, 7 * direction);
}

async function connectFolder() {
  try {
    state.directory = await chooseDirectory();
    state.connected = await ensurePermission(state.directory, true);
    if (state.connected) {
      toast(`Connected to ${state.directory.name}`);
      await refreshData(true);
    }
  } catch (error) {
    if (error?.name !== 'AbortError') toast(error.message || 'Could not connect folder.', true);
  }
}

async function requestExistingPermission() {
  if (!state.directory) return connectFolder();
  try {
    state.connected = await ensurePermission(state.directory, true);
    await refreshData(true);
  } catch (error) { toast(error.message, true); }
}

async function refreshData(forceAll = false) {
  try {
    if (state.directory && !state.connected) state.connected = await ensurePermission(state.directory, false);
    if (state.connected) {
      state.readError = '';
      state.currentWeek = await readWeek(state.directory, state.cursor);
      if (forceAll || ['search','people','topics','analytics','month','settings'].includes(state.view)) {
        state.allWeeks = await readAllWeeks(state.directory);
      }
    } else {
      state.currentWeek = createEmptyWeek(state.cursor);
      state.allWeeks = [];
    }
  } catch (error) {
    console.error(error);
    if (error.name === 'NotAllowedError') state.connected = false;
    state.allWeeks = [];
    state.currentWeek = createEmptyWeek(state.cursor);
    state.readError = error.message;
    toast(error.message, true);
  }
  render();
}

function updateNavigation() {
  document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === state.view));
}

function render() {
  updateNavigation();
  renderNotice();
  const header = getHeader();
  els.eyebrow.textContent = header.eyebrow || '';
  els.title.textContent = header.title;
  els.subtitle.textContent = header.subtitle || '';
  els.previous.style.display = header.navigation === false ? 'none' : '';
  els.next.style.display = header.navigation === false ? 'none' : '';
  els.today.style.display = header.navigation === false ? 'none' : '';
  els.add.style.display = ['settings', 'analytics', 'people', 'topics'].includes(state.view) ? 'none' : '';

  const renderers = {
    today: renderToday, week: renderWeek, month: renderMonth, search: renderSearch,
    people: renderPeople, topics: renderTopics, analytics: renderAnalytics, settings: renderSettings
  };
  els.content.dataset.view = state.view;
  els.content.innerHTML = renderers[state.view]?.() || renderWeek();
  bindRenderedEvents();
}

function renderNotice() {
  if (state.storageWarning && !state.readError) {
    els.notice.innerHTML = `<div class="notice" role="alert">${escapeHTML(state.storageWarning)}</div>`;
    return;
  }
  if (state.connected && !state.readError) {
    els.notice.innerHTML = '';
    return;
  }
  if (state.connected && state.readError) {
    els.notice.innerHTML = `<div class="notice" role="alert">${escapeHTML(state.readError)} Use Settings to restore a valid backup, or repair the file in your folder.</div>`;
    return;
  }
  const supportedText = supportsFileSystemAccess
    ? 'Choose a local folder. WorkLog will read and write your weekly JSON files there.'
    : 'Direct folder access requires Microsoft Edge or Google Chrome on desktop.';
  const action = state.directory ? 'Allow access' : 'Connect folder';
  els.notice.innerHTML = `<div class="notice">
    <div>${state.readError ? `<p role="alert">${escapeHTML(state.readError)}</p>` : ''}<strong>${state.directory ? `Reconnect ${escapeHTML(state.directory.name)}` : 'No worklog folder connected'}</strong><div class="notice-copy">${supportedText}</div></div>
    <button class="primary-btn" id="notice-connect" ${supportsFileSystemAccess ? '' : 'disabled'}>${action}</button>
  </div>`;
  document.querySelector('#notice-connect')?.addEventListener('click', state.directory ? requestExistingPermission : connectFolder);
}

function getHeader() {
  const weekInfo = getISOWeekInfo(state.cursor);
  const start = startOfISOWeek(state.cursor);
  const end = endOfISOWeek(state.cursor);
  if (state.view === 'week') return { eyebrow: 'Weekly journal', title: `Week ${weekInfo.week}`, subtitle: formatRange(start, end) };
  if (state.view === 'today') return { eyebrow: formatDate(state.cursor, { weekday: 'long' }), title: 'Today', subtitle: formatDate(state.cursor, { day: 'numeric', month: 'long', year: 'numeric' }) };
  if (state.view === 'month') return { eyebrow: 'Monthly view', title: formatDate(state.cursor, { month: 'long', year: 'numeric' }), subtitle: 'Entries, highlights and reflection' };
  if (state.view === 'analytics') return { eyebrow: 'Year in review', title: String(state.cursor.getFullYear()), subtitle: 'Activity and context for performance reviews' };
  if (state.view === 'search') return { eyebrow: 'Find anything', title: 'Search', subtitle: 'Search across entries, people, topics and content', navigation: false };
  if (state.view === 'people') return { eyebrow: 'Relationships', title: 'People', subtitle: 'Everyone mentioned in your work journal', navigation: false };
  if (state.view === 'topics') return { eyebrow: 'Context', title: 'Topics', subtitle: 'Projects, domains and recurring themes', navigation: false };
  return { eyebrow: 'Local-first', title: 'Settings', subtitle: 'Storage, portability and appearance', navigation: false };
}

function renderEmpty(title, copy, icon = '＋') {
  return `<div class="empty-state"><div class="empty-state-inner"><div class="empty-state-icon">${icon}</div><h2>${escapeHTML(title)}</h2><p>${escapeHTML(copy)}</p>${state.connected ? '<button class="primary-btn" data-add-entry>＋ Add entry</button>' : ''}</div></div>`;
}

function renderWeek() {
  const start = startOfISOWeek(state.cursor);
  const week = state.connected ? state.currentWeek : createEmptyWeek(state.cursor);
  const entries = sortEntries(week.entries || []);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const hasEntries = entries.length > 0;
  if (!state.connected && !hasEntries) return renderEmpty('Connect a local folder to begin', 'Your journal stays in portable weekly JSON files on your computer.', '⌂');
  return `<div class="week-card">${days.map(day => {
    const dateKey = toLocalDateInput(day);
    const dayEntries = entries.filter(entry => entry.date === dateKey);
    return `<section class="day-section">
      <div class="day-label"><div class="day-name">${formatDate(day, { weekday: 'short' })}</div><div class="day-date">${formatDate(day, { day: 'numeric', month: 'short' })}</div></div>
      <div class="day-entries">${dayEntries.length ? dayEntries.map(renderEntryRow).join('') : '<div class="day-empty">No entries</div>'}</div>
    </section>`;
  }).join('')}</div><div class="panel" style="margin-top:20px"><div class="setting-row"><div><h2>Weekly reflection</h2><p>Highlights, outcomes, challenges and learnings</p></div><button class="secondary-btn" id="edit-reflection">Edit reflection</button></div>${Object.entries(week.weeklyReflection).map(([key, items]) => detailSection(key[0].toUpperCase() + key.slice(1), items)).join('')}</div>`;
}

function renderEntryRow(entry) {
  const meta = ENTRY_META[entry.type] || ENTRY_META.note;
  const topics = normalizeList(entry.topics);
  return `<button class="entry-row" data-entry-id="${escapeHTML(entry.id)}">
    <div class="entry-time">${escapeHTML(entry.time || '—')}</div>
    <div class="entry-title"><div class="entry-title-line"><span class="entry-title-text">${escapeHTML(entry.title)}</span><span class="type-pill ${meta.className}">${meta.label}</span>${topics[0] ? `<span class="topic-pill">${escapeHTML(topics[0])}</span>` : ''}</div></div>
    <div class="entry-preview">${escapeHTML(entryPreview(entry))}</div>
  </button>`;
}

function renderToday() {
  const dateKey = toLocalDateInput(state.cursor);
  const entries = getAllKnownEntries().filter(entry => entry.date === dateKey);
  if (!entries.length) return renderEmpty('Nothing logged today', 'Capture a meeting, conversation, decision or piece of work while the context is fresh.');
  return `<div class="today-stack">${sortEntries(entries).map(entry => `<button class="today-entry" data-entry-id="${escapeHTML(entry.id)}"><div class="entry-time">${escapeHTML(entry.time || '—')}</div><div>${renderEntrySummary(entry)}</div></button>`).join('')}</div>`;
}

function renderEntrySummary(entry) {
  const meta = ENTRY_META[entry.type] || ENTRY_META.note;
  return `<div class="entry-title-line"><strong>${escapeHTML(entry.title)}</strong><span class="type-pill ${meta.className}">${meta.label}</span></div><div class="entry-preview" style="padding-top:6px">${escapeHTML(entryPreview(entry))}</div>`;
}

function renderMonth() {
  const month = state.cursor.getMonth();
  const year = state.cursor.getFullYear();
  const entries = getAllKnownEntries().filter(entry => {
    const d = parseLocalDate(entry.date);
    return d.getMonth() === month && d.getFullYear() === year;
  });
  return `<div class="month-tabs">
    ${['entries','highlights','reflections'].map(tab => `<button class="month-tab ${state.monthTab === tab ? 'active' : ''}" data-month-tab="${tab}">${tab[0].toUpperCase() + tab.slice(1)}</button>`).join('')}
  </div>${renderMonthTab(entries)}`;
}

function renderMonthTab(entries) {
  if (state.monthTab === 'entries') {
    if (!entries.length) return renderEmpty('No entries this month', 'Your weekly files will automatically appear here as you add entries.');
    return `<div class="month-list">${sortEntries(entries).map(entry => {
      const meta = ENTRY_META[entry.type] || ENTRY_META.note;
      return `<button class="month-row" data-entry-id="${escapeHTML(entry.id)}"><div class="month-date">${formatDate(parseLocalDate(entry.date), { weekday: 'short', day: 'numeric', month: 'short' })}</div><div class="month-time">${escapeHTML(entry.time || '—')}</div><div class="month-row-title">${escapeHTML(entry.title)}</div><div><span class="type-pill ${meta.className}">${meta.label}</span></div><div class="entry-preview">${escapeHTML(entryPreview(entry))}</div></button>`;
    }).join('')}</div>`;
  }
  const monthWeeks = state.allWeeks.filter(week => {
    const d = parseLocalDate(week.startDate);
    const e = parseLocalDate(week.endDate);
    return (d.getFullYear() === state.cursor.getFullYear() && d.getMonth() === state.cursor.getMonth()) || (e.getFullYear() === state.cursor.getFullYear() && e.getMonth() === state.cursor.getMonth());
  });
  if (state.monthTab === 'highlights') {
    const rows = monthWeeks.flatMap(week => (week.weeklyReflection?.highlights || []).map(text => ({ week: week.week, text })));
    return rows.length ? `<div class="panel"><h2>Highlights</h2>${rows.map(row => `<div class="setting-row"><div>${escapeHTML(row.text)}</div><div class="entity-meta">${escapeHTML(row.week)}</div></div>`).join('')}</div>` : renderEmpty('No highlights yet', 'Use weekly reflections to capture what mattered most.');
  }
  return `<div class="grid-cards">${monthWeeks.map(week => `<div class="entity-card"><div><div class="entity-name">${escapeHTML(week.week)}</div><div class="entity-meta">${(week.weeklyReflection?.outcomes || []).length} outcomes · ${(week.weeklyReflection?.learnings || []).length} learnings</div></div></div>`).join('') || '<div class="panel">No weekly reflections yet.</div>'}</div>`;
}

function renderSearch() {
  const entries = getAllKnownEntries();
  const query = state.search.trim().toLowerCase();
  const filtered = entries.filter(entry => {
    if (state.searchType !== 'all' && entry.type !== state.searchType) return false;
    if (!query) return true;
    const haystack = JSON.stringify(entry).toLowerCase();
    return haystack.includes(query);
  });
  return `<div class="search-toolbar"><div class="search-input-wrap"><span class="search-icon">⌕</span><input id="search-input" value="${escapeHTML(state.search)}" placeholder="Search entries, people, topics, or content…" /></div><div class="filter-row"><select id="search-type"><option value="all">All types</option>${Object.entries(ENTRY_META).map(([key, meta]) => `<option value="${key}" ${state.searchType === key ? 'selected' : ''}>${meta.label}</option>`).join('')}</select></div></div>
    <div class="entity-meta" style="margin-bottom:10px">${filtered.length} result${filtered.length === 1 ? '' : 's'}</div>
    <div class="search-results">${filtered.map(entry => {
      const meta = ENTRY_META[entry.type] || ENTRY_META.note;
      return `<button class="search-result" data-entry-id="${escapeHTML(entry.id)}"><div><div class="search-result-top"><span class="type-pill ${meta.className}">${meta.label}</span><span class="search-result-title">${escapeHTML(entry.title)}</span></div><div class="search-result-preview">${escapeHTML(entryPreview(entry))}</div></div><div class="search-result-date">${escapeHTML(entry.date)}</div></button>`;
    }).join('') || '<div class="panel">No matching entries.</div>'}</div>`;
}

function renderPeople() {
  const counts = new Map();
  getAllKnownEntries().forEach(entry => normalizeList(entry.participants).forEach(person => counts.set(person, (counts.get(person) || 0) + 1)));
  const rows = [...counts.entries()].sort((a,b) => b[1] - a[1]);
  if (!rows.length) return renderEmpty('No people yet', 'People mentioned in meetings and conversations will appear here.', '♙');
  return `<div class="grid-cards">${rows.map(([name,count]) => `<div class="entity-card"><div><div class="entity-name">${escapeHTML(name)}</div><div class="entity-meta">${count} entr${count === 1 ? 'y' : 'ies'}</div></div><button class="ghost-btn" data-search-person="${escapeHTML(name)}">Search</button></div>`).join('')}</div>`;
}

function renderTopics() {
  const counts = new Map();
  getAllKnownEntries().forEach(entry => normalizeList(entry.topics).forEach(topic => counts.set(topic, (counts.get(topic) || 0) + 1)));
  const rows = [...counts.entries()].sort((a,b) => b[1] - a[1]);
  if (!rows.length) return renderEmpty('No topics yet', 'Projects and recurring themes will appear here as you tag entries.', '◇');
  return `<div class="grid-cards">${rows.map(([name,count]) => `<div class="entity-card"><div><div class="entity-name">${escapeHTML(name)}</div><div class="entity-meta">${count} entr${count === 1 ? 'y' : 'ies'}</div></div><button class="ghost-btn" data-search-topic="${escapeHTML(name)}">Search</button></div>`).join('')}</div>`;
}

function renderAnalytics() {
  const year = state.cursor.getFullYear();
  const entries = getAllKnownEntries().filter(entry => parseLocalDate(entry.date).getFullYear() === year);
  const counts = { meeting: 0, work: 0, decision: 0 };
  entries.forEach(entry => { if (entry.type in counts) counts[entry.type] += 1; });
  const months = Array.from({ length: 12 }, (_, month) => entries.filter(entry => parseLocalDate(entry.date).getMonth() === month).length);
  const max = Math.max(...months, 1);
  const currentMonth = new Date().getFullYear() === year ? new Date().getMonth() : -1;
  return `<div class="analytics-grid">
    ${stat(entries.length, 'Total entries')}${stat(counts.meeting, 'Meetings')}${stat(counts.work, 'Work entries')}${stat(counts.decision, 'Decisions')}
  </div><div class="panel chart-panel"><div class="chart-title">Entries per month</div><div class="bar-chart">${months.map((count,index) => `<div class="bar-wrap"><div class="bar ${index === currentMonth ? 'active' : ''}" style="height:${Math.max(2, Math.round((count/max)*155))}px" title="${count} entries"></div><div class="bar-label">${formatDate(new Date(year,index,1), { month: 'short' })}</div></div>`).join('')}</div></div>`;
}

function stat(number, label) { return `<div class="stat-card"><div class="stat-number">${number}</div><div class="stat-label">${label}</div></div>`; }

function renderSettings() {
  const selectedTheme = localStorage.getItem('worklog-theme') || 'system';
  return `<div class="settings-grid"><div class="panel"><h2>Local storage</h2><p>The weekly JSON files in your chosen folder are the source of truth.</p>
    <div class="setting-row"><div><div class="setting-title">Worklog folder</div><div class="setting-copy">${state.directory ? escapeHTML(state.directory.name) : 'No folder selected'}</div></div><div class="button-row"><button class="secondary-btn" id="settings-connect">${state.directory ? 'Change folder' : 'Connect folder'}</button>${state.directory ? '<button class="ghost-btn" id="settings-forget">Forget</button>' : ''}</div></div>
    <div class="setting-row"><div><div class="setting-title">Import / restore JSON</div><div class="setting-copy">Import weekly files or a full backup. Replacements require confirmation; previous versions are retained in history/.</div></div><button class="secondary-btn" id="settings-import" ${state.connected ? '' : 'disabled'}>Import</button></div>
    <div class="setting-row"><div><div class="setting-title">Full backup</div><div class="setting-copy">Download all weekly files as one portable JSON backup.</div></div><button class="secondary-btn" id="settings-backup" ${state.connected ? '' : 'disabled'}>Export backup</button></div>
  </div><div class="panel"><h2>Appearance</h2><p>Choose how WorkLog looks on this browser.</p><div class="field"><label>Theme</label><select id="theme-select"><option value="system" ${selectedTheme==='system'?'selected':''}>System</option><option value="light" ${selectedTheme==='light'?'selected':''}>Light</option><option value="dark" ${selectedTheme==='dark'?'selected':''}>Dark</option></select></div><div class="setting-row"><div><div class="setting-title">Data model</div><div class="setting-copy">Schema version 1 · one JSON file per ISO week</div></div></div><div class="setting-row"><div><div class="setting-title">Keyboard shortcut</div><div class="setting-copy">Press N anywhere outside a form to add an entry.</div></div></div></div></div>`;
}

function getAllKnownEntries() {
  const source = [...state.allWeeks.filter(week => week.week !== state.currentWeek.week), state.currentWeek];
  return sortEntries(source.flatMap(week => week.entries || []));
}

function findEntry(id) {
  const entries = getAllKnownEntries();
  return entries.find(entry => entry.id === id) || state.currentWeek.entries?.find(entry => entry.id === id);
}

function bindRenderedEvents() {
  document.querySelectorAll('[data-entry-id]').forEach(node => node.addEventListener('click', () => openEntryDetail(findEntry(node.dataset.entryId))));
  document.querySelectorAll('[data-add-entry]').forEach(node => node.addEventListener('click', openEntryTypeModal));
  document.querySelectorAll('[data-month-tab]').forEach(node => node.addEventListener('click', () => { state.monthTab = node.dataset.monthTab; render(); }));

  document.querySelector('#search-input')?.addEventListener('input', event => { state.search = event.target.value; renderSearchIntoContentPreservingFocus(); });
  document.querySelector('#search-type')?.addEventListener('change', event => { state.searchType = event.target.value; render(); });
  document.querySelectorAll('[data-search-person]').forEach(btn => btn.addEventListener('click', () => { state.search = btn.dataset.searchPerson; state.view='search'; render(); }));
  document.querySelectorAll('[data-search-topic]').forEach(btn => btn.addEventListener('click', () => { state.search = btn.dataset.searchTopic; state.view='search'; render(); }));

  document.querySelector('#edit-reflection')?.addEventListener('click', openReflectionForm);
  document.querySelector('#settings-connect')?.addEventListener('click', connectFolder);
  document.querySelector('#settings-forget')?.addEventListener('click', async () => { await forgetDirectory(); state.directory=null; state.connected=false; state.allWeeks=[]; render(); });
  document.querySelector('#settings-import')?.addEventListener('click', importFiles);
  document.querySelector('#settings-backup')?.addEventListener('click', async () => {
    try { downloadBackup(await readAllWeeks(state.directory)); toast('Backup exported.'); }
    catch (error) { state.readError = error.message; toast(error.message, true); els.notice.innerHTML = `<div class="notice" role="alert">${escapeHTML(error.message)}</div>`; }
  });
  document.querySelector('#theme-select')?.addEventListener('change', event => { localStorage.setItem('worklog-theme', event.target.value); applyTheme(event.target.value); });
}

function renderSearchIntoContentPreservingFocus() {
  const selection = document.querySelector('#search-input')?.selectionStart;
  els.content.innerHTML = renderSearch();
  bindRenderedEvents();
  const input = document.querySelector('#search-input');
  input?.focus();
  if (selection != null) input?.setSelectionRange(selection, selection);
}

async function importFiles() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json,application/json'; input.multiple = true;
  input.addEventListener('change', async () => {
    try {
      if (!input.files?.length) return;
      const plan = await inspectImportFiles([...input.files]);
      const conflicts = await getImportConflicts(state.directory, plan);
      if (conflicts.length && !confirm(`Replace ${conflicts.length} existing week(s): ${conflicts.join(', ')}? This replaces their entries and reflections. Previous versions will be preserved in history/ or recovery/.`)) return;
      const imported = await applyImport(state.directory, plan, { overwrite: conflicts.length > 0 });
      toast(`Imported ${imported.length} weekly file${imported.length===1?'':'s'}.`);
      await refreshData(true);
    } catch (error) { toast(error.message, true); }
  });
  input.click();
}

function openEntryTypeModal() {
  if (!state.connected) {
    if (state.directory) requestExistingPermission(); else connectFolder();
    return;
  }
  setModal(`<div class="modal-backdrop"><div class="modal modal-sm"><div class="modal-header"><h2>Add an entry</h2><button class="close-btn" data-close-modal>×</button></div><div class="modal-body"><div class="entry-type-grid">${Object.entries(ENTRY_META).map(([type, meta]) => `<button class="entry-type-choice" data-entry-type="${type}"><span class="choice-icon ${meta.className}">${meta.icon}</span><span class="choice-label">${meta.label}</span><span class="choice-description">${meta.description}</span></button>`).join('')}</div></div></div></div>`);
  els.modal.querySelectorAll('[data-entry-type]').forEach(button => button.addEventListener('click', () => openEntryForm(button.dataset.entryType)));
}

function entryFields(type, entry = {}) {
  const base = `<div class="field span-2"><label>Title</label><input name="title" required value="${escapeHTML(entry.title || '')}" placeholder="Short, specific description" /></div>
    <div class="field"><label>Date</label><input type="date" name="date" required value="${escapeHTML(entry.date || toLocalDateInput(state.cursor))}" /></div>
    <div class="field"><label>Time</label><input type="time" name="time" value="${escapeHTML(entry.time || new Date().toTimeString().slice(0,5))}" /></div>
    <div class="field"><label>People</label><input name="participants" value="${escapeHTML(normalizeList(entry.participants).join(', '))}" placeholder="Anna, Johan" /></div>
    <div class="field"><label>Topics</label><input name="topics" value="${escapeHTML(normalizeList(entry.topics).join(', '))}" placeholder="Architecture, Platform" /></div>`;
  const textArea = (name, label, value, help = 'One item per line') => `<div class="field span-2"><label>${label}</label><textarea name="${name}">${escapeHTML(joinLines(value))}</textarea><div class="field-help">${help}</div></div>`;
  const simpleArea = (name, label, value, placeholder='') => `<div class="field span-2"><label>${label}</label><textarea name="${name}" placeholder="${escapeHTML(placeholder)}">${escapeHTML(value || '')}</textarea></div>`;
  if (type === 'meeting') return base + textArea('discussion','Discussion',entry.discussion) + textArea('contribution','My contribution',entry.contribution) + textArea('decisions','Decisions',entry.decisions) + textArea('followUps','Follow-ups',(entry.followUps || []).map(x => `${x.text}${x.reference ? ` | ${x.reference}` : ''}`),'One per line. Optional reference after | e.g. Create spike | ABC-123') + simpleArea('references','References',(entry.references || []).map(x=>x.value).join('\n'),'One Jira key, URL or document reference per line');
  if (type === 'work') return base + simpleArea('summary','What did you do?',entry.summary,'Describe the work in your own words') + textArea('details','Details',entry.details) + simpleArea('outcome','Outcome',entry.outcome,'What changed or became possible?') + simpleArea('references','References',(entry.references || []).map(x=>x.value).join('\n'));
  if (type === 'conversation') return base + simpleArea('summary','Summary',entry.summary,'What was the conversation about?') + textArea('notes','Notes',entry.notes) + textArea('contribution','My contribution',entry.contribution);
  if (type === 'decision') return base + simpleArea('decision','Decision',entry.decision,'What was decided?') + simpleArea('context','Context',entry.context,'What led to this decision?') + simpleArea('rationale','Rationale',entry.rationale,'Why this option?');
  if (type === 'achievement') return base + simpleArea('summary','Achievement',entry.summary,'What did you accomplish?') + simpleArea('impact','Impact',entry.impact,'Why did it matter?') + simpleArea('references','Evidence / references',(entry.references || []).map(x=>x.value).join('\n'));
  return base + simpleArea('content','Note',entry.content,'Anything worth remembering');
}

function openEntryForm(type, existing = null) {
  const meta = ENTRY_META[type];
  const isEdit = Boolean(existing);
  setModal(`<div class="modal-backdrop"><div class="modal"><form id="entry-form"><div class="modal-header"><div><div class="detail-header-meta"><span class="type-pill ${meta.className}">${meta.label}</span></div><h2>${isEdit ? 'Edit entry' : `Add ${meta.label.toLowerCase()}`}</h2></div><button type="button" class="close-btn" data-close-modal>×</button></div><div class="modal-body"><div class="form-grid">${entryFields(type, existing || {})}</div></div><div class="modal-footer">${isEdit ? '<button type="button" class="danger-btn" id="delete-entry">Delete</button>' : '<span></span>'}<div class="modal-footer-right"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button type="submit" class="primary-btn">Save</button></div></div></form></div></div>`);
  document.querySelector('#entry-form').addEventListener('submit', event => saveEntryForm(event, type, existing));
  document.querySelector('#delete-entry')?.addEventListener('click', () => deleteEntry(existing));
}

function referenceFromValue(value) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return { type: 'link', value: trimmed };
  if (/^[A-Z][A-Z0-9]+-\d+$/.test(trimmed)) return { type: 'jira', value: trimmed };
  return { type: 'other', value: trimmed };
}

async function saveEntryForm(event, type, existing) {
  event.preventDefault();
  if (modalBusy) return;
  modalBusy = true;
  const submit = event.currentTarget.querySelector('[type=submit]');
  submit.disabled = true;
  try {
    const fd = new FormData(event.currentTarget);
    const entry = {
      ...(existing || {}),
      id: existing?.id || uid(),
      type,
      date: fd.get('date'),
      time: fd.get('time') || undefined,
      title: String(fd.get('title') || '').trim(),
      participants: normalizeList(fd.get('participants')),
      topics: normalizeList(fd.get('topics'))
    };
    const listFields = ['discussion','contribution','decisions','details','notes'];
    listFields.forEach(key => { if (fd.has(key)) entry[key] = splitLines(fd.get(key)); });
    ['summary','outcome','decision','context','rationale','impact','content'].forEach(key => { if (fd.has(key)) entry[key] = String(fd.get(key) || '').trim(); });
    if (fd.has('followUps')) entry.followUps = splitLines(fd.get('followUps')).map(line => { const [text, reference] = line.split('|').map(v=>v.trim()); const previous = existing?.followUps?.find(item => item.text === text && (item.reference || '') === (reference || '')); return { ...(previous || {}), text, ...(reference ? { reference } : {}) }; });
    if (fd.has('references')) entry.references = splitLines(fd.get('references')).map(referenceFromValue).filter(Boolean);
    if (!entry.title) throw new Error('Title is required.');

    const targetDate = parseLocalDate(entry.date);
    await saveEntry(state.directory, entry, existing);
    modalBusy = false;
    closeModal(true);
    state.cursor = targetDate;
    toast(existing ? 'Entry updated.' : 'Entry saved.');
    await refreshData(true);
  } catch (error) { toast(error.message || 'Could not save entry.', true); }
  finally { modalBusy = false; submit.disabled = false; }
}

async function deleteEntry(entry) {
  if (modalBusy || !entry || !confirm(`Delete “${entry.title}”?`)) return;
  try {
    await removeEntry(state.directory, entry);
    closeModal(true); toast('Entry deleted.'); await refreshData(true);
  } catch (error) { toast(error.message, true); }
}

function openReflectionForm() {
  const date = new Date(state.cursor);
  const previous = structuredClone(state.currentWeek.weeklyReflection);
  setModal(`<div class="modal-backdrop"><div class="modal"><form id="reflection-form"><div class="modal-header"><h2>Weekly reflection · ${escapeHTML(state.currentWeek.week)}</h2><button type="button" class="close-btn" data-close-modal>×</button></div><div class="modal-body"><div class="form-grid">${Object.entries(previous).map(([key, items]) => `<div class="field span-2"><label>${key[0].toUpperCase() + key.slice(1)}</label><textarea name="${key}">${escapeHTML(joinLines(items))}</textarea><div class="field-help">One item per line</div></div>`).join('')}</div></div><div class="modal-footer"><span></span><button type="submit" class="primary-btn">Save reflection</button></div></form></div></div>`);
  document.querySelector('#reflection-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (modalBusy) return;
    modalBusy = true;
    const button = event.currentTarget.querySelector('[type=submit]');
    button.disabled = true;
    const data = new FormData(event.currentTarget);
    try {
      const reflection = Object.fromEntries(Object.keys(previous).map(key => [key, splitLines(data.get(key))]));
      await saveReflection(state.directory, date, reflection, previous);
      modalBusy = false; closeModal(true); toast('Reflection saved.'); await refreshData(true);
    } catch (error) { toast(error.message, true); }
    finally { modalBusy = false; button.disabled = false; }
  });
}

function detailSection(title, content) {
  if (!content || (Array.isArray(content) && !content.length)) return '';
  const body = Array.isArray(content) ? `<ul>${content.map(item => `<li>${escapeHTML(typeof item === 'string' ? item : item.text || '')}</li>`).join('')}</ul>` : `<p>${escapeHTML(content)}</p>`;
  return `<section class="detail-section"><h3>${escapeHTML(title)}</h3>${body}</section>`;
}

function openEntryDetail(entry) {
  if (!entry) return;
  const meta = ENTRY_META[entry.type] || ENTRY_META.note;
  const references = entry.references || [];
  setModal(`<div class="modal-backdrop"><div class="modal modal-sm"><div class="modal-header"><div><div class="detail-header-meta"><span class="type-pill ${meta.className}">${meta.label}</span><span>${escapeHTML(entry.date)}${entry.time ? ` · ${escapeHTML(entry.time)}` : ''}</span></div><h2 class="detail-title">${escapeHTML(entry.title)}</h2></div><button class="close-btn" data-close-modal>×</button></div><div class="modal-body">
    ${normalizeList(entry.participants).length ? `<div class="detail-header-meta"><strong>People:</strong> ${normalizeList(entry.participants).map(escapeHTML).join(', ')}</div>` : ''}
    ${normalizeList(entry.topics).length ? `<div class="detail-tags">${normalizeList(entry.topics).map(t => `<span class="topic-pill">${escapeHTML(t)}</span>`).join('')}</div>` : ''}
    ${detailSection('Discussion',entry.discussion)}${detailSection('My contribution',entry.contribution)}${detailSection('Decisions',entry.decisions)}${detailSection('Summary',entry.summary)}${detailSection('Details',entry.details)}${detailSection('Outcome',entry.outcome)}${detailSection('Decision',entry.decision)}${detailSection('Context',entry.context)}${detailSection('Rationale',entry.rationale)}${detailSection('Impact',entry.impact)}${detailSection('Notes',entry.notes)}${detailSection('Note',entry.content)}
    ${entry.followUps?.length ? `<section class="detail-section"><h3>Follow-ups</h3><ul class="followup-list">${entry.followUps.map(f => `<li class="followup-item ${f.done ? 'done' : ''}"><span>${f.done ? '☑' : '☐'}</span><span>${escapeHTML(f.text)}</span>${f.reference ? `<span class="topic-pill">${escapeHTML(f.reference)}</span>` : ''}</li>`).join('')}</ul></section>` : ''}
    ${references.length ? `<section class="detail-section"><h3>References</h3><div class="detail-tags">${references.map(ref => `<span class="topic-pill">${escapeHTML(ref.value)}</span>`).join('')}</div></section>` : ''}
  </div><div class="modal-footer"><span></span><div class="modal-footer-right"><button class="secondary-btn" data-close-modal>Close</button><button class="primary-btn" id="edit-entry">Edit</button></div></div></div></div>`);
  document.querySelector('#edit-entry')?.addEventListener('click', () => openEntryForm(entry.type, entry));
}

initialize();
