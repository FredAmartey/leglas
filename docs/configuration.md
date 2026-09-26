# Setting up a project

With no configuration, `npx leglas` gives you a single preview of your app
root. A config file is how you get more than one thing to compare.

## Configuration

Create `leglas.config.ts` at the project root. `.js`, `.mjs` and `.json`
work too. Resolution walks upward from the working directory, so in a
monorepo the nearest file wins. Node reads the TypeScript config natively;
there is no compiler or extra dependency involved.

```ts
export default {
  devServer: "http://localhost:3000",
  previews: [
    { title: "Current", url: "/" },
    { title: "Wave", url: "/?v-hero=wave", note: "Full-bleed, anchored low.", tags: ["Hero"] },
    {
      title: "Dot grid",
      url: "/?v-hero=dotgrid",
      note: "Lattice that wakes near the pointer.",
      tags: ["Hero"],
    },
  ],
};
```

| Field            | Required      | Purpose                                                                 |
| ---------------- | ------------- | ----------------------------------------------------------------------- |
| `title`          | yes           | Label in the rail, and the key for your saved layout. Must be unique.   |
| `url`            | unless `file` | Root relative (`/pricing`) or absolute (`https://staging.example.com`)  |
| `note`           | no            | Second line under the title                                             |
| `tags`           | no            | The first tag renders as a pill                                         |
| `branch`         | no            | Preview a git branch instead of the running dev server                  |
| `file`           | no            | An HTML file served by Leglas itself, instead of `url`                  |
| `basedOn`        | no            | Title of the direction this is a variant of; the rail groups the family |
| `askedFor`       | no            | The change that was asked for, in the words that were typed             |
| `devServer`      | no            | Defaults to `http://localhost:3000`                                     |
| `devCommand`     | with `branch` | How to start the app. Must contain `{port}`.                            |
| `installCommand` | no            | Defaults to `npm install`                                               |
| `scanPreviews`   | no            | Set `false` to skip background duplicate scans for expensive apps      |

Leglas proxies whatever answers on `devServer`. If that port turns out to
be served from outside your project, Leglas says so and points at
`devServer` and `--user-port` rather than quietly proxying the wrong app.

A broken config never stops the server. Leglas starts anyway and the
interface reports what to fix, so you are not hunting through a stack
trace.

The config is the shared description of a project: commit it and a
teammate gets the same directions on clone. `leglas add` registers a
preview on your machine only, in `.leglas/previews.json`, because
exploration is short-lived and its code lives in a gitignored directory;
`leglas list` shows both and marks which are local. Renaming a direction
in the rail is local in the same way, so the config title stays the one a
teammate sees, and `leglas show` and `leglas keep` take either name.

## Without a dev server

If the project exists but nothing is listening, set `devCommand` and
Leglas starts your app itself, proxies it and stops it on exit. When
`--user-port` names a server explicitly, Leglas never starts a different
one behind that flag.

If there is no app at all, a direction can be a plain HTML file:

```ts
export default {
  previews: [
    { title: "Aurora", file: ".leglas/pages/aurora.html" },
    { title: "Ember", file: ".leglas/pages/ember.html" },
  ],
};
```

Leglas serves each file from its own origin, so the full interface works
with no dev server anywhere. The file's directory is mounted rather than
the lone file, so stylesheets and images beside it resolve. When the real
app arrives, directions graduate to app code and nothing about the
interface changes.

## Comparing branches

A preview with a `branch` field is served from its own checkout: Leglas
creates a worktree, installs, starts the app with your `devCommand` on a
free port and tears it all down when you quit. In the interface it looks
like any other direction, so a branch against your working tree, or three
branches against each other, compares the same way two query parameters
do.

## How it works

Leglas runs one local server that serves the interface at `/leglas` and
forwards every other request to your dev server. Previews load through
that proxy, so they are same origin with the interface: no CORS
configuration, no cookie special cases.

The proxy is designed to be invisible. Hot module replacement survives
the hop, redirects that point at your dev server are rewritten to keep
you inside the interface, and responses stream rather than buffer. If an
app behaves differently through Leglas than on its own port, that is a
bug.

Because a preview is a URL, the same interface compares two routes, two
implementations behind a query parameter or a local server against a
deployed one. Absolute URLs load directly rather than through the proxy,
so a site that refuses to be framed will not preview. The pane says so
instead of showing the browser's broken page: which header refused it, a
button that opens the page in a tab, and the one header that would let it
through if the site is yours. Leglas asks the page without your cookies, so
a page that frames only once you are signed in can be uncovered from the
pane with "Show the frame anyway".

Leglas also compares what each preview actually draws and warns when two
are identical. This catches a typo like `?v-hero=wavee` that your app
silently ignores while the rail implies a comparison. It reads every
preview in the background, one at a time in a hidden frame, and skips
branches and absolute URLs, which the browser will not let it read. Set
`scanPreviews: false` for an app too heavy to load that way.

## Limitations

- Leglas runs no model of its own. Comparing existing routes costs
  nothing, but a new direction is still code your agent writes; Leglas
  hands it the request and shows the result.
- The duplicate check compares what a page draws, so two previews that
  differ only in behaviour, such as what a click does, are reported as
  identical. A page with almost no text, such as a blank or loading
  screen, gets no verdict, so two of those are never flagged.
- The interface is built for desktop widths.
- Leglas is a development tool. Nothing in it ships to production.
