import { readFile } from "node:fs/promises";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolve } from "node:path";

import {
  DEFAULT_EXPLORE_COUNT,
  DEFAULT_PORT,
  DEFAULT_SHARE_REACH,
  MAX_PORT,
  MAX_SHOW_WIDTH,
  MIN_SHOW_WIDTH,
  addRefusal,
  fromRefusal,
  isOwnCapture,
  run,
  runAdd,
  runClassify,
  runExplore,
  runInit,
  runKeep,
  runList,
  runNew,
  runRequests,
  runShare,
  runShow,
  shareRefusal,
  showRefusal,
  type RunResult,
} from "leglas";
import { z } from "zod";

import { createEngagement, type Engagement } from "./engagement.js";
import type { Project } from "./project.js";

/**
 * Every CLI command already prints a single JSON envelope under --json, with a
 * stable shape and exit code. The MCP face holds no logic of its own: each
 * tool calls the same run function the CLI calls and hands the envelope over.
 * One implementation of every operation, two faces on it. The schemas carry
 * the CLI's limits and each tool asks its rules before running, so a call the
 * command line refuses is refused here too.
 */

/** A capture path is useful only when the CLI returned it as text. */
function hasCaptureFile(value: unknown): value is { screenshot: { file: string } } {
  return (
    typeof value === "object" &&
    value !== null &&
    "screenshot" in value &&
    typeof value.screenshot === "object" &&
    value.screenshot !== null &&
    "file" in value.screenshot &&
    typeof value.screenshot.file === "string"
  );
}

type CaptureDeps = { log(line: string): void; error(line: string): void };

/** The CLI's shape for a failure, so a host parses this like any other. */
function refused(error: string): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, error }) }], isError: true };
}

async function capture(
  invoke: (deps: CaptureDeps) => Promise<{ exitCode: number }> | { exitCode: number },
): Promise<CallToolResult> {
  const lines: string[] = [];

  const deps: CaptureDeps = {
    log: (line) => lines.push(line),
    error: (line) => lines.push(line),
  };

  const { exitCode } = await invoke(deps);

  // The envelope is the last JSON line. Anything else captured (there should
  // be nothing under --json) rides along so a surprise is visible, not lost.
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];

    if (line === undefined || !line.startsWith("{")) continue;

    try {
      JSON.parse(line);

      return { content: [{ type: "text", text: line }], isError: exitCode !== 0 };
    } catch {
      // Not the envelope; keep looking.
    }
  }

  return { content: [{ type: "text", text: lines.join("\n") }], isError: exitCode !== 0 };
}

/**
 * Run a command in the project, or report that there is no project to run it
 * in. Resolution is asked for on the first call and held after that, so the
 * cost lands once and every tool acts on the same directory.
 */
async function inProject(
  project: Project,
  invoke: (cwd: string, deps: CaptureDeps) => Promise<{ exitCode: number }> | { exitCode: number },
): Promise<CallToolResult> {
  const located = await project.locate();

  if (!located.ok) return refused(located.reason);

  return capture((deps) => invoke(located.directory, deps));
}

export type LeglasTools = {
  /** Stop anything the tools started. Wired to the transport's close. */
  shutdown(): Promise<void>;
};

