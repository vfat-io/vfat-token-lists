import { readFileSync } from 'node:fs';

export const tagDefinitions = JSON.parse(readFileSync(new URL('../tags.json', import.meta.url), 'utf8'));

export function normalizeTags(tags, context = 'tags') {
  if (!Array.isArray(tags)) {
    throw new Error(`${context} must be an array`);
  }
  for (const tag of tags) {
    if (typeof tag !== 'string' || !Object.prototype.hasOwnProperty.call(tagDefinitions, tag)) {
      throw new Error(`${context}: unknown tag ${JSON.stringify(tag)}`);
    }
  }
  return [...new Set(tags)].sort();
}
