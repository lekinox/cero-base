/**
 * Build a row masker for devtools. A field is masked when its dotted path is in `fields`,
 * its name matches `deny` (default denylist above), or `match(key, value, path)` returns
 * true.
 *
 * @param {{ fields?: string[], deny?: RegExp | false, match?: (key: string, value: any, path: string) => boolean }} [config]
 * @returns {(ref: string, row: any) => any}
 */
export declare function redact(config?: {
    fields?: string[];
    deny?: RegExp | false;
    match?: (key: string, value: any, path: string) => boolean;
}): (ref: string, row: any) => any;
