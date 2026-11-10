import fs from 'node:fs';
import path from 'node:path';
import type { Context } from '@pulpfixer/kit/context';
import { detectProduction, detectStaging } from '@pulpfixer/kit/detect/deploy';
import { formatCmd, type Cmd } from '@pulpfixer/kit/exec';

/**
 * What a repo says about where and how it deploys on AWS, read from its own files (CI workflows,
 * CDK/SAM/Serverless/SST config, Terraform, task definitions, deploy scripts). Nothing is run and
 * nothing leaves the machine. Secrets are never looked for: only account ids, regions, resource
 * names and which AWS services the repo uses. The result is a set of hints, not facts: the user
 * confirms the profile, and pf checks the account before it reads anything.
 */

export type AwsService = 'ecs' | 'lambda' | 'ec2' | 'rds' | 'elb' | 's3' | 'cloudformation';

export interface AwsNames {
  clusters: string[];
  ecsServices: string[];
  functions: string[];
  stacks: string[];
  logGroups: string[];
}

export interface AwsHints {
  accounts: string[];
  regions: string[];
  services: AwsService[];
  names: AwsNames;
  /** Repo-relative files the hints came from. */
  sources: string[];
}

export interface AwsDeployment {
  root: string;
  stacks: string[];
  /** What `pf deploy staging` would run, as printable commands with their source. */
  staging: string[];
  /** What the repo itself defines for production (never guessed). */
  production: string[];
  skipped: string[];
  hints: AwsHints;
  /** Scopes that match the services found, `identity` first. Advice only: profile limits still apply. */
  suggestedScopes: string[];
}

export const SERVICE_SCOPES: Record<AwsService, string[]> = {
  ecs: ['ecs', 'elb', 'cloudwatch', 'logs'],
  lambda: ['lambda-metadata', 'cloudwatch', 'logs'],
  ec2: ['ec2', 'elb', 'cloudwatch', 'ssm-metadata'],
  rds: ['rds', 'cloudwatch'],
  elb: ['elb', 'cloudwatch'],
  s3: ['s3-metadata'],
  cloudformation: ['cloudformation'],
};

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.terraform', 'vendor', 'coverage', 'cdk.out', 'tmp', 'target', '.venv', 'venv', '__pycache__', '.turbo',
]);
const MAX_DEPTH = 4;
const MAX_FILES = 400;
const MAX_BYTES = 256 * 1024;
const MAX_NAMES = 10;

const ACCOUNT = /\b\d{12}\b/;
const REGION_RE = '[a-z]{2}(?:-[a-z]+)+-\\d';
const NAME = '[A-Za-z0-9][\\w.${}/-]{0,127}';

function isInteresting(rel: string, name: string, text: () => string): boolean {
  const lower = name.toLowerCase();
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(rel)) return true;
  if (['cdk.json', 'cdk.context.json', 'samconfig.toml', 'sst.config.ts', 'pulumi.yaml', 'ecs-params.yml', '.gitlab-ci.yml', 'bitbucket-pipelines.yml', 'dockerfile'].includes(lower)) return true;
  if (/^(appspec|buildspec)\.ya?ml$/.test(lower)) return true;
  if (/^serverless\.(ya?ml|json|ts|js)$/.test(lower)) return true;
  if (/\.tf$/.test(lower)) return true;
  if (/task[-_]?def(inition)?[^/]*\.json$/.test(lower)) return true;
  if (/^deploy[\w.-]*\.sh$/.test(lower)) return true;
  if (/(^|\/)copilot\/.+\/manifest\.ya?ml$/.test(rel)) return true;
  if (/(^|\/)\.elasticbeanstalk\/config\.ya?ml$/.test(rel)) return true;
  if (/^template\.(ya?ml|json)$/.test(lower)) return /AWSTemplateFormatVersion|AWS::Serverless/.test(text());
  return false;
}

function walk(root: string): { rel: string; text: string }[] {
  const found: { rel: string; text: string }[] = [];
  const visit = (dir: string, depth: number): void => {
    if (found.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= MAX_FILES) return;
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name)) visit(full, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      let cached: string | null = null;
      const text = (): string => {
        if (cached !== null) return cached;
        try {
          cached = fs.statSync(full).size > MAX_BYTES ? '' : fs.readFileSync(full, 'utf8');
        } catch {
          cached = '';
        }
        return cached;
      };
      if (isInteresting(rel, e.name, text)) found.push({ rel, text: text() });
    }
  };
  visit(root, 0);
  return found;
}

