import { test, expect } from 'vitest';
import {
  WorkflowPreflightResponse,
  WorkflowRunCreateRequest,
  WorkflowRunDetailResponse,
  WorkflowRunListResponse,
  WorkflowUpgradeSuggestionResponse,
} from './plugin-workflow.ts';

const digest = (character) => character.repeat(64);
const target = {
  package_id: 'package-image',
  release_id: 'release-image',
  sha256: digest('a'),
  action_id: 'generate',
  action_contract_version: '1.0.0',
  action_surface_sha256: digest('b'),
};
const plan = {
  plan_version: '1',
  workflow_release_id: 'workflow-release',
  workflow_release_sha256: digest('c'),
  definition_sha256: digest('d'),
  execution_target: 'DESKTOP',
  execution_scope: 'PRODUCTION',
  max_parallelism: 1,
  nodes: [
    {
      node_id: 'image',
      declared_version_range: '^1.0.0',
      target,
      depends_on: [],
      input_bindings: [],
      retry_limit: 0,
      execution_semantics: 'read_only',
      cloud_capable: true,
    },
  ],
  output_bindings: [],
  desktop_executor: { session_id: 'session-1', inventory_sha256: digest('e') },
};
const summary = {
  id: 'run-1',
  workflow_release_id: 'workflow-release',
  root_run_id: null,
  parent_step_attempt_id: null,
  execution_target: 'DESKTOP',
  execution_scope: 'PRODUCTION',
  trigger_kind: 'MANUAL',
  status: 'RUNNING',
  plan_sha256: digest('f'),
  attempt_counts: {
    pending: 0,
    ready: 1,
    running: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    canceled: 0,
  },
  deadline_at: '2099-01-01T00:00:00.000Z',
  result_retain_until: '2099-01-08T00:00:00.000Z',
  created_at: '2026-07-16T00:00:00.000Z',
  started_at: '2026-07-16T00:00:00.000Z',
  completed_at: null,
  error: null,
};

test('workflow run create request owns the public snake_case boundary', () => {
  expect(
    WorkflowRunCreateRequest.parse({
      workflow_release_id: 'workflow-release',
      sha256: digest('c'),
      execution_target: 'DESKTOP',
      input: {},
      idempotency_key: 'key-1',
      deadline_at: '2099-01-01T00:00:00.000Z',
    }).execution_scope
  ).toBe('PRODUCTION');
  expect(() =>
    WorkflowRunCreateRequest.parse({
      workflow_release_id: 'workflow-release',
      sha256: digest('c'),
      execution_target: 'DESKTOP',
      input: {},
      idempotency_key: 'key-1',
      deadline_at: '2099-01-01T00:00:00.000Z',
      caller_id: 'untrusted-page',
    })
  ).toThrow();
  expect(() =>
    WorkflowRunCreateRequest.parse({
      workflow_release_id: 'workflow-release',
      sha256: digest('c'),
      execution_target: 'DESKTOP',
      input: {},
      idempotency_key: 'key-1',
      deadline_at: '2099-01-01T00:00:00.000Z',
      preview: true,
    })
  ).toThrow();
});

test('workflow detail, list and preflight DTOs expose only explicit fields', () => {
  const attempt = {
    id: 'attempt-1',
    run_id: 'run-1',
    node_id: 'image',
    full_node_path: 'image',
    attempt_number: 0,
    status: 'READY',
    target,
    execution_semantics: 'read_only',
    retry_limit: 0,
    action_invocation_id: null,
    request_idempotency_key: 'request-1',
    effect_idempotency_key: null,
    output: null,
    created_at: '2026-07-16T00:00:00.000Z',
    started_at: null,
    completed_at: null,
    error: null,
  };
  expect(
    WorkflowRunDetailResponse.parse({
      run: { ...summary, input: {}, output: null, plan, attempts: [attempt] },
    }).run.plan.plan_version
  ).toBe('1');
  expect(
    WorkflowRunListResponse.parse({ runs: [summary], next_cursor: null }).runs[0].attempt_counts
  ).toEqual(summary.attempt_counts);
  expect(
    WorkflowPreflightResponse.parse({
      eligible: true,
      workflow_release_id: 'workflow-release',
      execution_target: 'DESKTOP',
      execution_scope: 'PRODUCTION',
      plan,
      diagnostics: [],
    }).eligible
  ).toBe(true);
  expect(() =>
    WorkflowRunDetailResponse.parse({
      run: {
        ...summary,
        input: {},
        output: null,
        plan,
        attempts: [attempt],
        authorization_decision: { secret: true },
      },
    })
  ).toThrow();
});

test('workflow upgrade suggestions are exact advisory targets and cannot carry mutation instructions', () => {
  const response = WorkflowUpgradeSuggestionResponse.parse({
    workflow_release_id: 'workflow-release',
    workflow_release_sha256: digest('c'),
    suggestions: [
      {
        node_id: 'image',
        declared_version_range: '^1.0.0',
        current_version: '1.0.0',
        current_target: target,
        suggested_version: '1.2.0',
        suggested_target: {
          ...target,
          release_id: 'release-image-2',
          sha256: digest('9'),
          action_surface_sha256: digest('8'),
        },
        reason: 'compatible exact release; publish a new workflow version',
      },
    ],
  });
  expect(response.suggestions[0].suggested_target.release_id).toBe('release-image-2');
  expect(() =>
    WorkflowUpgradeSuggestionResponse.parse({ ...response, auto_apply: true })
  ).toThrow();
});
