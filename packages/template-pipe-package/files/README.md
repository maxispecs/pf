# @pulpfixer/pipe-{{name}}

{{summary}}. A [pf](https://cellars.staging.pangenea.com/) pipe package: `pf {{name}}`.

## Install

Needs pf and the clearance role on cellars (without it the package reads as missing).

```bash
pf plugin install pipe-{{name}}
pf db add {{connection}}                          # the connection it uses, with your own credentials (when an end is a database)
```

## Use

```bash
pf {{name}}                                       # lists the pipes and their flags
pf {{name}} copy --from <from> --to <to>          # asks before it writes
pf {{name}} copy --from <from> --to <to> --dry-run # reads, shows what it would write
pf {{name}} copy --from <from> --to <to> --yes    # no question (needed without a terminal)
```

## Develop

```bash
pnpm install
pnpm test        # memory adapter, fake driver and temp files, no database
pnpm build
pf ps            # publish to cellars (asks first)
```

The rules for writing pipes are in `AGENTS.md`.
