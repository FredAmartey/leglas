import { startWorktree, type RunningWorktree } from "./worktree.js";

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

export type BranchRegistry = {
  state(title: string): BranchState | undefined;
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
  onChange?: (title: string, state: BranchState) => void;
}): BranchRegistry {
  const states = new Map<string, BranchState>(
    options.previews.map((preview) => [preview.title, { status: "idle" }]),
  );
  const previews = new Map(options.previews.map((preview) => [preview.title, preview]));
  const inflight = new Map<string, Promise<BranchState>>();
  const boot = options.startWorktree ?? startWorktree;
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
      .then((worktree) => {
        transition(title, { status: "starting", phase: "starting" });
        return transition(title, { status: "ready", worktree });
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
    start: begin,
    stop: () => {
      if (stopPromise !== null) return stopPromise;
      closed = true;
      stopPromise = Promise.allSettled([...inflight.values()]).then(async () => {
        const worktrees = [...states.values()]
          .filter((state): state is Extract<BranchState, { status: "ready" }> =>
            state.status === "ready",
          )
          .map((state) => state.worktree);
        await Promise.all(worktrees.map((worktree) => worktree.stop().catch(() => {})));
      });
      return stopPromise;
    },
  };
}
