# pf art

Pictures pf prints for a command. Drop `.ansi` files here and say which command shows which in `art.json`.

```json
{
  "actions": {
    "update": "coffee",
    "deploy": "octopus-agent",
    "repo": "none"
  }
}
```

- The key is the command name (`update`, `repo`, `deploy`, ...). The value is the picture:
  - a file in this folder without its extension (`coffee` is `coffee.ansi`),
  - a built-in picture: `octopus-repo`, `octopus-update`, `octopus-agent`,
  - `none` to show nothing for that command.
- Your own copy goes in `~/.pf/art/` (same layout). Its `art.json` is merged over this one and its `.ansi` files win over files here of the same name. Use it for pictures that should not ship with pf.
- The unknown-command picture (`lost`) is built into pf and is not configurable.
- An `.ansi` file is plain text with color escapes (`ESC [ ... m`), for example from `chafa` or `scripts/gif-art.mjs`. Only color escapes are kept; cursor moves and other escapes are dropped. A picture is printed to stderr, only on a color terminal that is wide and tall enough, and never into pipes or logs.
- `PF_NO_MASCOT=1` (or `PF_NO_TRAVOLTA=1`) turns every picture off. `pf art` lists what is set up, `pf art show <name>` previews one.
