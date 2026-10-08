/**
 * (wave 3, item 8) The approval loop the prompts teach is the one the runtime implements: a tool call that needs approval
 * returns approval_required, Hypertest files the digest-bound approval for exactly that call and the work waits for the
 * human decision. No role is told to file its own approval for an action (an agent-filed action approval authorizes
 * nothing), and roles that only ever need approvals for actions do not hold request_approval at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_ROLES, toolPermitted } from '../src/index.ts';

const role = (name: string) => BUILTIN_ROLES.find((r) => r.role === name)!;

test('every role prompt teaches the real approval loop (approval_required → wait for the human decision; never file your own)', () => {
  for (const r of BUILTIN_ROLES) {
    assert.match(r.systemPrompt, /An `approval_required` call awaits a human decision Hypertest filed for exactly that call; never file your own approval or re-issue it differently/, r.role);
  }
});

test('the environment operator and the fixer no longer request approvals for their actions', () => {
  for (const name of ['environment', 'fixer']) {
    const r = role(name);
    assert.equal(toolPermitted(r.toolPolicy, 'request_approval'), false, `${name} does not hold request_approval`);
    assert.doesNotMatch(r.systemPrompt, /request_approval/, `${name} prompt never tells it to request an approval`);
  }
  const env = role('environment').systemPrompt;
  assert.match(env, /Call the tool exactly as specified: when the policy requires approval the call returns approval_required — Hypertest files a digest-bound approval for exactly that call and your work waits for the human decision/);
  assert.match(env, /Do not request an approval yourself for an action/);
  const fixer = role('fixer').systemPrompt;
  assert.match(fixer, /returns approval_required: Hypertest files the approval for exactly that change and your work waits for the human decision\. Do not request an approval yourself for it/);
  assert.match(fixer, /If the objective does not state that the fix is authorised, do not modify code: finish with status blocked/);
});

test('roles that keep request_approval use it only for decisions that are not tool calls', () => {
  for (const r of BUILTIN_ROLES.filter((x) => toolPermitted(x.toolPolicy, 'request_approval'))) {
    assert.doesNotMatch(r.systemPrompt, /`request_approval` when a step needs human sign-off \(destructive environment action, product fix/, r.role);
    assert.doesNotMatch(r.systemPrompt, /call `request_approval` with the action/, r.role);
  }
  assert.match(role('lead').systemPrompt, /`request_approval` only for decisions that are not tool calls \(oracle or test change, budget, manual review\)/);
});
