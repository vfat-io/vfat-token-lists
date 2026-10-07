import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeTags } from './token-tags.mjs';

async function main() {
  const tokenListsDir = process.argv[2] || 'tokenLists';
  const entries = await fs.readdir(tokenListsDir);
  let tagged = 0;
  for (const file of entries.filter(entry => /^\d+\.json$/.test(entry)).sort()) {
    const tokens = JSON.parse(await fs.readFile(path.join(tokenListsDir, file), 'utf8'));
    if (!Array.isArray(tokens)) {
      throw new Error(`${file}: token list must be an array`);
    }
    for (const token of tokens) {
      if (token.tags === undefined) {
        continue;
      }
      const tags = normalizeTags(token.tags, `${file}:${token.address}.tags`);
      if (tags.length === 0 || JSON.stringify(tags) !== JSON.stringify(token.tags)) {
        throw new Error(`${file}:${token.address}: tags must be nonempty, unique, and sorted; omit tags for unclassified tokens`);
      }
      tagged += 1;
    }
  }
  console.log(`Validated tags on ${tagged} tokens`);
}

main().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});