export function registerLeglasTools(
  server: McpServer,
  options: { project: Project; engagement?: Engagement },
): LeglasTools {
  const project = options.project;

  // One viewer per MCP process. The handle is held so a host that dies or
  // disconnects never leaves a dev server running on a port nobody remembers.
  let viewer: RunResult | null = null;

  // Working the queue over MCP counts as attachment, exactly like watch: the
  // embedded runner must not race a host's agent for the same tree.
  const engagement = options.engagement ?? createEngagement();

  server.registerTool(
    "start",
    {
      title: "Start the Leglas viewer",
      description:
        "Boot the Leglas server for this project and return the interface URL. " +
        "Idempotent per session: calling it again returns the running viewer. " +
        "When building a set, call this first and give the user the URL before " +
        "any direction exists: the rail updates live, so they watch the set fill in.",
      inputSchema: {
        port: z
          .number()
          .int()
          .min(0)
          .max(MAX_PORT)
          .optional()
          .describe(
            `Port for Leglas itself; defaults to ${DEFAULT_PORT}, next free if taken. 0 takes any free port.`,
          ),
      },
    },
    async ({ port }) => {
      if (viewer !== null) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: true, url: viewer.url, alreadyRunning: true }),
            },
          ],
        };
      }

      return inProject(project, async (cwd, deps) => {
        const result = await run(
          { port, userPort: undefined, configPath: undefined, open: false, json: true, cwd },
          { open: async () => {}, log: deps.log },
        );

        viewer = result;

        return result;
      });
    },
  );

  server.registerTool(
    "add",
    {
      title: "Register a preview",
      description:
        "Register a design direction on this machine so it appears in the rail. " +
        "The rail picks it up within seconds, so when building a set register " +
        "each direction as it lands rather than the whole set at the end. " +
        "Use branch for a direction that lives on its own git branch. " +
        "Then call show with screenshot: true to look at what you registered.",
      inputSchema: {
        title: z.string().min(1).describe("Unique title; identifies the preview."),
        url: z
          .string()
          .min(1)
          .optional()
          .describe('Root-relative ("/?v-hero=aurora") or absolute URL. Omit for a file preview.'),
        note: z.string().optional().describe("One line on the idea, shown under the title."),
        tags: z.array(z.string()).optional(),
        branch: z
          .string()
          .optional()
          .describe("Back the preview with a checkout of this git branch."),
        file: z
          .string()
          .optional()
          .describe("Project-relative HTML file for Leglas to serve itself; no dev server needed."),
        basedOn: z
          .string()
          .optional()
          .describe("Title of the direction this is a variant of; the rail groups the family."),
        askedFor: z
          .string()
          .optional()
          .describe(
            "The change this direction was asked for, in the words that were typed. " +
              "Pass it verbatim when building a variant someone requested; the rail shows it.",
          ),
      },
    },
    async ({ title, url, note, tags, branch, file, basedOn, askedFor }) => {
      const preview = { title, url, note, tags, branch, file, basedOn, askedFor };
      const refusal = addRefusal(preview);

      if (refusal !== null) return refused(refusal);

      return inProject(project, (cwd, deps) => runAdd({ preview, json: true, cwd }, deps));
    },
  );

  server.registerTool(
    "list",
    {
      title: "List previews",
      description: "Every preview, shared and local, with its URL and backing branch if any.",
      inputSchema: {},
    },
    async () => inProject(project, (cwd, deps) => runList({ json: true, cwd }, deps)),
  );

  server.registerTool(
    "show",
    {
      title: "Inspect one direction",
      description:
        "Everything Leglas knows about one direction: its full entry, the source file behind " +
        "it, the variants based on it, the directions it is being compared against, and any " +
        "change requests still pending on it. Call this when handed a direction's reference " +
        "block. With screenshot: true, Leglas also renders the direction with a headless " +
        "browser and returns the image, so you can see what you built. Do this after registering " +
        "a direction and before saying it is done; width 390 shows the phone layout.",
      inputSchema: {
        title: z
          .string()
          .min(1)
          .describe("The direction's title as the config spells it, not a renamed display name."),
        screenshot: z.boolean().optional(),
        width: z.number().int().min(MIN_SHOW_WIDTH).max(MAX_SHOW_WIDTH).optional(),
      },
    },
    async ({ title, screenshot, width }) => {
      const refusal = showRefusal({
        screenshot: screenshot ?? false,
        width: width ?? null,
        port: null,
      });

      if (refusal !== null) return refused(refusal);
      const located = await project.locate();

      if (!located.ok) return refused(located.reason);

      const result = await capture((deps) =>
        runShow(
          {
            title,
            json: true,
            screenshot: screenshot ?? false,
            width: width ?? null,
            port: null,
            cwd: located.directory,
          },
          deps,
        ),
      );

      if (screenshot !== true || result.isError === true) return result;
      const text = result.content.find((entry) => entry.type === "text");

      if (text === undefined || text.type !== "text") return result;

      try {
        const envelope: unknown = JSON.parse(text.text);

        if (!hasCaptureFile(envelope)) return result;
        const file = envelope.screenshot.file;

        // The path comes back over a loopback socket, which a stale record
        // can point at something that is not Leglas. Only a real file inside
        // this project's captures is read and handed to the host.
        if (!(await isOwnCapture(located.directory, file))) {
          return result;
        }

        const image = await readFile(resolve(located.directory, file));

        return {
          ...result,
          content: [
            ...result.content,
            { type: "image" as const, data: image.toString("base64"), mimeType: "image/png" },
          ],
        };
      } catch {
        return result;
      }
    },
  );

  server.registerTool(
    "classify",
    {
      title: "Decide where a direction should live",
      description:
        "Before writing a direction, declare what it will touch and learn whether it can be " +
        "additive in the running app or needs its own checkout, with the reason and the steps.",
      inputSchema: {
        changes: z
          .array(
            z.object({
              path: z.string().min(1).describe("Project-relative path."),
              kind: z
                .enum(["change", "rewrite"])
                .describe(
                  '"change": create or wire up. "rewrite": alter what an existing file renders.',
                ),
            }),
          )
          .min(1),
      },
    },
    async ({ changes }) =>
      inProject(project, (cwd, deps) => runClassify({ changes, json: true, cwd }, deps)),
  );

  server.registerTool(
    "explore",
    {
      title: "Brief an exploration",
      description:
        "What a set for a surface needs and how it registers here. Directions must genuinely " +
        "disagree; with basedOn, variants of that direction must not. The designs themselves are " +
        "yours. Run before building a set.",
      inputSchema: {
        surface: z.string().min(1),
        count: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(`How many; default ${DEFAULT_EXPLORE_COUNT}.`),
        basedOn: z
          .string()
          .min(1)
          .optional()
          .describe(
            "An existing direction's title: ask for variants of it instead of new directions.",
          ),
      },
    },
    async ({ surface, count, basedOn }) =>
      capture((deps) =>
        // The brief is the same wherever it is read from; it touches no project.
        runExplore(
          { surface, count: count ?? DEFAULT_EXPLORE_COUNT, basedOn: basedOn ?? null, json: true },
          deps,
        ),
      ),
  );

  server.registerTool(
    "scaffold",
    {
      title: "Scaffold a branch point",
      description:
        "Create a switcher and a first direction for a surface under .leglas/variants/. " +
        "With from, the baseline re-exports the component that renders the surface today.",
      inputSchema: {
        surface: z.string().min(1),
        from: z.string().optional().describe("Path of the component rendering this surface today."),
        print: z.boolean().optional().describe("Print the scaffold instead of writing it."),
      },
    },
    async ({ surface, from, print }) => {
      const refusal = fromRefusal(from);

      if (refusal !== null) return refused(refusal);

      return inProject(project, (cwd, deps) =>
        runNew({ surface, print: print ?? false, json: true, from, cwd }, deps),
      );
    },
  );

  server.registerTool(
    "keep",
    {
      title: "Keep a winner",
      description:
        "Move the winning direction into real source, delete the rest of the exploration, and " +
        "drop them from the rail.",
      inputSchema: {
        title: z.string().min(1).describe("Title of the direction to keep."),
        to: z.string().min(1).describe("Path in real source where the winner should live."),
      },
    },
    async ({ title, to }) =>
      inProject(project, (cwd, deps) => runKeep({ title, to, json: true, cwd }, deps)),
  );

  server.registerTool(
    "share",
    {
      title: "Share directions",
      description:
        "Share directions with someone who has no copy of the project: the whole rail, one " +
        "direction, or two side by side, through a tunnel, and return the link. Use it only when " +
        "the user asks to share: whoever holds the link reaches the running app. A share that is " +
        "already running is returned, not replaced. Pass stop to end it and every link to it.",
      inputSchema: {
        titles: z
          .array(z.string().min(1))
          .max(2)
          .optional()
          .describe(
            "None shares the rail; one shares it alone; two are compared, the second on the right.",
          ),
        reach: z
          .enum(["open", "listed"])
          .optional()
          .describe(
            "open lets viewers reach the whole app. listed serves only the paths the share lists, " +
              "which starts empty from here, so a page's own files are refused until the user allows them.",
          ),
        stop: z.boolean().optional(),
      },
      annotations: { openWorldHint: true },
    },
    async ({ titles, reach, stop }) => {
      const refusal = shareRefusal({
        titles: titles ?? [],
        reach,
        tunnel: null,
        stop: stop ?? false,
      });

      if (refusal !== null) return refused(refusal);

      return inProject(project, (cwd, deps) =>
        runShare(
          {
            titles: titles ?? [],
            reach: reach ?? DEFAULT_SHARE_REACH,
            tunnel: null,
            stop: stop ?? false,
            port: null,
            json: true,
            cwd,
          },
          deps,
        ),
      );
    },
  );

  server.registerTool(
    "requests",
    {
      title: "Collect change requests",
      description:
        "Pending change requests made from the interface, each naming the direction and the file " +
        "behind it. Call this when starting work in a project that uses Leglas, and again before " +
        "changing any direction: the user may have described the change from the interface while " +
        "you worked, and collecting marks it picked up there. Pass clear once they are done: it " +
        "drops what you collected and reports anything that arrived since, which is yours to do next.",
      inputSchema: {
        clear: z.boolean().optional(),
      },
    },
    async ({ clear }) => {
      // Touched on every call, empty queue included: an agent that just asked
      // is an agent about to act, and the beat lapses on its own once the
      // asking stops. Awaited before the queue is read so the runner has
      // backed off by the time this session could collect anything.
      await engagement.touch();

      return inProject(project, (cwd, deps) =>
        runRequests({ json: true, clear: clear ?? false, cwd }, deps),
      );
    },
  );

  server.registerTool(
    "init",
    {
      title: "Prepare a project",
      description:
        "Write the AGENTS.md section, a starter config, and the gitignore entry into this project.",
      inputSchema: {
        force: z.boolean().optional().describe("Rewrite the AGENTS.md section if it exists."),
      },
    },
    async ({ force }) =>
      inProject(project, (cwd, deps) => runInit({ cwd, force: force ?? false, json: true }, deps)),
  );

  return {
    shutdown: async () => {
      const running = viewer;
      viewer = null;
      await engagement.stop().catch(() => {});
      await running?.stop().catch(() => {});
    },
  };
}
