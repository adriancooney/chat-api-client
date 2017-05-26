import url from "url";
import { inspect } from "util";
import { EventEmitter } from "events";
import qs from "qs";
import createDebug from "debug";
import WebSocket from "ws";
import fetch from "node-fetch";
import Promise, { CancellationError, TimeoutError } from "bluebird";
import { green, blue } from "colors";
import {
    without,
    omit,
    size,
    merge,
    omitBy,
    isEqual,
    isUndefined,
    isPlainObject
} from "lodash";
import { indent } from "./util";
import config from "../config.json";
import pkg from "../package.json";

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
 * Filter out these frames from output.
 * @type {Array}
 */
const DEBUG_FILTERED_FRAMES = ["pong", "ping"];

/**
 * The global nonce counter. Scoped to this APIClient module only so
 * nobody outside can fiddle with it.
 *
 * @private
 * @type {Number}
 */
let NONCE = 0;

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
export default class APIClient extends EventEmitter {
    /** @type {Function} The implementation of the WebSocket class */
    static WebSocket = WebSocket;

    /**
     * The filters waiting to be matches to frames.
     *
     * @type {Array<Object>}
     */
    awaiting = [];

    /**
     * The current logged in user's account details returned from `me.json`
     * @type {Object}
     */
    user;

    /**
     * Create an authorized APIClient object.
     *
     * @param  {String} installation The user's installation.
     * @param  {String} auth         The `tw-auth` token.
     * @return {APIClient}           The authorized APIClient instance.
     */
    constructor(installation, auth, socketServer) {
        super();

        this.installation = installation;
        this.auth = auth;
        this.socketServer = socketServer;
        this.debug = createDebug("tw-chat:api");
    }

    /**
     * Send a raw object down the socket.
     *
     * @param  {Object|String}          frame The object (will be serialized) or string.
     * @return {Promise<Object|String>}       The frame object (or string) sent.
     */
    send(frame) {
        return Promise.try(() => {
            if(!this.connected) {
                throw new Error("Socket is not connected to the server. Please reconnect.");
            }

            if(!DEBUG_FILTERED_FRAMES.includes(frame.name)) {
                this.debug("sending message \n" + indent(JSON.stringify(frame, null, 2)) + "\n");
            }

            frame = typeof frame === "object" ? JSON.stringify(frame) : frame;

            this.socket.send(frame);

            return frame;
        });
    }

    /**
     * Send a frame down the socket to the server.
     *
     * @param  {String} name        The type of the frame. See APICLient.createFrame.
     * @param  {Any}    contents    The contents of the frame.
     * @return {Promise<Object>}    Resolves the raw packet object sent down the line.
     */
    sendFrame(type, contents = {}) {
        const frame = APIClient.createFrame(type, contents);
        return this.send(frame).return(frame);
    }

