// Placeholder for the committed task runtime bundle.
//
// The real bundle is reproducibly built from packages/task-azure-pipelines and committed
// here by the release build in a later epic (E4). Until then this stub
// fails fast so a partially-wired task never runs silently.
//
// The sentinel below is the machine-detectable marker release pipelines grep
// for to refuse publishing a placeholder bundle. A real built bundle must not
// contain this token. Marker: __CHAOS_STUDIO_PLACEHOLDER_BUNDLE__
//
// eslint-disable-next-line no-console
console.error(
  'Azure Chaos Studio task: the runtime bundle has not been built yet ' +
    '(__CHAOS_STUDIO_PLACEHOLDER_BUNDLE__). See dist/azure-pipelines-task/README.md.',
);
process.exit(1);
