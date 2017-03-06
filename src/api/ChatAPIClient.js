// @flow
import url from "url";
import createDebug from "debug";
import WebSocket from "ws";
import Promise, { CancellationError, TimeoutError } from "bluebird";
import { green, blue } from "colors";
import { 
    without,
    size,
    isEqual
} from "lodash";
import { AbstractAPIClient, HTTPError } from "./CommonAPIClient";
import config from "../../config.json";
import pkg from "../../package.json";

const debug = createDebug("tw-chat:api");

/**
 * The time in ms between pings.
 * 
 * @type {Number}
 */
const PING_INTERVAL = 10000;

/**
 * The maximum amount of pings allowed fail before the socket is like "hang on,
 * something isn't right" and it assumes the connection is broken then
 * forcefully disconnects the socket from the server (it does not wait until
 * the `readyState` is `WebSocket.CLOSED` that is, it's really slow).
 * 
 * @type {Number}
 */
const PING_MAX_ATTEMPT = 3;

/**
 * The timeout in ms for the ping `socketRequest`. This, in conjunction with
 * PING_INTERVAL and PING_MAX_ATTEMPT, allows you to configure the reaction
 * time for broken connection to the server. To calculate the maximum amount
 * of time before the APIClient will realize the connection is broken, use
 * this formula:
 *
 *      PING_INTERVAL + (PING_MAX_ATTEMPT * PING_TIMEOUT)
 *
 *      5000 + (3 * 3000) = 14000ms or 14 seconds until `close` event fires.
 *
 * @type {Number}
 */
const PING_TIMEOUT = 3000;

/**
 * The legal values for updating user status with `updateStatus`.
 * 
 * @type {Array}
 */
export const STATUS_TYPES = ["idle", "active"];

/**
 * The global nonce counter. Scoped to this APIClient module only so
 * nobody outside can fiddle with it.
 *
 * @private
 * @type {Number}
 */
let NONCE = 0;

type APIFrame = {
    name: string,
    contents: Object,
    nonce?: number|null
};

type FrameFilter = string|{
    type?: string,
    nonce?: number,
    contents?: Object
};

type Status = "idle" | "active";

/**
 * The (mostly) raw connector to the Teamwork Chat API. This intentionally DOES NOT
 * transform the returned response from the API (aside from deserializing the JSON),
 * that is left up to the TeamworkChat class. This class does not know about any
 * Person, Message or Room objects and only accepts values.
 *
 * Events:
 *
 *      "connected":
 *
 *          Emitted when the client successfully connects to the API socket. This is
 *          emitted after authentication was successful.
 *          
 *      "message": ({String} message)
 *
 *          Emitted when the client recieves a "message" from the server.
 *      
 *      "frame": ({Object} frame)
 *
 *          Emitted when the client recieves a "message" from the server and the contents
 *          of the message is parsed.
 *          
 *      "close":
 *
 *          Emitted when the connection to the server closes.
 *          
 *      "error": ({Error} error)
 *
 *          Emitted when an error occurs within the API client (usually in the underlying
 *          Websocket).
 *          
 */
export default class ChatAPIClient extends AbstractAPIClient {
    /** @type {Function} The implementation of the WebSocket class */
    static WebSocket = WebSocket;

    /**
     * The filters waiting to be matches to frames.
     * 
     * @type {Array<Object>}
     */
    awaiting: {filter: FrameFilter, resolve: Function, reject: Function}[] = [];

    /** @type {WebSocket} The Chat websocket. */
    socket: WebSocket;

    /**
     * Contains the reject function of the current ping promise. Don't touch.
     * 
     * @private
     * @type {Function}
     */
    _nextPingReject: Function;

