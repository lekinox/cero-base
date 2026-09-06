declare let version: number;
declare function setVersion(v: any): void;
declare function encode(name: any, value: any, v?: number): any;
declare function decode(name: any, buffer: any, v?: number): any;
declare function getEnum(name: any): void;
declare function getEncoding(name: any): {
    preencode(state: any, m: any): void;
    encode(state: any, m: any): void;
    decode(state: any): {
        status: any;
        reason: any;
        key: any;
        encryptionKey: any;
        extra: any;
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
        id: any;
        name: any;
        role: any;
        noAccept: boolean;
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
} | {
    preencode(state: any, m: any): void;
    encode(state: any, m: any): void;
    decode(state: any): {
        prev: any;
        next: any;
    };
};
declare function getStruct(name: any, v?: number): {
    preencode(state: any, m: any): void;
    encode(state: any, m: any): void;
    decode(state: any): {
        status: any;
        reason: any;
        key: any;
        encryptionKey: any;
        extra: any;
    } | {
        data: any;
    } | {
        id: any;
        name: any;
        role: any;
        noAccept: boolean;
    } | {
        coreKey: any;
        blockOffset: any;
        blockLength: any;
        byteOffset: any;
        byteLength: any;
        type: any;
    } | {
        prev: any;
        next: any;
    };
};
declare const resolveStruct: typeof getStruct;
export { resolveStruct, getStruct, getEnum, getEncoding, encode, decode, setVersion, version };