    /**
     * Await a frame given a filter.
     *
     * @param  {Object} filter      A filter supplied to APIClient.matchFrame.
     * @param  {Number} timeout     The number in ms before timing out (defaults 30s).
     * @return {Promise<Object>}    Resolves to the raw object packet returned from the server.
     */
    awaitFrame(filter, timeout = 30000) {
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
     * Buffer a specific amount of frames and return them once the buffer is full.
     * @param  {Number} count The size of the buffer (default: 1)
     * @return {Promise<Array>} Resolves to an array of frames.
     */
    bufferFrames(count = 1) {
        const bufferedFrames = []

        return new Promise((resolve) => {
            const handler = frame => {
                debug("frame received")
                if(bufferedFrames.length < count) {
                    bufferedFrames.push(frame);

                    debug(`buffering frame for await, ${count - bufferedFrames.length} left`);

                    if(bufferedFrames.length >= count) {
                        debug("buffered frame count")
                        this.removeListener("frame", handler);

                        return resolve(bufferedFrames);
                    }
                }
            };

            this.on("frame", handler);
        });
    }

    /**
     * Await multiple packets and pick (resolve) the first.
     *
     * @param  {...Object} filters  Filters applied to APIClient#awaitFrame.
     * @return {Promise<Object>}    Resolves to the raw object packet returned from the server.
     */
    raceFrames(...filters) {
        const race = filters.map(filter => this.awaitFrame(filter));

        return Promise.any(race).finally(() => {
            // Kill any waiting promises.
            race.forEach((prom, i) => {
                if(prom.isPending()) {
                    const filter = this.awaiting.find(({ filter }) => filter === filters[i]);
                    this.awaiting = without(this.awaiting, filter);
                    filter.reject(new CancellationError());
                }
            });
        });
    }

    /**
     * Send a request down the socket. A "request" is a frame that receives a response (i.e.
     * matching nonces).
     *
     * @param  {String} type        The type of the frame. See APICLient.createFrame.
     * @param  {Object} frame       The contents of the frame. See APICLient#createFrame.
     * @param  {Number} timeout     The number of ms before timing out the request.
     * @return {Promise<Object>}    Resolves to the reponse frame.
     */
    socketRequest(type, frame, timeout) {
        if(!DEBUG_FILTERED_FRAMES.includes(type)) {
            this.debug(`socket request: ${type} (timeout = ${timeout})`, JSON.stringify(frame))
        }

        return this.sendFrame(type, frame).then(packet => {
            return this.awaitFrame({ nonce: packet.nonce }, timeout);
        }).tap(packet => {
            if(!DEBUG_FILTERED_FRAMES.includes(packet.name)) {
                this.debug("socket response:", JSON.stringify(packet));
            }
        });
    }

    /**
     * Event Handler: when the client's websocket emits "error"
     *
     * @param  {Error} error
     */
    onSocketError(error) {
        this.debug("socket error", error);
        this.emit("error", error);
    }

    /**
     * Event Handler: when the client's websocket emits "message"
     *
     * @param  {String} message Raw frame string returned from server.
     */
    onSocketMessage(message) {
        try {
            const frame = JSON.parse(message);

            if(!DEBUG_FILTERED_FRAMES.includes(frame.name)) {
                this.debug("incoming frame\n" + indent(JSON.stringify(frame, null, 2)) + "\n");
            }

            if(this.awaiting.length) {
                this.awaiting.slice().forEach(filter => {
                    if(APIClient.matchFrame(filter.filter, frame)) {
                        filter.resolve(frame);
                    }
                });
            }

            this.emit("message", message);
            this.emit("frame", frame);
        } catch(err) {
            this.debug("bad frame", err, inspect(message));
            this.emit("error", Object.assign(new Error(`Error parsing frame`), { message }));
        }
    }

    /**
     * Event Handler: when the client's websocket emits "close"
     */
    onSocketClose(reason, code = "none", message = "none") {
        this.debug("socket closed");
        this.stopPing();

        // Reject any awaiting frames
        if(this.awaiting.length) {
            this.awaiting.forEach(({ reject, filter }) => {
                return reject(new Error(
                    `Socket closed for @${this.user.handle}, reason: ${reason}, code: ${code}, message: ${message}`
                ));
            });
        }

        this.emit("close");
    }

    /**
     * Complete the authentication flow with Teamwork Chat.
     *
     * @param  {Object} user The user `account` object returned from GET /me.json.
     * @return {Promise} Resolves when authentication is completed successfully.
     */
    authenticate(user) {
        this.debug("authenticating with chat-server, awaiting authentication.request challenge");
        return this.awaitFrame("authentication.request").then(() => {
            this.debug("challenge recieved, responding with auth");
            return this.sendFrame("authentication.response", {
                authKey: user.authkey,
                userId: parseInt(user.id),
                installationDomain: user.url,
                installationId: parseInt(user.installationId),
                clientVersion: pkg.version
            });
        }).then(() => {
            this.debug("awaiting response with success or failure")
            // Race the error or confirmation frames.
            return this.raceFrames("authentication.error", "authentication.confirmation");
        }).then(frame => {
            if(frame.name === "authentication.error") {
                this.debug("authentication failed");
                throw new Error(frame.contents);
            }

            this.debug("successfully authenticated");

            // Start the pinging
            this.startPing();

            return null;
        });
    }

    getSocketServer() {
        if(typeof this.socketServer === "string") {
            return this.socketServer;
        }

        // Decide if were working on production or development environment by looking at the hostname
        const { hostname } = url.parse(this.installation);
        const env = hostname.match(/teamwork.com/) ? "production" : "development";

        // grab the connection details from the config based on the env
        let server = config[env].server;

        // If it's the development environment, we want to hit the `hostname` but
        // also configure the ports and protocol.
        if(env === "development") {
            server = {
                ...server, hostname
            };
        }

        return url.format({
            ...server,
            slashes: true
        });
    }

    /**
     * Connect to the Chat socket server.
     *
     * @param  {boolean} authenticate Whether or not to automatically authenticate with the server.
     * @return {Promise<APIClient>} Resolves when the server has successfully completed authentication.
     */
    connect(authenticate = true) {
        const bufferedMessages = [];
        const bufferMessage = message => bufferedMessages.push(message);

        return this.getProfile().then(res => {
            // Save the logged in user's account to `user`;
            this.user = Object.assign(res.account, res.account.user, {
                id: parseInt(res.account.id)
            });

            const socketServer = this.getSocketServer();

            return new Promise((resolve, reject) => {
                this.debug(`connecting socket server to ${socketServer}`);
                this.socket = new APIClient.WebSocket(socketServer, {
                    headers: {
                        Cookie: `tw-auth=${this.auth}`
                    }
                });

                this.socket.on("message", bufferMessage);

                // Attach the reject handler for the error handler, see below for when we remove it
                // and add replace it with `onSocketError` handler when the authentication flow completes.
                this.socket.on("error", reject);

                // The authentication flow.
                this.socket.on("open", () => {
                    // Remove the "error" handler.
                    this.socket.removeListener("error", reject);

                    // Remove the "error" handler and replace it with the `onSocketError`.
                    this.socket.on("error", this.onSocketError.bind(this));
                    this.socket.on("close", this.onSocketClose.bind(this, "Socket was closed by the WebSocket client (usually server related)"));

                    // Update the debug to differentiate between users
                    this.debug.namespace = "tw-chat:api:@" + this.user.handle;

                    // Resolve when the socket opens
                    resolve(this.socket);
                });
            });
        }).tap(() => {
            // This sucks. There's a race condition between binding event listeners or `awaitFrame`
            // and the first frame coming in. This code isn't necessary with the current chat-server
            // implementation because there is a delay between the opening of the socket and the
            // first `authentication.request` frame which gives us time to `awaitFrame("authentication.request")`
            // however with our new, shiny `chat-ws-proxy`, it's too fast and we drop the first frame.
            // We add in a delay of 10ms to give users a chance to listen for events/awaitFrame.
            Promise.delay(10).then(() => {
                this.socket.removeListener("message", bufferMessage);
                this.socket.on("message", this.onSocketMessage.bind(this));

                bufferedMessages.forEach(message => {
                    this.onSocketMessage(message);
                });
            });

            return null;
        }).then(() => {
            if(authenticate) {
                return this.authenticate(this.user);
            }
        }).then(() => {
            this.emit("connected");

            return this;
        });
    }

    /**
     * Start pinging the server.
     */
    startPing() {
        this.pinging = true;
        this.nextPing();
    }

    /**
     * Start sending ping frames (not Websocket pings) down the socket to ensure the server doesn't cut
     * our connection. This STARTS the pinging and will resolve when you stop the pinging with `stopPing`.
     *
     * @param  {Number} attempt PRIVATE: The number used to track which attempt were on, do not use.
     * @return {Promise}        A promise that resolves when `stopPing` is called.
     */
    nextPing(attempt = 0) {
        if(!this.pinging) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            // We save this so `stopPing` can forcefully stop the pinging.
            this._nextPingReject = reject;

            // God, this hurts my promises but it's the only nice way to do standardized cancellation (A+)
            // Send the ping down the socket and wait PING_INTERVAL before attempting the next ping.
            // We `delay` here instead of before the next, outside `then` so we can reject without
            // having a pending ping left.
            this.ping().delay(PING_INTERVAL).then(resolve).catch(TimeoutError, err => {
                if(attempt < PING_MAX_ATTEMPT) {
                    this.debug(`ping timed out, attempting again (attempt = ${attempt})`);
                    this.nextPing(attempt + 1);
                } else {
                    this.debug(`third ping attempt failed, assuming socket connection is broken. Closing.`);
                    reject(err);
                }

                // Silence the "you created a promise and didn't return it" warning
                return null;
            }).catch(err => this.emit.bind(this, "error"));
        }).then(() => {
            this.debug("ping pong");
            this.nextPing();

            return null; // Again, silencing the errors like above
        }).catch(CancellationError, () => {
            this.debug("pinging stopped");
        }).catch(TimeoutError, () => {
            this.debug("pinging stopped, connection broken");
            this.close();
        });
    }

    /**
     * Stop sending the ping frames to the server.
     */
    stopPing() {
        this.pinging = false;

        if(this._nextPingReject) {
            this.debug("stopping ping");
            this._nextPingReject(new CancellationError());
            delete this._nextPingReject;
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

        this.debug("forcefully closing socket");
        this.socket.close();

        this.onSocketClose("The user force closed the socket");
    }

    /**
     * Test if socket is connected to server.
     *
     * @return {Boolean} connected or not.
     */
    get connected() {
        return this.socket && this.socket.readyState === WebSocket.OPEN;
    }

    /**
     * Socket Event: "room.message.created" - Send (or create) a message to a room.
     *
     * @param  {Room}       room    The target room to recieve the message.
     * @param  {Message}    message The message to send.
     * @return {Promise<Object>}    The raw response frame returned from the server.
     */
    sendMessage(room, message) {
        return this.socketRequest("room.message.created", {
            roomId: room,
            body: message
        }).then(({ contents }) => contents);
    }

    /**
     * Update the currently logged in user's status.
     *
     * We can't wait for a response here because a response is only
     * returned if the user status *changes*.
     *
     * @param {String} status One of: "idle"|"active"
     */
    updateStatus(status) {
        if(!STATUS_TYPES.includes(status))
            throw new Error(`Status must be one of {${STATUS_TYPES.join(", ")}}. Invalid status: ${status}.`);

        return this.sendFrame("user.modified.status", { status })
    }

    /**
     * Get the unseen counts from the server.
     *
     * @return {Promise<Object>} Resolves to the unseen counts frame from the socket server.
     */
    getUnseenCount() {
        return this.sendFrame("unseen.counts.request").then(() => {
            return this.awaitFrame("unseen.counts.updated");
        });
    }

    /**
     * Clear a room's message history.
     *
     * @param  {Number} room          The room ID.
     * @param  {Number} beforeMessage The ID of a message that you want to clear messages BEFORE.
     * @return {Promise}              Resolves with the API response.
     */
    clearRoomHistory(room, beforeMessage) {
        return Promise.try(() => {
            return this.getRoom(room, { includeUsers: false });
        }).then(room => {
            if(room.type !== "pair") {
                throw new Error(`You cannot clear a non-pair room's history. Room ${room.id} is a ${room.type} room.`);
            }

            if(!beforeMessage) {
                return [this.getLatestMessageForRoom(room.id), room.id];
            } else {
                return [beforeMessage, room.id];
            }
        }).spread((beforeMessage, room) => {
            if(!beforeMessage) {
                // If there is no messages in the room, we simply return because it's
                // in a state (i.e. no messages), that the user expected.
                return;
            }

            if(typeof beforeMessage === "object") {
                beforeMessage = beforeMessage.id;
            }

            return this.request(`/chat/v2/conversations/${room}/user-settings.json`, {
                method: "PUT",
                body: {
                    userSettings: {
                        messageIdHistoryStartsAfter: beforeMessage
                    }
                }
            });
        });
    }

    /**
     * Get the latest message in a room.
     *
     * @param  {Number}          room The room ID.
     * @return {Promise<Object>}      The latest message.
     */
    getLatestMessageForRoom(room) {
        return this.getMessages(room, { pageSize: 1}).then(({ messages }) => messages[0]);
    }

    /**
     * Send the `room.user.active` frame for a room. This will resolve when we receive a
     * response from the server with the same contents sent. (I think we can come up with
     * a better name for this.)
     *
     * @param  {Number} room        The room ID to send the room active frame for.
     * @return {Promise<Object>}    Resolves to the response frame.
     */
    activateRoom(room, date) {
        const timestamp = (new Date()).toJSON();
        return this.sendFrame("room.user.active", {
            roomId: room,
            date: timestamp
        }).then(() => {
            return this.awaitFrame({
                type: "room.user.active",
                contents: {
                    date,
                    roomId: room,
                    activeAt: timestamp
                }
            });
        })
    }

    /**
     * Send the `room.typing` frame for a room. This frame awaits the reponse frame.
     *
     * @param  {Number}  room       The room ID.
     * @param  {Boolean} isTyping   Whether typing or not (default: true)
     * @return {Promise<Object>}    Resolves to the sent frame.
     */
    typing(room, isTyping = true) {
        return this.sendFrame("room.typing", {
            isTyping,
            roomId: room
        }).then(() => {
            return this.awaitFrame({
                type: "room.typing",
                contents: {
                    userId: this.user.id,
                    roomId: room,
                    isTyping
                }
            });
        });
    }

    /**
     * Send a ping frame to the server. This socket request times out after
     * PING_TIMEOUT and rejects the promise.
     *
     * @param  {Number}         timeout The timeout before the socket request times out. Default: PING_TIMEOUT
     * @return {Promise<Object>}        Resolves to the recieved ping frame.
     */
    ping(timeout = PING_TIMEOUT) {
        return this.socketRequest("ping", {}, timeout);
    }

    /**
     * Make an *unauthenticated* request to the Teamwork API.
     *
     * @param  {String}  target              The fully qualified URL to fetch.
     * @param  {Object}  options             See Fetch API `fetch` options.
     * @param  {Boolean} options.raw         Whether or not to return the raw response object.
     * @param  {Object}  options.query       An object that's stringified as the URL's query parameters (see `qs` module).
     * @return {Promise<Object|Response>}    Raw Response object or parsed JSON response.
     */
    static request(target, options = { raw: false }) {
        // Default to JSON stringify body.
        if(typeof options.body === "object") {
            options.body = JSON.stringify(options.body);
            options.headers = {
                ...options.headers,
                "Content-Type": "application/json"
            };
        }

        if(options.query && size(options.query)) {
            if(target.includes("?")) {
                throw new Error(
                    `URL target "${target}" already contains query elements. ` +
                    `Please use the query property of the options exclusively.`
                );
            }

            target += "?" + qs.stringify(omitBy(options.query, isUndefined));
        }

        debug(">>", green(options.method || "GET"), blue(target), options);
        return Promise.try(fetch.bind(null, target, options)).then(res => {
            debug(res.status, res.statusText);
            if(options.raw) return res;
            else {
                if(!res.ok) {
                    throw new HTTPError(res.status, res.statusText, res);
                }

                if(parseInt(res.headers.get("Content-Length")) === 0) {
                    // If the content length is explicitly zero, just return undefined and
                    // don't bother to parse the JSON.
                    return;
                }

                return res.json();
            }
        }).tap(data => {
            if(!options.raw) {
                debug("<<", blue(target), JSON.stringify(data, null, 2));
            }
        });
    }

    /**
     * Make an unauthenticated request for a list of items from the server with offset and limit.
     *
     * @param  {String}    target          The URL target. See APIClient.request.
     * @param  {Object}    options         The options object passed to APIClient.request.
     * @param  {Number}    options.offset  The cursor offset.
     * @param  {Number}    options.limit   The number of items to return after `offset`.
     * @return {Promise<Response|Object>}  See APIClient.request return value.
     */
    static requestList(target, { offset, limit, ...options } = {}) {
        return APIClient.request(target, {
            ...options,
            query: {
                ...options.query,
                page: omitBy({ offset, limit }, isUndefined)
            }
        });
    }

    /**
     * Make an *authenticated* request to the Teamwork API.
     *
     * @param  {String} path                The path part of the URL to be appended to the user installation for the request.
     * @param  {Object} options             See APIClient.request.
     * @return {Promise<Object|Response>}   See APIClient.request return value.
     */
    request(path, options = {}, requester = APIClient.request) {
        return requester(`${this.installation}${path}`, {
            ...options,
            headers: {
                ...options.headers,
                Cookie: `tw-auth=${this.auth}`
            }
        });
    }

    /**
     * Make an authenticated request for a list of items from the server with offset and limit.
     *
     * @param  {String}    target          The URL target. See APIClient.request.
     * @param  {Object}    options         The options object passed to APIClient.requestList.
     * @return {Promise<Response|Object>}  See APIClient.request return value.
     */
    requestList(path, options) {
        return this.request(path, options, APIClient.requestList);
    }

    /**
     * GET /chat/me.json - Return the currently logged in user's account.
     *
     * @return {Promise<Object>} User's account details. See Teamwork API Docs.
     */
    getProfile() {
        return this.request("/chat/me.json", {
            query: { includeAuth: true }
        });
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
    getPeople(filter = {}, offset, limit) {
        let query = [];

        if(filter.since) {
            query.push({
                updatedAfter: filter.since
            })
        }

        if(filter.search) {
            query.filter = {
                searchTerm: filter.search
            };
        }

        query = merge(...query);

        return this.requestList("/chat/v3/people.json", { offset, limit, query });
    }

    /**
     * GET /chat/people/<id>.json - Get a person by ID.
     *
     * @param  {Number}         id  The person's ID.
     * @return {Promise<Object>}    Person object response.
     */
    getPerson(id) {
        return this.request(`/chat/people/${id}.json`);
    }

    /**
     * Get a person by handle.
     *
     * @param  {String} handle   The user's handle.
     * @return {Promise<Object>} Resolves to the user if found.
     */
    getPersonByHandle(handle) {
        if(!handle) {
            throw new Error("Please supply a person's handle.");
        }

        return this.getPeople({ search: handle }).then(({ people }) => {
            const person = people.find(person => person.handle === handle);

            if(!person) {
                throw new Error(`Unable to find person ${handle} by handle.`);
            }

            return person;
        });
    }


    /**
     * PUT /chat/people/<id>.json - Update a persons details.
     *
     * @param  {Number}          id     The person's ID.
     * @param  {Object}          update The update object.
     * @return {Promise<Object>}        The API response object.
     */
    updatePerson(id, update) {
        return this.request(`/chat/people/${id}.json`, {
            method: "PUT",
            body: update
        });
    }

    /**
     * Update the currently logged in user's Handle.
     * @param  {String} handle   The new handle.
     * @return {Promise<Object>} Resolves when the request completes.
     */
    updateHandle(handle) {
        return this.request(`/chat/people/${this.user.id}.json`, {
            method: "PUT",
            body: {
                person: {
                    handle
                }
            }
        })
    }

    /**
     * POST /chat/rooms/:room/message.json - Create a new message via the API.
     *
     * This is different from `sendMessage` in that it creates the message via
     * a POST request to the API and not via the socket.
     * @param  {Number} room     The room ID.
     * @param  {String} message  The message body.
     * @return {Promise<Object>} Resolves with { "STATUS": "OK" } if successful.
     */
    createMessage(room, message) {
        return this.request(`/chat/rooms/${room}/messages.json`, {
            method: "POST",
            body: {
                message: {
                    body: message
                }
            }
        });
    }

    /**
     * DELETE /chat/rooms/:chat/messages.json - Delete muliple messages from a room.
     *
     * @param  {Number}          room      The room ID.
     * @param  {Array<Number>}   messages  Array of message IDs.
     * @return {Promise<Object>} Resolves when request is complete.
     */
    deleteMessages(room, messages) {
        return this.request(`/chat/rooms/${room}/messages.json`, {
            method: "DELETE",
            body: {
                ids: messages
            }
        });
    }

    /**
     * DELETE /chat/rooms/:chat/messages.json - Delete a message from a room.
     *
     * @param  {Number}  room    The room ID.
     * @param  {Number}  message Message ID.
     * @return {Promise<Object>} Resolves when request is complete.
     */
    deleteMessage(room, message) {
        return this.deleteMessages(room, [ message ]);
    }

    /**
     * PUT /chat/rooms/:chat/messages.json - Undelete ("undo message delete") a message from a room.
     *
     * @param  {Number}          room      The room ID.
     * @param  {Array<Number>}   messages  Array of message IDs.
     * @return {Promise<Object>} Resolves when request is complete.
     */
    undeleteMessages(room, messages) {
        return this.request(`/chat/rooms/${room}/messages.json`, {
            method: "PUT",
            body: {
                messages: messages.map(id => ({ id, status: "active"}))
            }
        });
    }

    /**
     * PUT /chat/rooms/:chat/messages.json - Undelete ("undo message delete") a message from a room.
     *
     * @param  {Number}  room    The room ID.
     * @param  {Number}  message Message ID.
     * @return {Promise<Object>} Resolves when request is complete.
     */
    undeleteMessage(room, message) {
        return this.undeleteMessages(room, [ message ])
    }

    /**
     * POST /chat/v2/rooms.json - Create a new room with handles and an initial message.
     *
     * @param  {Array<String>}  handles  Array of user handles (without `@` symbol).
     * @param  {String}         message  The initial message for the new room.
     * @return {Promise<Object>}         The server response with the room ID.
     */
    createRoom(handles, message) {
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
    deleteRoom(room) {
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
    updateRoomTitle(room, title) {
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
    getRoom(room, { includeUsers } = { includeUsers: true }) {
        return this.request(`/chat/v2/rooms/${room}.json`, {
            query: { includeUserData: includeUsers }
        }).then(({ room }) => room);
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
     * @param  {String}  filter.search              Search rooms by title.
     * @param  {Number}  offset                     The conversation cursor offset.
     * @param  {Number}  limit                      The number of conversations after the cursor to get.
     * @return {Promise<Array>}                     The list of conversations. See Teamwork API Docs.
     */
    getRooms(filter, offset = 0, limit = 10) {
        // Merge with defaults
        filter = {
            includeMessages: true,
            includeUsers: true,
            sort: "lastActivityAt",
            ...filter
        };

        // Map to the query object
        const query = {
            filter: {},
            includeUserData: filter.includeUsers,
            includeMessageData: filter.includeMessages,
            sort: filter.sort
        };

        if(filter.status) {
            query.filter.status = filter.status;
        }

        if(filter.since) {
            query.filter.activityAfter = filter.since;
        }

        if(filter.search) {
            query.filter.searchTerm = filter.search;
        }

        return this.requestList(`/chat/v3/conversations.json`, {
            offset, limit, query
        });
    }

    /**
     * Get a logged in user's messages (without room).
     *
     * Note: Unfortunately, this doesn't follow the other pagination schema so you're
     * on your own with regards to iterating the pages and the like.
     *
     * TODO: Move page and pageSize to options.
     *
     * @param  {Object} filter          Object containing filters.
     * @param  {String} filter.since    Timestamp to get message from now until `since`.
     * @param  {Number} page            The page number.
     * @param  {Number} pageSize        The amount of messages to return per page.
     * @return {Promise<Object>}        The messages from the API.
     */
    getUserMessages({ since }, page = 1, pageSize = 50) {
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
     * @param  {Number} room    The room ID.
     * @param  {Object} options          Options to configure the results return.
     * @param  {Object} options.page     Configure which page to return.
     * @param  {Object} options.pageSize Configure how many values are returned.
     * @return {Object}         The messages return from the API.
     */
    getMessages(room, filter) {
        const query = Object.assign({}, filter);

        return this.request(`/chat/v2/rooms/${room}/messages.json`, { query });
    }

    /**
     * PUT /people/<person>/impersonate.json - Impersonate a user.
     *
     * TODO: Move this to it's own Projects API Client Mixin.
     * TODO: Discuss this, ethically.
     *
     * @param  {Number}     person  The person's ID.
     * @param  {Boolean}    revert  Revert an ongoing impersonation. Don't use this however, use `unimpersonate`. The
     *                              logic for reverting the impersonation is so close to creating the impersonation,
     *                              it would be criminal to have a seperate request method. If this method is true
     *                              (default: false), the `person` parameter is unnecessary and should be `null`.
     * @return {Promise<String>}    Resolves to the user's `tw-auth` cookie.
     */
    impersonate(person, revert = false) {
        return this.request(`/people/${revert ? "" : person + "/"}impersonate${revert ? "/revert" : ""}.json`, {
            raw: true,
            method: "PUT"
        }).then(res => {
            if(res.ok) {
                return extractTWAuthCookie(res.headers.get("Set-Cookie"));
            } else throw new HTTPError(res.status, res.statusText, res);
        });
    }

    /**
     * Unimpersonate a user and refresh the auth token.
     * @return {Promise}  Resolves when the impersonation is complete.
     */
    unimpersonate() {
        return this.impersonate(null, true).then(auth => {
            // Update our auth token
            this.auth = auth;
        });
    }

    /**
     * DELETE /launchpad/v1/logout.json - Logout from Teamwork.
     *
     * @return {Promise<Object>} Value returned from server.
     */
    logout() {
        return this.request(`/launchpad/v1/logout.json`, { method: "DELETE" });
    }

    /**
     * GET authenticate.teamwork.com/launchpad/v1/accounts.json - Return a user's accounts.
     *
     * @param  {String} username    The user's username.
     * @param  {String} password    The user's password.
     * @return {Promise<Object>}    Returns list of user's accounts. See Teamwork API Docs.
     */
    static getAccounts(username, password) {
        return APIClient.request("http://authenticate.teamwork.com/launchpad/v1/accounts.json", {
            methods: "POST",
            body: {
                email: username,
                password
            }
        });
    }

    /**
     * POST <installation>/launchpad/v1/login.json - Login to Teamwork with credentials.
     *
     * @param  {String}  installation   The user's installation hostname.
     * @param  {String}  username       The user's username.
     * @param  {String}  password       The user's password.
     * @return {Promise<String>}        Resolves to the user's login token `tw-auth`.
     */
    static login(installation, username, password) {
        return APIClient.request(`${installation}/launchpad/v1/login.json`, {
            raw: true,
            method: "POST",
            body: {
                username, password,
                rememberMe: true
            }
        }).then(res => {
            if(res.ok) {
                // Extract the tw-auth cookie from the responses
                const twAuth = extractTWAuthCookie(res.headers.get("Set-Cookie"));

                debug(`Successfully logged in: tw-auth=${twAuth}`);
                return twAuth;
            } else {
                debug(`login failed: ${res.status}`);
                throw new Error(`Invalid login for ${username}@${installation}: ${res.status} ${res.statusText}`);
            }
        })
    }

    /**
     * Login and connect to the chat server.
     *
     * @param  {String|Object}  installation  The user's installation.
     * @param  {String}         username      The user's username.
     * @param  {String}         password      The user's password.
     * @param  {String}         socketServer  The socket server to target. Optional, defaults to env and config.json combo.
     * @return {Promise<APIClient>}          Resolves to a new instance of APIClient that can make authenticated requests
     *                                       as the user. The user's details can be access at `APIClient.user`.
     */
    static loginWithCredentials(installation, username, password, socketServer) {
        installation = APIClient.normalizeInstallation(installation);

        debug(`attempting to login with ${username} to ${installation}.`);
        return APIClient.login(installation, username, password).then(auth => {
            return (new APIClient(installation, auth, socketServer)).connect();
        });
    }

    /**
     * Login with a pre-existing auth key.
     *
     * @param  {String|Object}  installation  The user's installation.
     * @param  {String}         auth          The user's auth key (this will fail if the auth key is invalid or expired).
     * @param  {String}         socketServer  The socket server to target. Optional, defaults to env and config.json combo.
     * @return {Promise<APIClient>}           Resolves to a new instance of APIClient that can make authenticated requests
     *                                        as the user. The user's details can be access at `APIClient.user`.
     */
    static loginWithAuth(installation, auth, socketServer) {
        installation = APIClient.normalizeInstallation(installation);

        debug(`attempting to login with auth key "${auth}" to ${installation}`);
        const api = new APIClient(installation, auth, socketServer);

        return api.connect();
    }

    /**
     * Login with a Projects "API Key".
     *
     * @param  {String|Object}  installation  The user's installation.
     * @param  {String}         key           The "API Key".
     * @param  {String}         socketServer  The socket server to target. Optional, defaults to env and config.json combo.
     * @return {Promise<APIClient>}  Resolves to an authenticated APIClient instance.
     */
    static loginWithKey(installation, key, socketServer) {
        // This method of logging is caarrraaazzzzyyy.
        return APIClient.loginWithCredentials(installation, key, "club-lemon", socketServer);
    }

    /**
     * Login with an object that contains a combination of the following properties. It's essentially
     * a shortcut object for the `loginWith*` methods.
     *
     *  * "installation", "key" - The installation and user's API key.
     *  * "installation", "username", "password" - The installation and user's username and password.
     *  * "installation", "token" - The installation and user's API token.
     *
     * @param  {Object} details Object containing the above keys.
     * @return {Promise<APIClient>}  Resolves to an authenticated APIClient instance.
     */
    static from(details = {}) {
        if(!details.installation)
            throw new Error("Installation must be provided.");

        if(details.key) {
            return APIClient.loginWithKey(details.installation, details.key, details.socketServer);
        } else if(details.auth) {
            return APIClient.loginWithAuth(details.installation, details.auth, details.socketServer);
        } else if(details.username && details.password) {
            return APIClient.loginWithCredentials(details.installation, details.username, details.password, details.socketServer);
        } else {
            throw new Error("Unknown login details.");
        }
    }

    /**
     * Create a frame to send to the socket server.
     *
     * @param  {String}     type     The frame type or identifier.
     * @param  {Any}        contents The contents of the frame.
     * @param  {Boolean}    nonced   Whether or not to nonce the frame.
     * @return {Object}              The raw object packet to be stringified and sent to the server.
     */
    static createFrame(type, contents = {}, nonced = true) {
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
     *          "type"      {RegExp}    Match the frame name by regex.
     *          "nonce"     {Number}    Match the exact nonce of the frame.
     *          "contents"  {Object}    Match if "contents" is a subset of the frame's "contents".
     *
     *     Filters can also be specified in shorthand:
     *      - If the filter is a string e.g. `matchFrame("user.added")`, it is converted to a `{ type: <filter> }` object.
     *      - "*" matches all frames.
     *
     * @param  {Object|String}  fitlers     See "Filters" section above.
     * @param  {Object}         frame       The raw frame packet returned from the server.
     * @return {Boolean}                    Whether or not the filter matches the frame.
     */
    static matchFrame(filter, frame) {
        if(typeof filter === "string") {
            // Special case, "*" matches all frames
            if(filter === "*") {
                return true;
            }

            filter = { type: filter };
        }

        if(typeof filter !== "object") {
            throw new Error(`Invalid filter input: ${filter}`);
        }

        let matches = [];

        if(filter.type && typeof filter.type === "string") {
            matches.push(filter.type === frame.name);
        }

        if(filter.type && typeof filter.type instanceof RegExp) {
            matches.push(frame.name.match(filter.type));
        }

        if(filter.nonce) {
            matches.push(filter.nonce === frame.nonce);
        }

        if(filter.contents) {
            matches.push(isSubset(filter.contents, frame.contents));
        }

        if(!matches.length) {
            throw new Error("No filters specified in `matchFrame`. If you want to match all frames, listen for `frame` event.");
        }

        return matches.every(match => match);
    }

    static matchAnyFrame(filter, frames) {
        return frames.some(frame => APIClient.matchFrame(filter, frame));
    }

    /**
     * Convert an installation input (object or string) to a string.
     *
     * @param  {Object|String} installation The installation descriptor.
     * @return {String}                     The installation URL.
     */
    static normalizeInstallation(installation) {
        if(typeof installation === "object") {
            installation = url.format({
                protocol: "http:",
                ...installation
            });
        }

        // Remove any trailing slash
        return installation.replace(/\/$/, "");
    }

    /**
     * Custom `console.log` output.
     */
    inspect() {
        return `APIClient[authorized, auth=${this.auth}]`;
    }

    /**
     * Convert this instance to JSON (returns the data required to exactly recreate this instance).
     *
     * Example:
     *
     *      const { installation, auth } = chat.toJSON();
     *
     *      const newChat = new TeamworkChat(installation, auth);
     *
     *      newChat.connect().then(chat => {
     *          // Connected chat!
     *      });
     *
     * @return {Object} Serialized TeamworkChat.
     */
    toJSON() {
        return {
            auth: this.auth,
            installation: this.installation
        };
    }
}

export class HTTPError extends Error {
    constructor(statusCode, statusMessage, response) {
        super();
        this.name = this.constructor.name;
        this.message = `HTTPError: ${statusCode} ${statusMessage}`;
        this.statusCode = this.code = statusCode;
        this.statusMessage = statusMessage;
        this.response = response;
    }

    body() {
        return this.response.text();
    }
}

/**
 * Extract the TW Auth cookie from the cookie string.
 *
 * @private
 * @param  {String} cookie The returned cookie string from the API.
 * @return {String}        The `tw-auth` value.
 */
function extractTWAuthCookie(cookies) {
    const [ twAuthCookie ] = cookies.split(";");
    return twAuthCookie.split("=")[1];
}

/**
 * Determine if an input object is a subset of another object.
 * @param  {Object}  subset The subset.
 * @param  {Object}  target The object you expect `subset` to be a subset of.
 * @return {Boolean}        Whether or not a subset.
 */
export function isSubset(subset, target) {
    return Object.entries(subset).reduce((isSub, [ key, value ]) => {
        if(!isSub) {
            return false;
        }

        if(isPlainObject(value)) {
            return isSubset(value, target[key]);
        } else {
            return isEqual(value, target[key]);
        }
    }, true)
}