import Redis from "ioredis";
import { IrcClientRedisState } from "./IrcClientRedisState";
import { RedisIrcConnection } from "./RedisIrcConnection";
import { ClientId, ConnectionCreateArgs, HEARTBEAT_EVERY_MS,
    InCommandPayload, InCommandType, IrcConnectionPoolCommandIn,
    IrcConnectionPoolCommandOut,
    OutCommandType,
    PROTOCOL_VERSION,
    READ_BUFFER_MAGIC_BYTES,
    REDIS_IRC_POOL_COMMAND_IN_STREAM, REDIS_IRC_POOL_COMMAND_OUT_STREAM,
    REDIS_IRC_POOL_CONNECTIONS, REDIS_IRC_POOL_HEARTBEAT_KEY, REDIS_IRC_POOL_VERSION_KEY } from "./types";

import { Logger } from 'matrix-appservice-bridge';
import { EventEmitter } from "stream";
import TypedEmitter from "typed-emitter";

const log = new Logger('IrcPoolClient');

const CONNECTION_TIMEOUT = 20000;
const MAX_MISSED_HEARTBEATS = 5;

type Events = {
    lostConnection: () => void,
};

export class IrcPoolClient extends (EventEmitter as unknown as new () => TypedEmitter<Events>) {
    private readonly redis: Redis;
    private readonly connections = new Map<ClientId, Promise<RedisIrcConnection>>();
    public shouldRun = true;
    private commandStreamId = "$";
    private missedHeartbeats = 0;
    private heartbeatInterval?: NodeJS.Timer;
    cmdReader: Redis;

    constructor(url: string) {
        super();
        this.redis = new Redis(url, {
            lazyConnect: true,
        });
        this.cmdReader = new Redis(url, {
            lazyConnect: true,
        });
    }

    public async sendCommand<T extends InCommandType>(type: T, payload: InCommandPayload[T]) {
        await this.redis.xadd(REDIS_IRC_POOL_COMMAND_IN_STREAM, "*", type, JSON.stringify({
            origin_ts: Date.now(),
            info: payload,
        } as IrcConnectionPoolCommandIn<T>));
        log.debug(`Sent command in ${type}: ${payload}`);
    }

