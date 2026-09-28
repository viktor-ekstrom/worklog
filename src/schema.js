import { getISOWeekInfo, parseLocalDate } from './utils.js';

export const CURRENT_SCHEMA_VERSION = 1;
export const ENTRY_TYPES = new Set(['meeting', 'work', 'conversation', 'decision', 'achievement', 'note']);
const LIST_FIELDS = ['topics', 'tags', 'participants', 'discussion', 'notes', 'contribution', 'decisions', 'details'];
const REF_TYPES = new Set(['jira', 'link', 'document', 'other']);
const TOP_LEVEL_FIELDS = new Set(['schemaVersion', 'week', 'startDate', 'endDate', 'entries', 'weeklyReflection']);
const REFLECTION_FIELDS = ['highlights', 'outcomes', 'challenges', 'learnings'];

export class SchemaValidationError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'SchemaValidationError';
    this.issues = issues;
  }
}

function clone(value) {
  return globalThis.structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const parsed = parseLocalDate(value);
  return Number.isFinite(parsed.getTime()) &&
    parsed.getFullYear() === Number(value.slice(0, 4)) &&
    parsed.getMonth() + 1 === Number(value.slice(5, 7)) &&
    parsed.getDate() === Number(value.slice(8, 10));
}

function validateStringList(value, path, issues) {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array.`);
    return;
  }
  value.forEach((item, index) => {
    if (typeof item !== 'string') issues.push(`${path}[${index}] must be a string.`);
  });
}

function migrateV0ToV1(input) {
  const week = clone(input);
  week.schemaVersion = 1;
  week.entries = Array.isArray(week.entries) ? week.entries : [];
  week.weeklyReflection = {
    highlights: [], outcomes: [], challenges: [], learnings: [],
    ...(isObject(week.weeklyReflection) ? week.weeklyReflection : {})
  };
  for (const field of REFLECTION_FIELDS) {
    if (!Array.isArray(week.weeklyReflection[field])) week.weeklyReflection[field] = [];
  }
  return week;
}

const MIGRATIONS = new Map([[0, migrateV0ToV1]]);

export function migrateWeek(input) {
  if (!isObject(input)) throw new SchemaValidationError('Weekly data must be a JSON object.');
  let week = clone(input);
  let version = week.schemaVersion == null ? 0 : Number(week.schemaVersion);
  if (!Number.isInteger(version) || version < 0) throw new SchemaValidationError('schemaVersion must be a non-negative integer.');
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new SchemaValidationError(`This file uses schema version ${version}, but this WorkLog supports up to version ${CURRENT_SCHEMA_VERSION}.`);
  }
  while (version < CURRENT_SCHEMA_VERSION) {
    const migration = MIGRATIONS.get(version);
    if (!migration) throw new SchemaValidationError(`No migration exists from schema version ${version}.`);
    week = migration(week);
    version = Number(week.schemaVersion);
  }
  return week;
}

export function validateWeek(input) {
  const issues = [];
  if (!isObject(input)) return { valid: false, issues: ['Weekly data must be a JSON object.'] };

  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_FIELDS.has(key)) issues.push(`Unknown top-level field: ${key}.`);
  }
  if (input.schemaVersion !== CURRENT_SCHEMA_VERSION) issues.push(`schemaVersion must be ${CURRENT_SCHEMA_VERSION}.`);
  if (!/^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/.test(String(input.week || ''))) issues.push('week must use YYYY-Www format with week 01–53.');
  if (!isValidDateString(input.startDate)) issues.push('startDate must be a valid YYYY-MM-DD date.');
  if (!isValidDateString(input.endDate)) issues.push('endDate must be a valid YYYY-MM-DD date.');

  if (isValidDateString(input.startDate) && /^\d{4}-W\d{2}$/.test(String(input.week || ''))) {
    const info = getISOWeekInfo(parseLocalDate(input.startDate));
    if (info.key !== input.week) issues.push(`startDate belongs to ${info.key}, not ${input.week}.`);
    if (info.startDate !== input.startDate) issues.push('startDate must be the Monday of the ISO week.');
    if (info.endDate !== input.endDate) issues.push('endDate must be the Sunday of the ISO week.');
  }

  if (!Array.isArray(input.entries)) {
    issues.push('entries must be an array.');
  } else {
    const ids = new Set();
    input.entries.forEach((entry, index) => {
      const path = `entries[${index}]`;
      if (!isObject(entry)) { issues.push(`${path} must be an object.`); return; }
      if (typeof entry.id !== 'string' || !entry.id.trim()) issues.push(`${path}.id is required.`);
      else if (ids.has(entry.id)) issues.push(`${path}.id duplicates another entry id.`);
      else ids.add(entry.id);
      if (!ENTRY_TYPES.has(entry.type)) issues.push(`${path}.type is invalid.`);
      if (!isValidDateString(entry.date)) issues.push(`${path}.date must be a valid YYYY-MM-DD date.`);
      else if (/^\d{4}-W\d{2}$/.test(String(input.week || '')) && getISOWeekInfo(parseLocalDate(entry.date)).key !== input.week) {
        issues.push(`${path}.date does not belong to ${input.week}.`);
      }
      if (entry.time != null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(entry.time))) issues.push(`${path}.time must use HH:MM.`);
      if (typeof entry.title !== 'string' || !entry.title.trim()) issues.push(`${path}.title is required.`);
      for (const field of LIST_FIELDS) if (entry[field] != null) validateStringList(entry[field], `${path}.${field}`, issues);
      if (entry.followUps != null) {
        if (!Array.isArray(entry.followUps)) issues.push(`${path}.followUps must be an array.`);
        else entry.followUps.forEach((followUp, i) => {
          if (!isObject(followUp) || typeof followUp.text !== 'string' || !followUp.text.trim()) issues.push(`${path}.followUps[${i}].text is required.`);
          if (followUp?.done != null && typeof followUp.done !== 'boolean') issues.push(`${path}.followUps[${i}].done must be boolean.`);
        });
      }
      if (entry.references != null) {
        if (!Array.isArray(entry.references)) issues.push(`${path}.references must be an array.`);
        else entry.references.forEach((reference, i) => {
          if (!isObject(reference) || !REF_TYPES.has(reference.type) || typeof reference.value !== 'string' || !reference.value.trim()) {
            issues.push(`${path}.references[${i}] is invalid.`);
          }
        });
      }
    });
  }

  if (!isObject(input.weeklyReflection)) issues.push('weeklyReflection must be an object.');
  else {
    for (const key of Object.keys(input.weeklyReflection)) {
      if (!REFLECTION_FIELDS.includes(key)) issues.push(`Unknown weeklyReflection field: ${key}.`);
    }
    for (const field of REFLECTION_FIELDS) validateStringList(input.weeklyReflection[field], `weeklyReflection.${field}`, issues);
  }

  return { valid: issues.length === 0, issues };
}

export function normalizeWeek(input, source = 'Weekly file') {
  const migrated = migrateWeek(input);
  const result = validateWeek(migrated);
  if (!result.valid) throw new SchemaValidationError(`${source} is not valid WorkLog data.`, result.issues);
  return migrated;
}
