export declare const main: {
    'del-by-id': {
        id: import("@cero-base/core").Prim;
    };
    writer: {
        master: import("@cero-base/core").Prim;
        writer: import("@cero-base/core").Prim;
        sig: import("@cero-base/core").Prim;
        isIndexer: import("@cero-base/core").Prim;
        ts: import("@cero-base/core").Prim;
        memberId: import("@cero-base/core").Prim;
        role: import("@cero-base/core").Prim;
    };
    counter: {
        name: import("@cero-base/core").Prim;
        value: import("@cero-base/core").Prim;
    };
    member: {
        id: import("@cero-base/core").Prim;
        key: import("@cero-base/core").Prim;
        role: import("@cero-base/core").Prim;
        name: import("@cero-base/core").Prim;
        createdAt: import("@cero-base/core").Prim;
        updatedAt: import("@cero-base/core").Prim;
        sig: import("@cero-base/core").Prim;
        index: import("@cero-base/core").Prim;
    };
    device: {
        id: import("@cero-base/core").Prim;
        memberId: import("@cero-base/core").Prim;
        name: import("@cero-base/core").Prim;
        isMobile: import("@cero-base/core").Prim;
        createdAt: import("@cero-base/core").Prim;
        updatedAt: import("@cero-base/core").Prim;
        index: import("@cero-base/core").Prim;
    };
    invite: {
        id: import("@cero-base/core").Prim;
        role: import("@cero-base/core").Prim;
        expires: import("@cero-base/core").Prim;
        reuse: import("@cero-base/core").Prim;
        createdAt: import("@cero-base/core").Prim;
        index: import("@cero-base/core").Prim;
        confirm: import("@cero-base/core").Prim;
    };
    handle: {
        id: import("@cero-base/core").Prim;
        type: import("@cero-base/core").Prim;
        key: import("@cero-base/core").Prim;
        encryptionKey: import("@cero-base/core").Prim;
        name: import("@cero-base/core").Prim;
        createdAt: import("@cero-base/core").Prim;
        updatedAt: import("@cero-base/core").Prim;
        index: import("@cero-base/core").Prim;
    };
    file: {
        id: import("@cero-base/core").Prim;
        memberId: import("@cero-base/core").Prim;
        name: import("@cero-base/core").Prim;
        createdAt: import("@cero-base/core").Prim;
        updatedAt: import("@cero-base/core").Prim;
        index: import("@cero-base/core").Prim;
        stamp: import("@cero-base/core").Prim;
    };
    claim: {
        identity: import("@cero-base/core").Prim;
        writer: import("@cero-base/core").Prim;
        sig: import("@cero-base/core").Prim;
        ts: import("@cero-base/core").Prim;
    };
    epoch: {
        epoch: import("@cero-base/core").Prim;
        wrapped: import("@cero-base/core").Prim;
        createdAt: import("@cero-base/core").Prim;
        commit: import("@cero-base/core").Prim;
        stamp: import("@cero-base/core").Prim;
    };
    join: {
        box: import("@cero-base/core").Prim;
    };
    accept: {
        id: import("@cero-base/core").Prim;
        role: import("@cero-base/core").Prim;
    };
    request: {
        id: import("@cero-base/core").Prim;
        identity: import("@cero-base/core").Prim;
        invite: import("@cero-base/core").Prim;
        reply: import("@cero-base/core").Prim;
        createdAt: import("@cero-base/core").Prim;
        index: import("@cero-base/core").Prim;
        admitted: import("@cero-base/core").Prim;
        expires: import("@cero-base/core").Prim;
    };
};
export declare const local: {
    master: {
        seed: import("@cero-base/core").Prim;
    };
    keypair: {
        publicKey: import("@cero-base/core").Prim;
        secretKey: import("@cero-base/core").Prim;
    };
    'handle-keypair': {
        id: import("@cero-base/core").Prim;
        publicKey: import("@cero-base/core").Prim;
        secretKey: import("@cero-base/core").Prim;
        encryptionKey: import("@cero-base/core").Prim;
    };
    serving: {
        id: import("@cero-base/core").Prim;
        type: import("@cero-base/core").Prim;
    };
    join: {
        id: import("@cero-base/core").Prim;
        type: import("@cero-base/core").Prim;
        invite: import("@cero-base/core").Prim;
        publicKey: import("@cero-base/core").Prim;
        secretKey: import("@cero-base/core").Prim;
        key: import("@cero-base/core").Prim;
        encryptionKey: import("@cero-base/core").Prim;
        epochs: import("@cero-base/core").Prim;
    };
    mail: {
        id: import("@cero-base/core").Prim;
        address: import("@cero-base/core").Prim;
        message: import("@cero-base/core").Prim;
        mirrors: import("@cero-base/core").Prim;
    };
    environment: {
        channel: import("@cero-base/core").Prim;
    };
};
export declare const rpc: {
    'req-empty': {
        ok: import("@cero-base/core").Prim;
    };
    'req-restore': {
        phrase: import("@cero-base/core").Prim;
    };
    'req-row': {
        handle: import("@cero-base/core").Prim;
        ref: import("@cero-base/core").Prim;
        data: import("@cero-base/core").Prim;
        local: import("@cero-base/core").Prim;
        noUpsert: import("@cero-base/core").Prim;
    };
    'req-id': {
        handle: import("@cero-base/core").Prim;
        ref: import("@cero-base/core").Prim;
        id: import("@cero-base/core").Prim;
        local: import("@cero-base/core").Prim;
    };
    'req-query': {
        handle: import("@cero-base/core").Prim;
        ref: import("@cero-base/core").Prim;
        query: import("@cero-base/core").Prim;
        local: import("@cero-base/core").Prim;
    };
    'req-call': {
        handle: import("@cero-base/core").Prim;
        op: import("@cero-base/core").Prim;
        data: import("@cero-base/core").Prim;
    };
    'req-invite': {
        handle: import("@cero-base/core").Prim;
        role: import("@cero-base/core").Prim;
        ttl: import("@cero-base/core").Prim;
        reuse: import("@cero-base/core").Prim;
        data: import("@cero-base/core").Prim;
        confirm: import("@cero-base/core").Prim;
    };
    'req-revoke': {
        handle: import("@cero-base/core").Prim;
        invite: import("@cero-base/core").Prim;
    };
    'req-join': {
        parent: import("@cero-base/core").Prim;
        ref: import("@cero-base/core").Prim;
        invite: import("@cero-base/core").Prim;
    };
    'req-cancel': {
        invite: import("@cero-base/core").Prim;
    };
    'req-open': {
        parent: import("@cero-base/core").Prim;
        row: import("@cero-base/core").Prim;
    };
    'req-handle': {
        handle: import("@cero-base/core").Prim;
    };
    'req-set-active': {
        handle: import("@cero-base/core").Prim;
        active: import("@cero-base/core").Prim;
    };
    'res-data': {
        data: import("@cero-base/core").Prim;
    };
    'res-rows': {
        data: import("@cero-base/core").Prim;
        total: import("@cero-base/core").Prim;
        size: import("@cero-base/core").Prim;
    };
    'res-changes': {
        changes: import("@cero-base/core").Prim;
        reset: import("@cero-base/core").Prim;
    };
    'res-invite': {
        invite: import("@cero-base/core").Prim;
    };
    'res-handle': {
        id: import("@cero-base/core").Prim;
        type: import("@cero-base/core").Prim;
        name: import("@cero-base/core").Prim;
    };
    'req-add-file': {
        handle: import("@cero-base/core").Prim;
        data: import("@cero-base/core").Prim;
        name: import("@cero-base/core").Prim;
        type: import("@cero-base/core").Prim;
    };
    'res-identity': {
        id: import("@cero-base/core").Prim;
        deviceId: import("@cero-base/core").Prim;
        fileBase: import("@cero-base/core").Prim;
        fileToken: import("@cero-base/core").Prim;
    };
    'res-joining': {
        invites: import("@cero-base/core").Prim;
    };
    'res-seed': {
        phrase: import("@cero-base/core").Prim;
    };
    'res-ok': {
        ok: import("@cero-base/core").Prim;
    };
    'res-epoch': {
        epoch: import("@cero-base/core").Prim;
    };
    'res-error': {
        message: import("@cero-base/core").Prim;
        code: import("@cero-base/core").Prim;
        stack: import("@cero-base/core").Prim;
    };
};
