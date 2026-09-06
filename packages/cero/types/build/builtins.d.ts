export declare const refs: {
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
export declare function getHyperdbType(prim: any): any;
export declare function builtinRefs(ns: any, scope: any): {
    [k: string]: {
        kind: any;
        path: string[];
        builtin: boolean;
        verb: any;
        schema: string;
    };
};
export declare function builtinTypes(scope: any, extend: any): {
    name: string;
    compact: boolean;
    fields: {
        name: string;
        type: any;
        required: boolean;
    }[];
}[];
export declare function rpcTypes(): {
    name: string;
    compact: boolean;
    fields: {
        name: string;
        type: any;
        required: boolean;
    }[];
}[];
export declare function builtinCollections(ns: any, scope: any): {
    name: string;
    schema: string;
    key: string[];
}[];
export declare function builtinDispatches(ns: any): {
    name: string;
    requestType: string;
}[];
export declare function rotateDispatch(ns: any): {
    name: string;
    requestType: string;
};
export declare function rpcCommands(ns: any): ({
    name: string;
    request: {
        name: string;
    };
    response: {
        name: string;
        stream?: undefined;
    };
} | {
    name: string;
    request: {
        name: string;
    };
    response: {
        name: string;
        stream: boolean;
    };
})[];
