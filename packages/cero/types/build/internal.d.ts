export declare const defs: {
    main: {
        members: {
            type: string;
        };
        devices: {
            type: string;
        };
        invites: {
            type: string;
        };
        handles: {
            type: string;
        };
        files: {
            type: string;
        };
    };
    local: {
        master: {
            type: string;
            kind: string;
        };
        keypair: {
            type: string;
            kind: string;
        };
        'handle-keypairs': {
            type: string;
        };
        environment: {
            type: string;
            kind: string;
        };
    };
};
export declare function fields(map: any): {
    name: string;
    type: any;
    required: boolean;
}[];
export declare function types(scope: any, extend?: {}): {
    name: string;
    compact: boolean;
    fields: {
        name: string;
        type: any;
        required: boolean;
    }[];
}[];
export declare function refs(ns: any, scope: any): {
    [k: string]: {
        kind: any;
        path: string[];
        internal: boolean;
        verb: any;
        schema: string;
    };
};
export declare function collections(ns: any, scope: any): {
    name: string;
    schema: string;
    key: string[];
}[];
export declare function dispatches(ns: any): {
    name: string;
    requestType: string;
}[];
export declare function commands(ns: any): {
    name: string | boolean;
    request: {
        name: string;
    };
    response: {
        name: string;
        stream: string | true;
    };
}[];
