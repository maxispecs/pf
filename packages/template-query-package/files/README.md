# @pulpfixer/query-{{name}}

{{summary}}. A [pf](https://cellars.staging.pangenea.com/) query package: `pf {{name}}`.

## Install

Needs pf and the clearance role on cellars (without it the package reads as missing).

```bash
pf plugin install query-{{name}}
pf plugin install db-{{driver}}                  # the driver, unless it is built in (sqlite)
pf db add {{connection}} --driver {{driver}}     # the connection it uses, with your own credentials
```

## Use

```bash
pf {{name}}                    # lists the queries and their flags
pf {{name}} ping               # a table
pf {{name}} ping --json        # or --csv, for a pipe
pf {{name}} ping --db other    # another pf db connection
```

## Develop

```bash
pnpm install
pnpm test        # fake driver, no database
pnpm build
pf ps            # publish to cellars (asks first)
```

The rules for writing queries are in `AGENTS.md`.