    /**
     * Send a raw object down the socket.
     * 
     * @param  {Object|String}    frame The object (will be serialized) or string.
     * @return {Promise<String>}        The frame object (or string) sent.
     */
    send(frame: Object|string): Promise<string> {
        debug("sending message", frame);
        return Promise.try(() => {
            if(!this.connected) {
                throw new Error("Socket is not connected to the server. Please reconnect.");
            }

            frame = typeof frame === "object" ? JSON.stringify(frame) : frame;
            this.socket.send(frame);

            return frame;
        });
    }

    /**
     * Send a frame down the socket to the server.
     * 
     * @param  {String}         name        The type of the frame. See APICLient.createFrame.
     * @param  {Object|String}  contents    The contents of the frame.
     * @return {Promise<Object>}    Resolves the raw packet object sent down the line.
     */
    sendFrame(type: string, contents: Object = {}): Promise<APIFrame> {
        const frame = ChatAPIClient.createFrame(type, contents);
        return this.send(frame).return(frame);
    }

    /**
     * Await a frame given a filter.
     * 
     * @param  {Object} filter      A filter supplied to APIClient.matchFrame.
     * @param  {Number} timeout     The number in ms before timing out (defaults 30s).
     * @return {Promise<Object>}    Resolves to the raw object packet returned from the server.
     */
    awaitFrame(filter: FrameFilter, timeout: number = 30000): Promise<APIFrame> {
        return new Promise((resolve, reject) => {
            this.awaiting.push(filter = {
                filter, resolve, reject
            });
        }).catch(CancellationError, () => {
            return; // Ignore the cancellation error.
        }).timeout(timeout, `Awaiting frame ${JSON.stringify(filter)} has timed out.`).finally(() => {
            this.awaiting = without(this.awaiting, filter);
        });
    }

    /**
     * Await multiple packets and pick (resolve) the first.
     * 
     * @param  {...Object} filters  Filters applied to APIClient#awaitFrame.
     * @return {Promise<Object>}    Resolves to the raw object packet returned from the server.
     */
    raceFrames(...filters: FrameFilter[]): Promise<APIFrame> {
        const race = filters.map(filter => this.awaitFrame(filter));

        return Promise.any(race).finally(() => {
            // Kill any waiting promises.
            race.forEach((prom, i) => {
                if(prom.isPending()) {
                    // Find the pending filter
                    const filter = this.awaiting.find(({ filter }) => filter === filters[i]);

                    // Remove it from the awaiting
                    this.awaiting = without(this.awaiting, filter);

                    // Raise the cancellation
                    if(filter) {
                        filter.reject(new CancellationError());
                    }
                }
            });
        });
    }

    /**
     * Send a request down the socket. A "request" is a frame that receives a response (i.e.
     * matching nonces).
     * 
     * @param  {String} type        The type of the frame. See APICLient.createFrame.
     * @param  {Object} contents       The contents of the frame. See APICLient#createFrame.
     * @param  {Number} timeout     The number of ms before timing out the request.
     * @return {Promise<Object>}    Resolves to the reponse frame.
     */
    socketRequest(type: string, contents: Object, timeout?: number): Promise<APIFrame> {
        debug(`socket request: ${type}`, JSON.stringify(contents))
        return this.sendFrame(type, contents).then(packet => {
            return this.awaitFrame({ nonce: packet.nonce }, timeout);
        }).tap(packet => {
            debug("socket response:", JSON.stringify(packet));
        });
    }

    /**
     * Event Handler: when the client's websocket emits "error"
     * 
     * @param  {Error} error
     */
    onSocketError(error: Error) {
        debug("socket error", error);
        this.emit("error", error);
    }

    /**
     * Event Handler: when the client's websocket emits "message"
     * 
     * @param  {String} message Raw frame string returned from server.
     */
    onSocketMessage(message: string) {
        debug("incoming frame", message);
        const frame = JSON.parse(message);

        if(this.awaiting.length) {
            this.awaiting.slice().forEach(filter => {
                if(ChatAPIClient.matchFrame(filter.filter, frame)) {
                    filter.resolve(frame);
                }
            });
        }

        this.emit("message", message);
        this.emit("frame", frame);
    }

