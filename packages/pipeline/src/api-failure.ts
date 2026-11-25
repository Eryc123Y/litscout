/**
 * A failure whose message this code wrote: it holds no upstream text, header,
 * body or account identifier, so a command may show it as the cause.
 */
export class ApiFailure extends Error {}
