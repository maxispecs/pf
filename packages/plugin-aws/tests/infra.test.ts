import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildContext } from '@pulpfixer/kit/context';
import { describeDeployment, detectAwsDeployment, scanAwsHints, scopesFor } from '../src/infra.js';
import { json, mkRepo } from './helpers.js';

const WORKFLOW = `
name: deploy
on: { workflow_dispatch: {} }
jobs:
  deploy:
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/deploy
          aws-region: eu-west-1
      - uses: aws-actions/amazon-ecs-deploy-task-definition@v2
        with:
          task-definition: taskdef.json
          service: api
          cluster: web
      - run: docker push 123456789012.dkr.ecr.eu-west-1.amazonaws.com/api:latest
`;

test('an ECS repo: account, region, cluster, service and scopes are read from CI', () => {
  const root = mkRepo({ '.git/HEAD': '', '.github/workflows/deploy-staging.yml': WORKFLOW, 'package.json': json({ name: 'api' }) });
  const h = scanAwsHints(root);
  assert.deepEqual(h.accounts, ['123456789012']);
  assert.deepEqual(h.regions, ['eu-west-1']);
  assert.deepEqual(h.services, ['ecs']);
  assert.deepEqual(h.names.clusters, ['web']);
  assert.deepEqual(h.names.ecsServices, ['api']);
  assert.deepEqual(h.sources, ['.github/workflows/deploy-staging.yml']);
  assert.deepEqual(scopesFor(h.services), ['identity', 'ecs', 'elb', 'cloudwatch', 'logs']);
});

test('serverless, terraform and a task definition add functions, stacks, log groups', () => {
  const root = mkRepo({
    '.git/HEAD': '',
    'serverless.yml': 'service: billing\nprovider:\n  name: aws\n  region: us-east-2\nfunctions:\n  hello:\n    handler: h.main\n',
    'infra/main.tf': 'provider "aws" {\n  region = "us-west-2"\n}\nresource "aws_lambda_function" "x" {\n  function_name = "billing-hello"\n}\nresource "aws_db_instance" "db" {}\n',
    'ops/taskdef.json': json({ family: 'x', containerDefinitions: [{ logConfiguration: { options: { 'awslogs-group': '/ecs/billing' } } }] }),
    'node_modules/pkg/serverless.yml': 'service: ignored\nregion: ap-south-1\n',
  });
  const h = scanAwsHints(root);
  assert.deepEqual(h.regions.sort(), ['us-east-2', 'us-west-2']);
  assert.ok(h.services.includes('lambda') && h.services.includes('rds'));
  assert.deepEqual(h.names.functions, ['billing-hello']);
  assert.deepEqual(h.names.stacks, ['billing']);
  assert.deepEqual(h.names.logGroups, ['/ecs/billing']);
  assert.ok(!h.sources.some((s) => s.startsWith('node_modules')));
});

test('a repo with no AWS files yields no hints, and the summary says so', () => {
  const root = mkRepo({ '.git/HEAD': '', 'package.json': json({ name: 'x' }), 'README.md': 'account 123456789012' });
  const d = detectAwsDeployment(buildContext(root));
  assert.deepEqual(d.hints.accounts, []);
  assert.deepEqual(d.suggestedScopes, ['identity']);
  assert.match(describeDeployment(d).join('\n'), /nothing about this repo's deployment|stack: /);
});

test('deployment includes the staging command and production only when the repo defines it', () => {
  const root = mkRepo({
    '.git/HEAD': '',
    'package.json': json({ name: 'x', scripts: { 'deploy:staging': 'sst deploy --stage staging', 'deploy:production': 'sst deploy --stage prod' } }),
    'sst.config.ts': 'export default { app() { return { region: "eu-central-1" }; } }',
  });
  const d = detectAwsDeployment(buildContext(root));
  assert.match(d.staging[0]!, /run deploy:staging/);
  assert.match(d.production[0]!, /run deploy:production/);
  assert.deepEqual(d.hints.regions, ['eu-central-1']);
  const text = describeDeployment(d).join('\n');
  assert.match(text, /staging deploy: /);
  assert.match(text, /production deploy \(defined by the repo\): /);
});
