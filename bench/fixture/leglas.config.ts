// Three directions in the running app. bench/run.ts copies this folder to a
// temp directory, starts server.ts there and points Leglas at it with
// --user-port. A branch direction joins in a later journey, with a devCommand
// of `node server.ts --port {port}`.
export default {
  previews: [
    { title: "Baseline", url: "/" },
    { title: "Wave", url: "/?v-hero=wave", note: "Full-bleed, anchored low.", tags: ["Hero"] },
    { title: "Grid", url: "/?v-hero=grid", note: "Cards, three across.", tags: ["Hero"] },
  ],
};
