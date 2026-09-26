/**
 * Mirror your `profile` onto your `member` row in every handle you're in.
 *
 * @param {{ fields?: Record<string, object> }} [opts]  Extra fields, as `t` types.
 * @returns {import('./index.js').Extension}
 */
export declare function profileSync({ fields }?: {
    fields?: Record<string, object>;
}): import('./index.js').Extension;
