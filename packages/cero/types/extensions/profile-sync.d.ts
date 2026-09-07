/**
 * Mirror your `profile` onto your `member` row in every handle you're in.
 *
 * @param {{ fields?: Record<string, any> }} [opts]
 */
export declare function profileSync({ fields }?: {
    fields?: Record<string, any>;
}): {
    name: string;
    schema: {
        profile: import("@cero-base/core").TypeDef;
        members: {
            kind: 'extend';
            fields: Record<string, import("@cero-base/core").Prim>;
        };
    };
    setup(me: any): void;
};