function add(into: Set<string>, value: string | undefined): void {
  const v = value?.trim().replace(/^["']|["',;]+$/g, '');
  if (v) into.add(v);
}

function grab(text: string, re: RegExp, group: number, into: Set<string>): void {
  for (const m of text.matchAll(re)) add(into, m[group]);
}

const SERVICE_PATTERNS: [AwsService, RegExp][] = [
  ['ecs', /\b(aws_ecs_|AWS::ECS::|amazon-ecs-|ecs update-service|ecs run-task|ecs-params|fargate|aws-cdk-lib\/aws-ecs|copilot)\b|\/copilot\/|ecs_patterns|ecs\.Cluster|ecs\.FargateService/i],
  ['lambda', /\b(aws_lambda_function|AWS::Lambda::|AWS::Serverless::Function|lambda update-function|aws-lambda-deploy|aws-cdk-lib\/aws-lambda|lambda\.Function)\b|^\s*provider:\s*\n\s*name:\s*aws/im],
  ['ec2', /\b(aws_instance|aws_autoscaling_group|aws_launch_template|AWS::EC2::Instance|AWS::AutoScaling::|codedeploy|create-deployment|elasticbeanstalk|aws_elastic_beanstalk|autoscaling start-instance-refresh)\b|appspec/i],
  ['rds', /\b(aws_db_instance|aws_rds_cluster|AWS::RDS::|aws-cdk-lib\/aws-rds|rds\.DatabaseInstance|rds\.DatabaseCluster)\b/i],
  ['elb', /\b(aws_lb\b|aws_alb|aws_lb_target_group|AWS::ElasticLoadBalancingV2::|elbv2|ApplicationLoadBalancer|aws-cdk-lib\/aws-elasticloadbalancingv2)\b/i],
  ['s3', /\b(aws_s3_bucket|AWS::S3::Bucket|s3 sync|s3 cp|s3api|aws-cdk-lib\/aws-s3)\b/i],
  ['cloudformation', /\b(AWSTemplateFormatVersion|AWS::Serverless-|cloudformation (deploy|create-stack|update-stack)|sam (deploy|build)|cdk (deploy|synth)|aws-cdk-lib|aws-actions\/aws-cloudformation|serverless deploy|sst deploy)\b|samconfig/i],
];

/** Read the hints out of a repo's files. */
export function scanAwsHints(root: string): AwsHints {
  const accounts = new Set<string>();
  const regions = new Set<string>();
  const services = new Set<AwsService>();
  const clusters = new Set<string>();
  const ecsServices = new Set<string>();
  const functions = new Set<string>();
  const stacks = new Set<string>();
  const logGroups = new Set<string>();
  const sources: string[] = [];

  for (const { rel, text } of walk(root)) {
    if (!text) continue;
    const before = accounts.size + regions.size + services.size + clusters.size + ecsServices.size + functions.size + stacks.size + logGroups.size;

    grab(text, new RegExp(`arn:aws[\\w-]*:[a-z0-9-]*:[a-z0-9-]*:(${ACCOUNT.source}):`, 'g'), 1, accounts);
    grab(text, new RegExp(`\\b(${ACCOUNT.source})\\.dkr\\.ecr\\.(${REGION_RE})\\.amazonaws\\.com`, 'g'), 1, accounts);
    grab(text, new RegExp(`\\b${ACCOUNT.source}\\.dkr\\.ecr\\.(${REGION_RE})\\.amazonaws\\.com`, 'g'), 1, regions);
    grab(text, new RegExp(`account[_-]?id["']?\\s*[:=]\\s*["']?(${ACCOUNT.source})\\b`, 'gi'), 1, accounts);
    grab(text, new RegExp(`arn:aws[\\w-]*:[a-z0-9-]*:(${REGION_RE}):\\d{12}:`, 'g'), 1, regions);
    grab(text, new RegExp(`(?:aws-region|AWS_(?:DEFAULT_)?REGION|region)["']?\\s*[:=]\\s*["']?(${REGION_RE})\\b`, 'gi'), 1, regions);
    grab(text, new RegExp(`--region[= ]\\s*["']?(${REGION_RE})\\b`, 'g'), 1, regions);

    grab(text, new RegExp(`--cluster[= ]\\s*["']?(${NAME})`, 'g'), 1, clusters);
    grab(text, new RegExp(`\\bcluster(?:[_-]?name)?["']?\\s*[:=]\\s*["']?(${NAME})`, 'gi'), 1, clusters);
    grab(text, new RegExp(`--service[= ]\\s*["']?(${NAME})`, 'g'), 1, ecsServices);
    if (/amazon-ecs-deploy-task-definition|ecs update-service|aws_ecs_service|AWS::ECS::Service/i.test(text)) {
      grab(text, new RegExp(`^\\s*-?\\s*service(?:[_-]?name)?["']?\\s*[:=]\\s*["']?(${NAME})`, 'gim'), 1, ecsServices);
    }
    grab(text, new RegExp(`--function-name[= ]\\s*["']?(${NAME})`, 'g'), 1, functions);
    grab(text, new RegExp(`\\bfunction[_-]?name["']?\\s*[:=]\\s*["']?(${NAME})`, 'gi'), 1, functions);
    grab(text, new RegExp(`--stack-name[= ]\\s*["']?(${NAME})`, 'g'), 1, stacks);
    grab(text, new RegExp(`\\bstack[_-]?name["']?\\s*[:=]\\s*["']?(${NAME})`, 'gi'), 1, stacks);
    if (/^serverless\./i.test(path.basename(rel))) grab(text, new RegExp(`^service:\\s*["']?(${NAME})`, 'gm'), 1, stacks);
    grab(text, /["'`](\/(?:aws|ecs)\/[\w/.${}#-]+)["'`]/g, 1, logGroups);
    grab(text, new RegExp(`(?:awslogs-group|log[_-]?group(?:[_-]?name)?)["']?\\s*[:=]\\s*["']?(\\/[\\w/.\${}#-]+)`, 'gi'), 1, logGroups);

    for (const [svc, re] of SERVICE_PATTERNS) if (re.test(text)) services.add(svc);

    const after = accounts.size + regions.size + services.size + clusters.size + ecsServices.size + functions.size + stacks.size + logGroups.size;
    if (after > before) sources.push(rel);
  }

  const cap = (s: Set<string>): string[] => [...s].slice(0, MAX_NAMES);
  return {
    accounts: cap(accounts),
    regions: cap(regions),
    services: [...services],
    names: { clusters: cap(clusters), ecsServices: cap(ecsServices), functions: cap(functions), stacks: cap(stacks), logGroups: cap(logGroups) },
    sources: sources.slice(0, 30),
  };
}

/** Scopes that fit the services, `identity` first, without duplicates. */
export function scopesFor(services: AwsService[]): string[] {
  return [...new Set(['identity', ...services.flatMap((s) => SERVICE_SCOPES[s])])];
}

/** How this repo deploys: staging and production targets, plus the AWS hints in its files. */
export function detectAwsDeployment(ctx: Context): AwsDeployment {
  const root = ctx.repo?.root ?? ctx.workdir;
  const staging = detectStaging(ctx);
  const production = detectProduction(ctx);
  const hints = scanAwsHints(root);
  const show = (steps: { cmd: Cmd; source: string }[]): string[] => steps.map((s) => `${formatCmd(s.cmd)} (${s.source})`);
  return {
    root,
    stacks: ctx.stacks.map((s) => s.label),
    staging: show(staging.steps),
    production: show(production.steps),
    skipped: staging.skipped,
    hints,
    suggestedScopes: scopesFor(hints.services),
  };
}

const list = (label: string, items: string[]): string[] => (items.length ? [`${label}: ${items.join(', ')}`] : []);

/** Plain-text summary for the agent's persona, the `pf_aws_context` tool and the command. */
export function describeDeployment(d: AwsDeployment): string[] {
  const h = d.hints;
  const lines = [
    ...list('stack', d.stacks),
    ...list('staging deploy', d.staging),
    ...list('production deploy (defined by the repo)', d.production),
    ...list('AWS accounts in the repo', h.accounts),
    ...list('regions in the repo', h.regions),
    ...list('AWS services in use', h.services),
    ...list('ECS clusters', h.names.clusters),
    ...list('ECS services', h.names.ecsServices),
    ...list('Lambda functions', h.names.functions),
    ...list('CloudFormation stacks', h.names.stacks),
    ...list('log groups', h.names.logGroups),
    ...list('hints found in', h.sources.slice(0, 6)),
  ];
  if (h.services.length) lines.push(`suggested scopes: ${d.suggestedScopes.join(', ')}`);
  if (lines.length === 0) lines.push('nothing about this repo\'s deployment could be read from its files');
  return lines;
}