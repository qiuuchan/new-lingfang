import { test, expect } from 'vitest';
import {
  TeamPluginPolicyDocumentV1,
  canonicalPackagePolicySurfaceJson,
  EvaluatePluginPolicyRequest,
} from './plugin-governance.ts';

const digest = 'a'.repeat(64);

test('package policy surface canonicalization is stable across input ordering', () => {
  const base = {
    schema_version: 1,
    runtime_type: 'client',
    declared_capabilities: ['net.fetch', 'ui.view'],
    actions: [
      {
        action_id: 'video',
        action_contract_version: '1',
        action_surface_sha256: digest,
        cloud_capable: false,
        previewable: true,
      },
      {
        action_id: 'image',
        action_contract_version: '1',
        action_surface_sha256: digest,
        cloud_capable: true,
        previewable: false,
      },
    ],
    shared_namespaces: [
      { name: 'project', active_schema_version: '1', read: true, write: false },
      { name: 'assets', active_schema_version: '1', read: true, write: true },
    ],
    schedule_eligible: false,
  };
  const reordered = {
    ...base,
    declared_capabilities: [...base.declared_capabilities].reverse(),
    actions: [...base.actions].reverse(),
    shared_namespaces: [...base.shared_namespaces].reverse(),
  };
  expect(canonicalPackagePolicySurfaceJson(base)).toBe(
    canonicalPackagePolicySurfaceJson(reordered)
  );
});

test('high-risk team allow and unbound package allow are rejected', () => {
  const common = {
    schema_version: 1,
    enforcement_mode: 'ENFORCE',
    allowed_source_kinds: [],
    denied_capability_kinds: [],
  };
  expect(
    TeamPluginPolicyDocumentV1.safeParse({
      ...common,
      rules: [
        { rule_id: 'r1', effect: 'ALLOW', operations: ['invoke_action'], target: { kind: 'TEAM' } },
      ],
    }).success
  ).toBe(false);
  expect(
    TeamPluginPolicyDocumentV1.safeParse({
      ...common,
      rules: [
        {
          rule_id: 'r1',
          effect: 'ALLOW',
          operations: ['run_workflow'],
          target: { kind: 'PACKAGE', package_id: 'p1' },
        },
      ],
    }).success
  ).toBe(false);
});

test('required operations are nonempty, unique and sorted', () => {
  const parsed = EvaluatePluginPolicyRequest.parse({
    required_operations: ['web_preview', 'invoke_action', 'invoke_action'],
    resource: {
      team_id: 't1',
      package_id: 'p1',
      release_id: 'r1',
      sha256: digest,
      source_kind: 'API',
      runtime_type: 'client',
      package_policy_surface_sha256: digest,
      declared_capabilities: [],
    },
  });
  expect(parsed.required_operations).toEqual(['invoke_action', 'web_preview']);
  expect(
    EvaluatePluginPolicyRequest.safeParse({ required_operations: [], resource: {} }).success
  ).toBe(false);
});
