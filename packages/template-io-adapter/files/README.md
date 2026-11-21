# @pulpfixer/io-{{name}}

{{summary}}. A [pf](https://cellars.staging.pangenea.com/) IO adapter add-on: once installed, pipes can read from and write to it.

## Install

```bash
pf plugin install io-{{name}}
pf io adapters                    # {{name}} is listed with where it came from
```

## Use in a pipe

```ts
import { source, sink } from '@pulpfixer/io-{{name}}';

inputs: { rows: source({ path: 'in.ndjson' }) },
outputs: { out: sink({ path: 'out.ndjson' }) },
```

The pipe package depends on `@pulpfixer/io-{{name}}` for the builders; the user installs the add-on with `pf plugin install io-{{name}}`.

## Develop

```bash
pnpm install
pnpm test
pnpm build
pf ps            # publish to cellars (asks first)
```

The rules for writing an adapter are in `AGENTS.md`. The sample in `src/adapter.ts` reads and writes JSON Lines files: replace it with the real thing.
