export function libraryPermissions(scopes: readonly string[]) {
  return {
    libraryRead: scopes.length === 0 || scopes.includes("read"),
    libraryWrite: scopes.includes("write"),
  };
}
