import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverSkills, parseSkillFile, shortDescription } from '../src/skills/discover.js';
import { agentPrompt } from '../src/skills/run.js';
import { mkRepo } from './helpers.js';

test('parses plain, quoted and folded frontmatter', () => {
  const s = parseSkillFile(`---\nname: ver\ndescription: "Adds versioning. Use when asked."\nmetadata:\n  version: "1.3.0"\n---\n# x`, 'fallback');
  assert.equal(s.name, 'ver');
  assert.equal(s.description, 'Adds versioning. Use when asked.');
  assert.equal(s.version, '1.3.0');
  const folded = parseSkillFile(`---\nname: x\ndescription: >\n  first line\n  second line\n---\n`, 'f');
  assert.equal(folded.description, 'first line second line');
  assert.equal(parseSkillFile('no frontmatter', 'dirname').name, 'dirname');
});

test('discovers skills in order, de-duplicates by name, scans nested folders', () => {
  const home = mkRepo({
    '.agents/skills/alpha/SKILL.md': '---\nname: alpha\ndescription: From agents.\n---\n',
    '.claude/skills/alpha/SKILL.md': '---\nname: alpha\ndescription: From claude.\n---\n',
    '.claude/skills/synced/uuid/beta/SKILL.md': '---\nname: beta\ndescription: Nested.\n---\n',
  });
  const repo = mkRepo({ '.agents/skills/gamma/SKILL.md': '---\nname: gamma\ndescription: Repo.\n---\n' });
  const skills = discoverSkills(repo, {}, home, null, null);
  assert.deepEqual(skills.map((s) => s.name), ['alpha', 'beta', 'gamma']);
  assert.equal(skills.find((s) => s.name === 'alpha')!.description, 'From agents.');
});

test('short descriptions use the first sentence and are capped', () => {
  assert.equal(shortDescription('One. Two.'), 'One.');
  assert.ok(shortDescription('x'.repeat(200)).length <= 70);
});

test('agent prompts: slash form for cursor-agent and claude, plain for codex', () => {
  assert.equal(agentPrompt('claude', 'save', ['auth', 'refactor']), '/save auth refactor');
  assert.equal(agentPrompt('cursor-agent', 'bp', []), '/bp');
  assert.equal(agentPrompt('codex', 'bp', []), 'Use the bp skill.');
});
