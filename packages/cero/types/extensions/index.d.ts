export * from './profile-sync.js';
export * from './handle-sync.js';
export declare const registry: ({
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