    public async createOrGetIrcSocket(clientId: string, netOpts: ConnectionCreateArgs): Promise<RedisIrcConnection> {
        const existingConnection = this.connections.get(clientId);
        if (existingConnection) {
            log.warn(`Re-requested ${clientId} within a session, which might indicate a logic error`);
            return existingConnection;
        }
        log.info(`Requesting new client ${clientId}`);
        // Critical section: Do not await here, do any async logic in `clientPromise`.
        // Check to see we are already connected.
        let isConnected = false;
        const clientPromise = (async () => {
            isConnected = (await this.redis.hget(REDIS_IRC_POOL_CONNECTIONS, clientId)) !== null;
            const clientState = await IrcClientRedisState.create(this.redis, clientId);
            return new RedisIrcConnection(this, clientId, clientState);
        })();
        this.connections.set(clientId, clientPromise);
        const client = await clientPromise;

        try {
            if (!isConnected) {
                log.info(`Requesting new connection for ${clientId}`);
                await this.sendCommand(InCommandType.Connect, netOpts);
                // Wait to be told we connected.
            }
            else {
                log.info(`${clientId} is still connected, not requesting connection`);
                await this.sendCommand(InCommandType.ConnectionPing, { clientId });
            }

            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    log.warn(`Connection ${clientId} timed out`);
                    reject(new Error('Connection timed out'))
                }, CONNECTION_TIMEOUT);
                client.once('connect', () => {
                    clearTimeout(timeout);
                    resolve();
                });
                client.once('not-connected', () => {
                    clearTimeout(timeout);
                    reject(new Error('Client was not connected'));
                });
                client.once('error', (err) => {
                    clearTimeout(timeout);
                    reject(err);
                });
            });
            log.info(`Resolved connection for ${clientId}`);

            return client;
        }
        catch (ex) {
            // Clean up after so we can have another attempt
            this.connections.delete(clientId);
            log.warn(`Failed to create client ${clientId}`, ex);
            throw Error(`Failed to create client ${clientId}: ${ex.message}`);
        }
    }

    private async handleCommand<T extends OutCommandType>(
        commandTypeOrClientId: T|ClientId, commandData: IrcConnectionPoolCommandOut<T>|Buffer) {
        // I apologise about this insanity.
        const clientId = Buffer.isBuffer(commandData) ? commandTypeOrClientId : commandData.info.clientId;
        const connection = await this.connections.get(clientId);
        if (Buffer.isBuffer(commandData)) {
            log.debug(`Got incoming write ${commandTypeOrClientId}  (${commandData.byteLength} bytes)`);
        }
        else {
            log.debug(`Got incoming ${commandTypeOrClientId} for ${commandData.info.clientId}`);
        }

        if (commandTypeOrClientId === OutCommandType.PoolClosing) {
            log.warn("Pool has closed, killing the bridge");
            this.emit('lostConnection');
            return;
        }

        if (!connection) {
            log.warn(`Got command ${commandTypeOrClientId} but no client was connected`);
            return;
        }

        switch (commandTypeOrClientId) {
            case OutCommandType.Connected:
                connection.emit('connect');
                connection.setConnectionInfo(
                    (commandData as IrcConnectionPoolCommandOut<OutCommandType.Connected>).info
                );
                break;
            case OutCommandType.Disconnected:
                this.connections.delete(connection.clientId);
                connection.emit('end');
                break;
            case OutCommandType.NotConnected:
                connection.emit('not-connected');
                break;
            case OutCommandType.Error:
                connection.emit('error',
                    new Error((commandData as IrcConnectionPoolCommandOut<OutCommandType.Error>).info.error)
                );
                break;
            default:
                // eslint-disable-next-line no-case-declarations
                const buffer = commandData as Buffer;
                connection.emit('data', buffer);
                break;
        }
    }

    public async close() {
        clearInterval(this.heartbeatInterval);
        this.shouldRun = false;
        this.redis.disconnect();
        this.cmdReader.disconnect();
    }

    public async handleIncomingCommand() {
        const newCmd = await this.cmdReader.xread(
            "BLOCK", 0, "STREAMS", REDIS_IRC_POOL_COMMAND_OUT_STREAM, this.commandStreamId
        ).catch(ex => {
            log.warn(`Failed to read new command:`, ex);
            return null;
        });
        if (newCmd === null) {
            // Unexpected, this is blocking.
            return;
        }
        const [msgId, [cmdType, payload]] = newCmd[0][1][0];
        this.commandStreamId = msgId;

        const commandType = cmdType as OutCommandType|ClientId;
        let commandData: IrcConnectionPoolCommandOut|Buffer;
        if (typeof payload === 'string' && payload[0] === '{') {
            commandData = JSON.parse(payload) as IrcConnectionPoolCommandOut;
        }
        else {
            commandData = Buffer.from(payload).subarray(READ_BUFFER_MAGIC_BYTES.length);
        }
        setImmediate(
            () => this.handleCommand(commandType, commandData)
                .catch(ex => log.warn(`Failed to handle msg ${msgId} (${commandType}, ${payload})`, ex)
                ),
        );
    }

    private async checkHeartbeat() {
        const lastHeartbeat = parseInt(await this.redis.get(REDIS_IRC_POOL_HEARTBEAT_KEY) ?? '0');
        if (lastHeartbeat + HEARTBEAT_EVERY_MS + 1000 > Date.now()) {
            this.missedHeartbeats = 0;
            return;
        }

        // Server may be down!
        this.missedHeartbeats++;
        log.warn(`Missed heartbeat from pool (current: ${this.missedHeartbeats}, max: ${MAX_MISSED_HEARTBEATS})`);
        if (this.missedHeartbeats >= MAX_MISSED_HEARTBEATS) {
            // Catastrophic failure, we need to kill the bridge.
            this.emit('lostConnection');
        }
    }


    public async listen() {
        log.info(`Listening for new commands`);
        let loopCommandCheck: () => void;

        await this.cmdReader.connect();
        await this.redis.connect();

        // First, check if the pool is up.
        const lastHeartbeat = parseInt(await this.redis.get(REDIS_IRC_POOL_HEARTBEAT_KEY) ?? '0');
        if (lastHeartbeat + HEARTBEAT_EVERY_MS + 1000 < Date.now()) {
            // Heartbeat is stale or missing, might not be running!
            throw Error('IRC pool is not running!');
        }

        const version = parseInt(await this.redis.get(REDIS_IRC_POOL_VERSION_KEY) ?? '-1');
        if (version < PROTOCOL_VERSION) {
            // Heartbeat is stale or missing, might not be running!
            throw Error(
                `IRC pool is running an older version (${version})` +
                `of the protocol than the bridge (${PROTOCOL_VERSION}). Restart the pool.`
            );
        }

        this.heartbeatInterval = setInterval(this.checkHeartbeat.bind(this), HEARTBEAT_EVERY_MS);

        // eslint-disable-next-line prefer-const
        loopCommandCheck = () => {
            if (!this.shouldRun) {
                log.info(`Finished`);
                return;
            }
            this.handleIncomingCommand().finally(() => {
                return loopCommandCheck();
            });
        }

        loopCommandCheck();
    }
}
