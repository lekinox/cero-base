declare let version: number;
declare function setVersion(v: any): void;
declare function encode(name: any, value: any, v?: number): any;
declare function decode(name: any, buffer: any, v?: number): any;
declare function getEnum(name: any): void;
declare function getEncoding(name: any): {
    preencode(state: any, m: any): void;
    encode(state: any, m: any): void;
    decode(state: any): {
        key: any;
        length: any;
    };
} | {
    preencode(state: any, m: any): void;
    encode(state: any, m: any): void;
    decode(state: any): {
        invite: any;
        reply: any;
        proof: any;
        identity: any;
        signature: any;
        ts: any;
    };
} | {
    preencode(state: any, m: any): void;
    encode(state: any, m: any): void;
    decode(state: any): {
        epoch: any;
        stamp: any;
        entropy: any;
    };
} | {
    preencode(state: any, m: any): void;
    encode(state: any, m: any): void;
    decode(state: any): {
        status: any;
        reason: any;
        key: any;
        encryptionKey: any;
        epochs: any;
    };
} | {
    preencode(state: any, m: any): void;
    encode(state: any, m: any): void;
    decode(state: any): {
        data: any;
    };
} | {
    preencode(state: any, m: any): void;
    encode(state: any, m: any): void;
    decode(state: any): {
        prev: any;
        next: any;
    };
} | {
    preencode(state: any, m: any): void;
    encode(state: any, m: any): void;
    decode(state: any): {
        id: any;
        name: any;
    };
} | {
    preencode(state: any, m: any): void;
    encode(state: any, m: any): void;
    decode(state: any): {
        coreKey: any;
        blockOffset: any;
        blockLength: any;
        byteOffset: any;
        byteLength: any;
        type: any;
    };
};
declare function getStruct(name: any, v?: number): {
    preencode(state: any, m: any): void;
    encode(state: any, m: any): void;
    decode(state: any): {
        key: any;
        length: any;
    } | {
        invite: any;
        reply: any;
        proof: any;
        identity: any;
        signature: any;
        ts: any;
    } | {
        epoch: any;
        stamp: any;
        entropy: any;
    } | {
        status: any;
        reason: any;
        key: any;
        encryptionKey: any;
        epochs: any;
    } | {
        data: any;
    } | {
        prev: any;
        next: any;
    } | {
        id: any;
        name: any;
    } | {
        coreKey: any;
        blockOffset: any;
        blockLength: any;
        byteOffset: any;
        byteLength: any;
        type: any;
    };
};
declare const resolveStruct: typeof getStruct;
export { resolveStruct, getStruct, getEnum, getEncoding, encode, decode, setVersion, version };
