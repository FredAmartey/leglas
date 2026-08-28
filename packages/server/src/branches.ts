import { startProxyServer, type RunningProxy } from "./proxy.js";
import { startWorktree, type RunningWorktree } from "./worktree.js";

export const BRANCH_IDLE_MS = 10 * 60 * 1000;
const BRANCH_SWEEP_MS = 30_000;

export type BranchPhase = "checking out" | "installing" | "starting";

export type BranchState =
  | { status: "idle" }
  | { status: "starting"; phase: BranchPhase }
  | { status: "ready"; worktree: RunningWorktree }
  | { status: "failed"; reason: string };

export type BranchPreviewState =
  | { status: "idle" }
  | { status: "starting"; phase: BranchPhase }
  | { status: "ready" }
  | { status: "failed"; reason: string };

export type BranchPreview = {
  title: string;
  branch: string;
};

export type StartBranchWorktree = typeof startWorktree;
type StartBranchProxy = typeof startProxyServer;

export type BranchRegistry = {
  state(title: string): BranchState | undefined;
  url(title: string): string | undefined;
  start(title: string): Promise<BranchState> | undefined;
  stop(): Promise<void>;
};

export function publicBranchState(state: BranchState): BranchPreviewState {
  if (state.status === "ready") return { status: "ready" };
  return state;
}

export function createBranchRegistry(options: {
  cwd: string;
  previews: readonly BranchPreview[];
  installCommand: string;
  devCommand: string | undefined;
  startWorktree?: StartBranchWorktree;
  startProxy?: StartBranchProxy;
  onChange?: (title: string, state: BranchState) => void;
}): BranchRegistry {
  const states = new Map<string, BranchState>(
    options.previews.map((preview) => [preview.title, { status: "idle" }]),
  );
  const previews = new Map(options.previews.map((preview) => [preview.title, preview]));
  const inflight = new Map<string, Promise<BranchState>>();
  const stopping = new Map<string, Promise<void>>();
  const lastActivity = new Map<string, number>();
  const proxies = new Map<string, RunningProxy>();
  const boot = options.startWorktree ?? startWorktree;
  const proxy = options.startProxy ?? startProxyServer;
  let closed = false;
  let stopPromise: Promise<void> | null = null;

  const transition = (title: string, state: BranchState): BranchState => {
    const previous = states.get(title);
    if (
      previous?.status === "starting" &&
      state.status === "starting" &&
      previous.phase === state.phase
    ) {
      return previous;
    }
    states.set(title, state);
    options.onChange?.(title, state);
    return state;
  };

  const stopReady = (
    title: string,
    state: Extract<BranchState, { status: "ready" }>,
    toIdle: boolean,
  ): Promise<void> => {
    const current = stopping.get(title);
    if (current !== undefined) return current;
    const pending = (async () => {
      await proxies.get(title)?.close().catch(() => {});
      await state.worktree.stop().catch(() => {});
      proxies.delete(title);
      lastActivity.delete(title);
      if (toIdle && !closed && states.get(title) === state) {
        transition(title, { status: "idle" });
      }
    })().finally(() => {
      stopping.delete(title);
    });
    stopping.set(title, pending);
    return pending;
  };

  const sweep = () => {
    const now = Date.now();
    for (const [title, state] of states) {
      const branchProxy = proxies.get(title);
      if (state.status !== "ready" || branchProxy === undefined || stopping.has(title)) continue;
      if (branchProxy.active()) {
        lastActivity.set(title, now);
        continue;
      }
      const seen = lastActivity.get(title) ?? now;
      if (now - seen >= BRANCH_IDLE_MS) void stopReady(title, state, true);
    }
  };
  const sweepTimer = setInterval(sweep, BRANCH_SWEEP_MS);
  sweepTimer.unref();

  const begin = (title: string): Promise<BranchState> | undefined => {
    const preview = previews.get(title);
    const current = states.get(title);
    if (preview === undefined || current === undefined || closed) return undefined;
    if (current.status === "starting") return inflight.get(title);
    if (current.status === "ready") return Promise.resolve(current);

    transition(title, { status: "starting", phase: "checking out" });

    let checkout: Promise<RunningWorktree>;
    try {
      checkout = Promise.resolve(
        boot({
          cwd: options.cwd,
          branch: preview.branch,
          installCommand: options.installCommand,
          devCommand: options.devCommand ?? "",
          onLog: (line) => {
            transition(title, {
              status: "starting",
              phase: line.startsWith("installing ") ? "installing" : "starting",
            });
          },
        }),
      );
    } catch (error) {
      checkout = Promise.reject(error);
    }

    const starting = checkout
      .then(async (worktree) => {
        transition(title, { status: "starting", phase: "starting" });
        try {
          const branchProxy = await proxy({
            target: worktree.url,
            onActivity: () => lastActivity.set(title, Date.now()),
          });
          proxies.set(title, branchProxy);
          lastActivity.set(title, Date.now());
          return transition(title, { status: "ready", worktree });
        } catch (error) {
          await worktree.stop().catch(() => {});
          throw error;
        }
      })
      .catch((error: unknown) =>
        transition(title, {
          status: "failed",
          reason: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => {
        inflight.delete(title);
      });
    inflight.set(title, starting);
    return starting;
  };

  return {
    state: (title) => states.get(title),
    url: (title) => proxies.get(title)?.url,
    start: begin,
    stop: () => {
      if (stopPromise !== null) return stopPromise;
      closed = true;
      clearInterval(sweepTimer);
      stopPromise = Promise.allSettled([...inflight.values()]).then(async () => {
        await Promise.allSettled([...stopping.values()]);
        const ready = [...states.entries()].filter(
          (entry): entry is [string, Extract<BranchState, { status: "ready" }>] =>
            entry[1].status === "ready" && proxies.has(entry[0]),
        );
        await Promise.all(ready.map(([title, state]) => stopReady(title, state, false)));
      });
      return stopPromise;
    },
  };
}
