import EventEmitter from "node:events";
import { Socket } from "node:net";
import { type IpcServerEvents, type NJUST_AIIpcServer, type IpcMessage } from "@njust-ai/types";
export declare class IpcServer extends EventEmitter<IpcServerEvents> implements NJUST_AIIpcServer {
    private readonly _socketPath;
    private readonly _log;
    private readonly _clients;
    private _isListening;
    constructor(socketPath: string, log?: {
        (...data: any[]): void;
        (message?: any, ...optionalParams: any[]): void;
    });
    listen(): void;
    private onConnect;
    private onDisconnect;
    private onMessage;
    private log;
    broadcast(message: IpcMessage): void;
    send(client: string | Socket, message: IpcMessage): void;
    get socketPath(): string;
    get isListening(): boolean;
}
//# sourceMappingURL=ipc-server.d.ts.map