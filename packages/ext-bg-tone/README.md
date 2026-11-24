# Background Tone

Tint the window chrome per repo/window and show a repo-local logo, so you can tell VS Code / Cursor windows apart.

## Usage

The settings live in the repo's `pulpfixer.json` (the file `pf` keeps at the repo root), in a `bgTone` section, so the
tone and the logo are committed and everyone who opens the repo sees the same thing:

```json
{
  "bgTone": {
    "color": "#3b82f6",
    "strength": 0.08,
    "logo": "assets/logo.svg"
  }
}
```

Every key below goes in that section without the `bgTone.` prefix (`"color"`, not `"bgTone.color"`). `pf rp` sets
`logo` from an image it finds in the repo. A repo that still has `bgTone.*` values in `.vscode/settings.json` keeps
working: they are read until the first save moves them into `pulpfixer.json`. `bgTone.showLastAgent` is personal, so it
stays a normal VS Code setting.

By default the extension tints the gray chrome (side bar and title bar) and leaves the editor
background untouched. It blends the tone into a base color and writes the result to the workspace's
`workbench.colorCustomizations` (derived values, recomputed from `pulpfixer.json` on every machine). Other
customization keys are left alone.

## Ways to change the tone

- **Quick pick**: the color-palette icon in the Explorer header (or the status bar item at the bottom left)
  opens a list of about 40 colors plus your own palette, and a link to the full settings page.
- **Repo Settings page**: the gear icon in the Explorer header, or **Background Tone: Open Repo Settings**.
  Its cards are grouped in tabs: **Color** (palette, hex input, intensity slider, per-area toggles and base
  colors, live preview), **Logo** (the logo picker, where it shows, the window title prefix) and **Actions**
  (the featured repo actions). Everything it saves lands in the repo's `pulpfixer.json`.
- **Version**: the Repo Identity card shows the repo's stack version (from `versions.json`, as kept by
  `pnpm ver`) on the line below the name; a repo without that file shows none. Beside it the card shows how many files
  have uncommitted changes (`git status`, untracked files included), hidden at zero or outside a git repo. The number is a link: it asks for a commit message, then
  stages everything (`git add -A`) and commits (hooks run; nothing is pushed). Only in a trusted workspace.
- **Versions**: in a repo with a `versions.json`, Source Control lists the stack and every package with its version and
  two `[+]` buttons, like `pf v` (featured packages, the `featured` array the CLI's `feature` writes, come first with bold names; the star at the left of a package row features or unfeatures it by editing the `featured` array) (the one before the version bumps major, the one after it minor; hover shows the
  result). A package bump also raises the stack minor, but only once until the next commit (the stack counts as
  already bumped when its version differs from `HEAD:versions.json`, so a bump made in a terminal counts too; a click
  on the stack itself always bumps it). A click edits `versions.json` (same format as the `ver` CLI) and runs
  `pf ver sync` for the manifests and hooks; trusted local workspaces only. While a bump waits for a commit
  (`versions.json` differs from `HEAD`), a **Commit versions** button at the top of the list commits at once with the message `Bump versions: ...` (no dialog) and commits
  only the files the bump changed (`versions.json`, the synced manifests, what `postSync` hooks wrote), after the
  `preCommit` hooks of `versions.json`; nothing is pushed. `bgTone.versions` chooses where it shows.

## Settings

| Key (`bgTone.*` in the legacy settings) | Default | Description |
| --- | --- | --- |
| `bgTone.enabled` | `true` | Turn the tone on/off. |
| `bgTone.color` | `""` | Hex tone color. Empty removes the tone. |
| `bgTone.strength` | `0.08` | Mix amount, 0 to 0.3. |
| `bgTone.surfaces` | `["sideBar", "titleBar"]` | Areas to tint: `sideBar`, `titleBar`, `editor`, `activityBar`, `statusBar`, `tabBar`, `panel`. |
| `bgTone.baseColors` | `{}` | Optional hex base per surface, e.g. `{ "sideBar": "#f3f3f3" }`. Defaults match VS Code Dark+/Light+. High contrast themes are not tinted unless a base is set. |
| `bgTone.accentBorder` | `false` | Paint the raw color on the title bar bottom border and the active tab border. |
| `bgTone.palette` | `[]` | Extra picker colors, e.g. `[{ "label": "Brand", "color": "#ff6600" }]`. |
| `bgTone.logo` | `""` | Image inside the repo, relative to the repo root (png, svg, jpg, jpeg, webp, gif, ico). |
| `bgTone.logoLocations` | `["identityCard", "explorerItem", "scmCard"]` | Where to show the identity: `identityCard`, `explorerItem`, `scmCard` (the Repo Identity card in Source Control), `windowTitle`. |
| `bgTone.titleEmoji` | `""` | Emoji or short text (max 8 characters) used as the window title prefix. |
| `bgTone.showLastAgent` | `true` | Show the last 3 Cursor agent chats (title, status, time since) on the Repo Identity card. |
| `bgTone.showLastCommits` | `true` | Show the last 3 commits (message, time since) on the Repo Identity card in Source Control, in place of the agent chats. The commit icon is colored like the Commit Graph: blue for a commit only this clone has, purple once a remote has it. |
| `bgTone.showActions` | `true` | Show the repo's featured actions as icon buttons on the Repo Identity card (personal setting). |
| `bgTone.versions` | `view` | Where to list the versions with `[+]` bump buttons: `view` (a Versions view in Source Control), `card` (a section of the Repo Identity card there) or `off`. |
| `bgTone.pfPath` | `pf` | The `pf` command the buttons run. Machine scope: a repo's workspace settings cannot change it. |

