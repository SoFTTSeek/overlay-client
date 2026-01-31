// Type declarations for hyperswarm
declare module 'hyperswarm' {
  import { EventEmitter } from 'events';
  import { Duplex } from 'stream';

  interface SwarmOptions {
    keyPair?: { publicKey: Buffer; secretKey: Buffer };
    seed?: Buffer;
    maxPeers?: number;
    firewall?: (remotePublicKey: Buffer) => boolean;
    dht?: any;
  }

  interface PeerInfo {
    publicKey: Buffer;
    ban?: (banStatus?: boolean) => void;
    client: boolean;
    topics: Buffer[];
  }

  class Hyperswarm extends EventEmitter {
    constructor(options?: SwarmOptions);
    keyPair: { publicKey: Buffer; secretKey: Buffer };
    connections: Set<Duplex>;
    peers: Map<string, PeerInfo>;

    join(topic: Buffer, options?: { server?: boolean; client?: boolean }): {
      flushed(): Promise<void>;
      destroy(): Promise<void>;
    };

    leave(topic: Buffer): Promise<void>;
    joinPeer(publicKey: Buffer): void;
    leavePeer(publicKey: Buffer): void;
    flush(): Promise<void>;
    destroy(): Promise<void>;

    on(event: 'connection', listener: (socket: Duplex, info: PeerInfo) => void): this;
    on(event: 'update', listener: () => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
  }

  export = Hyperswarm;
}
