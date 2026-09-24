#!/usr/bin/env node
/**
 * The catalogue and the installer must name the same applications.
 *
 * src/app-catalogue.js draws the cards. apps/broker.py holds the recipes. A
 * slug in one and not the other is a customer-visible failure that nothing
 * catches at boot: the card renders, the button works, and the install comes
 * back "there is no such application" — or the recipe sits there unreachable.
 *
 * Cheap enough to run on every deploy, so it does.
 */

const fs = require('node:fs');
const path = require('node:path');

const catalogue = require('../src/app-catalogue');

const brokerPath = path.join(__dirname, '..', 'apps', 'broker.py');
const broker = fs.readFileSync(brokerPath, 'utf8');

// RECIPES = { ... } up to the closing brace, then every quoted key inside it.
const block = broker.match(/^RECIPES = \{([\s\S]*?)^\}/m);
if (!block) {
  console.error('Could not find the RECIPES table in apps/broker.py.');
  process.exit(1);
}
const recipes = new Set([...block[1].matchAll(/^\s*"([a-z0-9-]+)":/gm)].map((m) => m[1]));
const cards = new Set(catalogue.list().map((a) => a.slug));

const missingRecipe = [...cards].filter((s) => !recipes.has(s));
const orphanRecipe = [...recipes].filter((s) => !cards.has(s));

if (!missingRecipe.length && !orphanRecipe.length) {
  console.log(`apps: ${cards.size} in the catalogue, all with a recipe.`);
  process.exit(0);
}
missingRecipe.forEach((s) => console.error(`  card with no recipe: ${s} — clicking Install would fail`));
orphanRecipe.forEach((s) => console.error(`  recipe with no card:  ${s} — nobody can reach it`));
process.exit(1);