Commands: **Set Tone Color**, **Open Repo Settings**, **Choose Repo Logo...**, **Clear Repo Logo**,
**Randomize Tone** (stable color from the folder name), **Clear Tone**, **Choose Featured Repo Actions...**.

## Action buttons

Beside the repo name, the Repo Identity card shows small icon buttons for the repo's **featured actions** (push,
deploy, publish, docs and your own commands). Hover for the name, click to run `pf <action>` in the integrated
terminal. The list comes from `pf actions --json`, so only what the repo really has is offered; it needs `pf` (a
hint replaces the buttons when it is missing or too old) and a trusted workspace.

Which actions are featured, and their [codicon](https://microsoft.github.io/vscode-codicons/dist/codicon.html)
icons, live in the repo's `pulpfixer.json` (not in the `bgTone` section; pf owns them):

```json
{
  "commands": { "seed": { "run": "./scripts/seed.sh", "icon": "database", "featured": true } },
  "actions": { "doc": { "featured": false }, "build": { "featured": true, "icon": "package" } }
}
```

The pencil at the end of the row opens the **Actions** tab of Repo Settings: every action pf offers in the repo (what
its menu runs), each with a checkbox; ticked ones become buttons (it runs `pf actions feature` / `unfeature`). The
command *Choose Featured Repo Actions...* does the same from a picker. Run `pf actions --all` to see the ids.

In the pulpfixer checkout itself, `cycle` (`pf c`, the dev cycle) is an action too, featured in its `pulpfixer.json`
along with `doc`.

## Repo logo

Choose an image that lives inside the repo (the picker refuses files outside it, and `..` or absolute paths in
`bgTone.logo` are ignored), so the reference stays valid for everyone who clones the repo. The logo shows in:

- the **Repo Identity** card at the top of the Explorer (it also shows, without a logo or color, in a repo that has a `pulpfixer.json`, which `pf rp` creates; the logo is then a letter) (logo, a large repo name, and a list with the
  last 3 Cursor agent chats for this repo: each one's agent tab title and how long ago it was active ("running" while it works). Chats are found in
  `~/.cursor/projects/<repo>/agent-transcripts` and titles are read (read-only) from Cursor's global state database
  with the system `sqlite3` command; if that is unavailable the chat's first request is shown instead. Local
  windows only, turn off with `bgTone.showLastAgent`),
- the same card in the **Source Control** view (`scmCard`), so the repo and its action buttons stay in view while you commit;
  there the list shows the last 3 commits (message and how long ago, from `git log`) instead of agent chats, turn off with
  `bgTone.showLastCommits`,
- an **Explorer item** that uses the logo as its icon,
- the **tab icon** of the Repo Settings page,
- the **window title**, as an emoji or text prefix (`bgTone.titleEmoji`).

VS Code and Cursor do not let extensions draw images in the native title bar or in the window's top-left
corner, and the title bar accepts text only. That is why the window title uses an emoji or short text prefix
instead of the image itself. The prefix is added to the workspace `window.title`; a `window.title` you wrote
yourself in the workspace is never overwritten.

## Notes

- The extension cannot read the active theme's real colors, so it blends onto the per-surface default for the
  theme kind. Set `bgTone.baseColors` to your theme's actual `sideBar.background` etc. for an exact result.
- The status bar starts out saturated blue, so it is blended at 5x the normal strength to be visible. Its text
  color is not adjusted, so very light tones may reduce contrast.
- Applied values are theme-dependent hex values stored in workspace settings; they are recomputed when the theme changes.
- A theme-specific override such as `"[My Theme]": { "sideBar.background": ... }` in `colorCustomizations` wins over the tone.

## Install and update

This package is part of the pulpfixer suite and ships as `@pulpfixer/ext-bg-tone` (a `.vsix`) on the cellars registry.
`pf suite enable cursor` installs it into Cursor, `pf update` keeps it current and `pf rp` offers it for a repo. Reload
the Cursor window after an install or update.

## Development

Run from the pulpfixer checkout:

```sh
pnpm --filter @pulpfixer/ext-bg-tone typecheck
pnpm --filter @pulpfixer/ext-bg-tone package   # builds bg-tone.vsix
pnpm test                                      # runs this package's tests with the rest
cursor --install-extension packages/ext-bg-tone/bg-tone.vsix --force
```

The package has two manifests: `package.json` is the npm package (its version is the one `pnpm ver` bumps) and
`extension/package.json` is the VS Code manifest; the packaging script stamps the npm version into it.
Press F5 with `--extensionDevelopmentPath` pointing at this folder's built `dist` for an Extension Development Host.
