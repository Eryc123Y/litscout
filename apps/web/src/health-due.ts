/** How Health states the digest deadline: 23:59 means the reading day itself. */
export function dueText(onTimeBy: string) {
  return onTimeBy === "23:59" ? "on its reading day" : `by ${onTimeBy}`;
}
