/** Count D1 requests and rows read and written where the binding returns metadata. */
export function countingDb(db: D1Database) {
  let calls = 0,
    maxParams = 0,
    maxSqlBytes = 0,
    batchRowsRead = 0,
    rowsRead = 0,
    rowsWritten = 0;
  const measure = <T extends D1Result>(result: T) => {
    rowsRead += result.meta.rows_read;
    rowsWritten += result.meta.rows_written;
    return result;
  };
  const originals = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, key) {
        if (key === "bind")
          return (...params: unknown[]) => {
            maxParams = Math.max(maxParams, params.length);
            if (params.length > 100)
              throw new Error(`D1 bind limit: ${params.length}`);
            return wrap(target.bind(...params));
          };
        if (key === "all" || key === "run")
          return () => {
            calls++;
            return target[key]().then(measure);
          };
        if (key === "first" || key === "raw")
          return (...args: unknown[]) => {
            calls++;
            return (
              Reflect.get(target, key) as (...args: unknown[]) => unknown
            ).apply(target, args);
          };
        return Reflect.get(target, key);
      },
    });
    originals.set(proxy, statement);
    return proxy;
  };
  const counted = new Proxy(db, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          maxSqlBytes = Math.max(
            maxSqlBytes,
            new TextEncoder().encode(sql).length,
          );
          return wrap(target.prepare(sql));
        };
      if (key === "batch")
        return (statements: D1PreparedStatement[]) => {
          calls++;
          return target
            .batch(statements.map((s) => originals.get(s) ?? s))
            .then((results) => {
              for (const result of results) {
                batchRowsRead += result.meta.rows_read;
                measure(result);
              }
              return results;
            });
        };
      return Reflect.get(target, key);
    },
  });
  return {
    db: counted,
    reset() {
      calls = 0;
      maxParams = 0;
      maxSqlBytes = 0;
      batchRowsRead = 0;
      rowsRead = 0;
      rowsWritten = 0;
    },
    stats: () => ({ calls, maxParams, maxSqlBytes, rowsRead, rowsWritten }),
    batchRowsRead: () => batchRowsRead,
  };
}