    /**
     * Event Handler: when the client's websocket emits "close"
     */
    onSocketClose() {
        debug("socket closed");
        this.stopPing();
        this.emit("close");
    }

    /**
     * Connect to the Chat socket server.
     * 
     * @return {Promise<APIClient>} Resolves when the server has successfully completed authentication.
     */
    connect(): Promise<ChatAPIClient> {
        return this.initialize().then(user => {
            return new Promise((resolve, reject) => {
                const { hostname } = url.parse(this.client.installation);
                const env = hostname && hostname.match(/teamwork.com/) ? "production" : "development"
                let server = config[env].server;

                if(env === "development") {
                    server = {
                        ...server, hostname
                    };
                }

                const socketServer = url.format({
                    ...server,
                    slashes: true
                });

                debug(`connecting socket server to ${socketServer}`);
                this.socket = new ChatAPIClient.WebSocket(socketServer, {
                    headers: {
                        Cookie: `tw-auth=${this.client.auth}`
                    }
                });

                this.socket.on("message", this.onSocketMessage.bind(this));

                // Attach the reject handler for the error handler, see below for when we remove it
                // and add replace it with `onSocketError` handler when the authentication flow completes.
                this.socket.on("error", reject);

                // The authentication flow.
                this.socket.on("open", () => {
                    // Wait for the authentication request frame and send back the auth frame.
                    this.awaitFrame("authentication.request").then(message => {
                        const user = this.client.user;

                        return this.sendFrame("authentication.response", {
                            authKey: user.authkey,
                            userId: parseInt(user.id),
                            installationDomain: user.url,
                            installationId: parseInt(user.installationId),
                            clientVersion: pkg.version
                        });
                    }).then(() => {
                        // Race the error or confirmation frames.
                        return this.raceFrames("authentication.error", "authentication.confirmation");
                    }).then(frame => {
                        if(frame.name === "authentication.error") {
                            throw new Error(frame.contents);
                        }

                        // Start the pinging to ensure our socket doesn't get disconnected for inactivity,
                        // and to monitor our connection.
                        this.nextPing();

                        // Remove the "error" handler and replace it with the `onSocketError`.
                        this.socket.removeListener("error", reject);
                        this.socket.on("error", this.onSocketError.bind(this));
                        this.socket.on("close", this.onSocketClose.bind(this));

                        resolve(this);

                        this.emit("connected");

                        // Silence "created promised without returning" errors
                        return null;
                    }).catch(reject);
                });
            });
        });
    }

    /**
     * Start sending ping frames (not Websocket pings) down the socket to ensure the server doesn't cut
     * our connection. This STARTS the pinging and will resolve when you stop the pinging with `stopPing`.
     * 
     * @param  {Number} attempt PRIVATE: The number used to track which attempt were on, do not use.
     * @return {Promise}        A promise that resolves when `stopPing` is called.
     */
    nextPing(attempt:number = 0): Promise<APIFrame> {
        return new Promise((resolve, reject) => {
            debug("attempting ping");

            // We save this so `stopPing` can forcefully stop the pinging.
            this._nextPingReject = reject;

            // God, this hurts my promises but it's the only nice way to do standardized cancellation (A+)
            // Send the ping down the socket and wait PING_INTERVAL before attempting the next ping.
            // We `delay` here instead of before the next, outside `then` so we can reject without
            // having a pending ping left.
            this.ping().delay(PING_INTERVAL).then(resolve).catch(TimeoutError, err => {
                if(attempt < PING_MAX_ATTEMPT) {
                    debug(`ping timed out, attempting again (attempt = ${attempt})`);
                    this.nextPing(attempt + 1);
                } else {
                    debug(`third ping attempt failed, assuming socket connection is broken. Closing.`);
                    reject(err);
                }

                // Silence the "you created a promise and didn't return it" warning
                return null;
            }).catch(err => this.emit.bind(this, "error"));
        }).then(() => {
            debug("ping succeeded");
            this.nextPing();

            return null; // Again, silencing the errors like above
        }).catch(CancellationError, () => {
            debug("ping stopped");
        }).catch(TimeoutError, () => {
            debug("pinging stopped, connection broken");
            this.close();
        });
    }

