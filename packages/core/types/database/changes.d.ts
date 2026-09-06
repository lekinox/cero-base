/**
 * Pull-driven delta stream over a collection: batches of `{ prev, next }` pairs diffed
 * from the head this stream last reported.
 *
 * @param {import('./index.js').Database} db
 * @param {string} name    Ref name (scopes the update ticks).
 * @param {string} col     Collection path (`@ns/name`).
 * @param {(row: any) => boolean} matches
 * @returns {import('streamx').Readable}
 */
export declare function makeChanges(db: import('./index.js').Database, name: string, col: string, matches: (row: any) => boolean): import('streamx').Readable;
