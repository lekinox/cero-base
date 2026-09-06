export declare const internal: {
    extensions: ({
        name: string;
        bundled: boolean;
        schema: {
            profile: import("@cero-base/core").TypeDef;
            members: {
                kind: 'extend';
                fields: Record<string, import("@cero-base/core").Prim>;
            };
        };
        setup(me: any): void;
    } | {
        name: string;
        bundled: boolean;
        schema: {
            handles: {
                kind: 'extend';
                fields: Record<string, import("@cero-base/core").Prim>;
            };
        };
        setup(me: any): void;
    })[];
};