    /**
     * Stop sending the ping frames to the server.
     */
    stopPing() {
        if(this._nextPingReject) {
            debug("stopping ping");
            this._nextPingReject(new CancellationError());
        }
    }

    /**
     * Close the socket connection to the server. This IMMEDIATELY calls `onSocketClose`
     * i.e. the `close` event. It doesn't wait for the underlying socket to close it's 
     * connection to the server because it is SLOW.
     */
    close() {
        // Closing a socket takes a while so to speed up the process, we
        // manually call `onSocketClose` and remove the original `close` event 
        // handler from the socket that would also call it from the socket.
        // It still closes gracefully but we don't care when it does.
        this.socket.removeAllListeners("close");

        debug("forcefully closing socket");
        this.socket.close();

        this.onSocketClose();
    }

    /**
     * Test if socket is connected to server.
     * 
     * @return {Boolean} connected or not.
     */
    isConnected(): boolean {
        return this.socket && this.socket.readyState === WebSocket.OPEN;
    }

    /**
     * Socket Event: "room.message.created" - Send (or create) a message to a room.
     * 
     * @param  {Number}     room    The target room to recieve the message.
     * @param  {Object}     message The message to send.
     * @return {Promise<Object>}    The raw response frame returned from the server.
     */
    sendMessage(room: number, message: Object): Promise<APIFrame> {
        return this.socketRequest("room.message.created", {
            roomId: room,
            body: message
        }).then(({ contents }) => contents);
    }

    /**
     * Update the currently logged in user's status.
     * 
     * @param {String} status One of: "idle"|"active"
     */
    updateStatus(status: Status): Promise<APIFrame> {
        return this.sendFrame("user.modified.status", { status })
    }

    /**
     * Get the unseen counts from the server.
     * 
     * @return {Promise<Object>} Resolves to the unseen counts frame from the socket server.
     */
    getUnseenCount(): Promise<APIFrame> {
        return this.sendFrame("unseen.counts.request").then(() => {
            return this.awaitFrame("unseen.counts.updated");
        });
    }

    /**
     * Send the `room.user.active` frame for a room.This frame has no response, it's fire and forget.
     * 
     * @param  {Number} room        The room ID to send the room active frame for.
     * @return {Promise<Object>}    Resolves to the sent frame.
     */
    activateRoom(room: number): Promise<APIFrame> {
        return this.sendFrame("room.user.active", {
            roomId: room,
            date: new Date()
        });
    }

    /**
     * Send the `room.typing` frame for a room. This frame has no response, it's fire and forget.
     * 
     * @param  {Boolean} isTyping Whether typing or not.
     * @param  {Number}  room     The room ID.
     * @return {Promise<Object>}    Resolves to the sent frame.
     */
    typing(isTyping: boolean, room: number): Promise<APIFrame> {
        return this.sendFrame("room.typing", {
            isTyping: status,
            roomId: room
        });
    }

    /**
     * Send a ping frame to the server. This socket request times out after
     * PING_TIMEOUT and rejects the promise.
     * 
     * @param  {Number}         timeout The timeout before the socket request times out. Default: PING_TIMEOUT
     * @return {Promise<Object>}        Resolves to the recieved ping frame.
     */
    ping(timeout: number = PING_TIMEOUT): Promise<APIFrame> {
        return this.socketRequest("ping", {}, timeout);
    }

