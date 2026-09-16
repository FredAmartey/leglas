The Leglas repository is checked out at /app with dependencies installed and every package built. Leglas is a tool for comparing design directions inside a running app: a CLI, a local server and proxy, a React shell and an MCP server, in a pnpm workspace. Make the change in the source under /app. Do not edit or add test files; hidden tests will be run afterwards and any test file you touch is replaced. After your change, `pnpm build`, `pnpm -r typecheck` and the hidden tests must all pass. Run tests with `pnpm exec vitest run <file>`.

The changelog parser in `changelog.ts` accepts markdown from CHANGELOG.md and produces structured release entries. A bullet in the changelog can end with an audience tag like `(leglas)` or `(leglas, plugin)`, which tells the page which tools the change reaches. Today, the parser is too lenient and accepts malformed markdown without complaining. Three constructs that should be refused are silently accepted instead.

First, a tag followed by a full stop or other punctuation, like "Words. (`leglas`)." or "Words (`leglas`) and more," should be refused. The tag must end the bullet; nothing can follow it. The parser currently strips the tag when it finds one at the end of a bullet, but ignores a tag that has text after it, leaving the tag in the prose.

Second, a paragraph inside a group that loses its indentation should be refused. A bullet's second paragraph must be indented by two spaces to stay part of that bullet. If someone writes a paragraph under "### Fixed" without the two-space indent, it splits the list invisibly, which breaks the page layout. The parser should throw an error, not silently accept it.

Third, a nested bullet like "  - Inner." should be refused. The parser can handle multi-paragraph bullets with the two-space indent, but a line matching `  - ` is a nested list item, which is not supported and would be absorbed as prose.

The `parseChangelog` function must add three validation checks. When it finds a stray tag (audience name in parentheses not ending a bullet), throw an error matching "ends its bullet". When it finds unindented prose inside a group, throw an error matching "Indent it by two spaces". When it finds a nested bullet marker, throw an error matching "bullet inside a bullet". The exact error messages the tests match are:

- Stray tag: "An audience tag ends its bullet, with nothing after it: ..."
- Unindented prose: "A paragraph inside ... Indent it by two spaces to keep it in its bullet, or put it above the group."
- Nested bullet: "A bullet inside a bullet is not supported: ..."
