/**
 * Mirror a child handle's `profile` (name + avatar) onto its row in the parent's `handles`
 * list — so a handle list shows names + avatars without opening each one.
 *
 * @param {{ fields?: Record<string, any> }} [opts]
 */
export declare function handleSync({ fields }?: {
    fields?: Record<string, any>;
}): {
    name: string;
    schema: {
        handles: {
            kind: 'extend';
            fields: Record<string, import("@cero-base/core").Prim>;
        };
    };
    setup(me: any): void;
};