    /**
     * GET /chat/v2/people.json - Return a list of people.
     *
     * @param  {Object} filter        Passed filter params to the API.
     * @param  {String} filter.since  Timestamp to only return values updated since timestamp.
     * @param  {Number} offset        The cursor offset on the list of people.
     * @param  {Number} limit         The amount of people to return after the cursor offset.
     * @return {Promise<Object>}      The list of people.
     */
    getPeople(filter: Object = {}, offset: number, limit: number): Promise<Object> {
        const query = {};

        if(filter.since) {
            query.filter = {
                updatedAfter: filter.since
            };
        }

        return this.requestList("/chat/v3/people.json", { offset, limit, query });
    }

    /**
     * GET /chat/people/<id>.json - Get a person by ID.
     * 
     * @param  {Number}         id  The person's ID.
     * @return {Promise<Object>}    Person object response.
     */
    getPerson(id: number): Promise<Object> {
        return this.request(`/chat/people/${id}.json`);
    }

    /**
     * PUT /chat/people/<id>.json - Update a persons details.
     * 
     * @param  {Number}          id     The person's ID.
     * @param  {Object}          update The update object.
     * @return {Promise<Object>}        The API response object.
     */
    updatePerson(id: number, update: Object): Promise<Object> {
        return this.request(`/chat/people/${id}.json`, {
            method: "PUT",
            body: update
        });
    }

    /**
     * POST /chat/v2/rooms.json - Create a new room with handles and an initial message.
     * 
     * @param  {Array<String>}  handles  Array of user handles (without `@` symbol).
     * @param  {String}         message  The initial message for the new room.
     * @return {Promise<Object>}         The server response with the room ID.
     */
    createRoom(handles: string[], message: string): Promise<Object> {
        return this.request("/chat/v2/rooms.json", {
            method: "POST",
            body: {
                room: {
                    handles,
                    message: {
                        body: message
                    }
                }
            }
        });
    }

    /**
     * DELETE /chat/room/<room>.json - Delete a room.
     * 
     * @param  {Number} room The room ID.
     * @return {Promise}     Resolves when the room is deleted.
     */
    deleteRoom(room: number): Promise<Object> {
        return this.request(`/chat/rooms/${room}.json`, {
            method: "DELETE"
        });
    }

    /**
     * PUT /chat/v2/conversations/<room>.json - Update a room title.
     *
     * This could be a generic "update" room method but one: there are only
     * two ways a conversation details and two: the methods are vastly
     * different.
     * 
     * @param  {Number} room   The room ID to update.
     * @param  {String} title  The room title.
     * @return {Promise}       Resolves when update is complete.
     */
    updateRoomTitle(room: number, title: string): Promise<Object> {
        return this.request(`/chat/v2/conversations/${room}.json`, {
            method: "PUT",
            body: { 
                conversation: { title } 
            }
        })
    }

    /**
     * GET /chat/v2/rooms/<room>.json - Get a room from the server.
     * 
     * @param  {Number}          room                   The room ID.
     * @param  {Object}          filter                 Filter returned results.
     * @param  {Boolean}         filter.includeUsers    Include user data in returned results.
     * @return {Promise<Object>}                        Return a room object from the API.
     */
    getRoom(room: number, { includeUsers }: { includeUsers: boolean } = { includeUsers: true }) {
        return this.request(`/chat/v2/rooms/${room}.json`, {
            query: { includeUserData: includeUsers }
        });
    }

    /**
     * GET /chat/v2/conversations.json - Return list of conversations.
     *
     * @param  {Object}  filter                     Filter returned rooms (i.e. query appended to URL).
     * @param  {Boolean} filter.includeMessages     Include message data (last message) in the returned rooms.
     * @param  {Boolean} filter.includeUsers        Include data for people in rooms.
     * @param  {String}  filter.sort                Sort results, values: "lastActivityAt"
     * @param  {String}  filter.status              Filter by status, values: "all"
     * @param  {String}  filter.since               Return conversations that have activity after timestamp.
     * @param  {Number}  offset                     The conversation cursor offset.
     * @param  {Number}  limit                      The number of conversations after the cursor to get.
     * @return {Promise<Array>}                     The list of conversations. See Teamwork API Docs.
     */
    getRooms(filter: Object, offset: number = 0, limit: number = 10) {
        filter = {
            includeMessages: true,
            includeUsers: true,
            sort: "lastActivityAt",
            ...filter
        };

        const query = {
            includeUserData: filter.includeUsers,
            includeMessageData: filter.includeMessages,
            sort: "lastActivityAt",
            filter: undefined
        };

        if(filter.status || filter.since) {
            query.filter = {};
            if(filter.status) query.filter.status = filter.status;
            if(filter.since) query.filter.activityAfter = filter.since;
        }

        return this.requestList(`/chat/v2/conversations.json`, {
            offset, limit, query
        });
    }

