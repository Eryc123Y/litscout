/** An older brief names a project by its slug, such as "sparse-reward-study". */
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
const titleOf = (text: string) =>
  text
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

/** The vault project index can supply titles keyed by slug or project ID.
 * A slug it does not know is read as a title. */
export function radarProjectTitle(
  item: { project?: string | null; projectId?: string | null },
  index?: ReadonlyMap<string, string>,
) {
  const keys = [item.projectId, item.project];
  for (const key of keys) {
    if (!key) continue;
    const title = index?.get(key);
    if (title) return title;
  }
  return item.project && slug.test(item.project)
    ? titleOf(item.project)
    : item.project;
}
