#!/usr/bin/env node
// Extrait la section d'une version donnée depuis CHANGELOG.md (format Keep a Changelog),
// en excluant la ligne d'en-tête "## [version] — date" mais en gardant tagline + sous-sections.
// Usage: node scripts/extract-changelog.mjs <version>

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const version = process.argv[2];
if (!version) {
  console.error('Usage: node scripts/extract-changelog.mjs <version>');
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const changelogPath = path.join(repoRoot, 'CHANGELOG.md');
const changelog = readFileSync(changelogPath, 'utf8');

const lines = changelog.split('\n');
const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const headerRegex = new RegExp(`^## \\[${escapedVersion}\\]`);

const startIndex = lines.findIndex((line) => headerRegex.test(line));
if (startIndex === -1) {
  console.error(`Aucune section "## [${version}]" trouvée dans CHANGELOG.md`);
  process.exit(1);
}

let endIndex = lines.findIndex((line, i) => i > startIndex && /^## \[/.test(line));
if (endIndex === -1) endIndex = lines.length;

const sectionLines = lines.slice(startIndex + 1, endIndex);

// Supprime les lignes vides en tête/fin sans perdre la structure interne.
while (sectionLines.length && sectionLines[0].trim() === '') sectionLines.shift();
while (sectionLines.length && sectionLines[sectionLines.length - 1].trim() === '') sectionLines.pop();

// Promeut la tagline en titre H2 si c'est un simple paragraphe (comme fait
// manuellement pour la v0.1.0-alpha.1), pour garder le même style de page.
if (sectionLines[0] && !/^[#-]/.test(sectionLines[0])) {
  sectionLines[0] = `## ${sectionLines[0].replace(/\.$/, '')}`;
}

process.stdout.write(sectionLines.join('\n') + '\n');