    /**
     * Get a logged in user's messages (without room). 
     *
     * Note: Unfortunately, this doesn't follow the other pagination schema so you're 
     * on your own with regards to iterating the pages and the like.
     *
     * @param  {Object} filter          Object containing filters.
     * @param  {String} filter.since    Timestamp to get message from now until `since`.
     * @param  {Number} page            The page number.
     * @param  {Number} pageSize        The amount of messages to return per page.
     * @return {Promise<Object>}        The messages from the API.
     */
    getUserMessages({ since }: Object, page: number = 1, pageSize: number = 50): Promise<Object> {
        return this.request("/chat/v2/messages.json", {
            query: {
                createdAfter: since,
                page, pageSize
            }
        });
    }

    /**
     * GET /chat/v2/rooms/<room>/messages.json - Get messages for a room.
     *  
     * @param  {Number} room The room ID.
     * @return {Object}      The messages return from the API.
     */
    getMessages(room: number): Promise<Object> {
        return this.request(`/chat/v2/rooms/${room}/messages.json`);
    }

    /**
     * Create a frame to send to the socket server.
     * 
     * @param  {String}     type     The frame type or identifier.
     * @param  {Any}        contents The contents of the frame.
     * @param  {Boolean}    nonced   Whether or not to nonce the frame.
     * @return {Object}              The raw object packet to be stringified and sent to the server.
     */
    static createFrame(type: string, contents: Object = {}, nonced: boolean = true): APIFrame {
        return {
            contentType: "object",
            source: {
                name: "Teamwork Chat Node API",
                version: pkg.version
            },
            nonce: nonced ? ++NONCE : null,
            name: type,
            contents
        }
    }

    /**
     * Test if a filter matches a give frame.
     *
     * Filters:
     *     Filters are objects that describe how to match the passed frame. They
     *     are essentially like an Object Regex specifically made for Teamwork
     *     Chat socket frames. The filter objects can contain various properties
     *     that dictate how we match that frame. The follow properties are supported:
     *
     *          "type"      {String}    Match the exact frame type.
     *          "nonce"     {Number}    Match the exact nonce of the frame.
     *          "contents"  {Object}    Deep equal contents object.
     *
     *     Fitlers can also be specified in shorthand:
     *      - If the filter is a string, it is converted to a `{ type: <filter> }` object.
     *      
     * @param  {Object|String}  fitlers     See "Filters" section above.
     * @param  {Object}         frame       The raw frame packet returned from the server.
     * @return {Boolean}                    Whether or not the filter matches the frame.
     */
    static matchFrame(filter: FrameFilter, frame: APIFrame): boolean {
        if(typeof filter === "string")
            filter = { type: filter };

        let matches = [];

        if(filter.type && typeof filter.type === "string") {
            matches.push(filter.type === frame.name);
        } 

        if(filter.nonce) {
            matches.push(filter.nonce === frame.nonce);
        }

        if(filter.contents) {
            matches.push(isEqual(filter.contents, frame.contents));
        }

        if(!matches.length) {
            throw new Error("No filters specified in `matchFrame`. If you want to match all frames, listen for `frame` event.");
        }

        return matches.every(match => match);
    }

    /**
     * Custom `console.log` output.
     */
    inspect(): string {
        return `ChatAPIClient[authorized, auth=${this.client.auth}]`;
    }
}