/**
 * Mirror a child handle's `profile` (name + avatar) onto its row in the parent's `handles`
 * list — so a handle list shows names + avatars without opening each one.
 *
 * @param {{ fields?: Record<string, object> }} [opts]  Extra fields, as `t` types.
 * @returns {import('./index.js').Extension}
 */
export declare function handleSync({ fields }?: {
    fields?: Record<string, object>;
}): import('./index.js').Extension;
