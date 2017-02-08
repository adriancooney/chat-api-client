import url from "url";
import { inspect } from "util";
import { EventEmitter } from "events";
import createDebug from "debug";
import WebSocket from "ws";
import fetch from "isomorphic-fetch";
import Promise, { CancellationError, TimeoutError } from "bluebird";
import { green, blue } from "colors";
import { without, omit, isEqual } from "lodash";
import config from "../config.json";
import pkg from "../package.json";

const debug = createDebug("tw-chat:api");

/**
 * The time in ms between pings.
 * 
 * @type {Number}
 */
const PING_INTERVAL = 5000;

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
 * @type {Number}
 */
let NONCE = 0;

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
    constructor(installation, auth) {
        super();
        
        this.installation = installation;
        this.auth = auth;
    }

    /**
     * Send a raw object down the socket.
     * 
     * @param  {Object|String}          frame The object (will be serialized) or string.
     * @return {Promise<Object|String>}       The frame object (or string) sent.
     */
    send(frame) {
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
     * @param  {String} name        The type of the frame. See APICLient.createFrame.
     * @param  {Any}    contents    The contents of the frame.
     * @return {Promise<Object>}    Resolves the raw packet object sent down the line.
     */
    sendFrame(type, contents = {}) {
        return this.send(APIClient.createFrame(type, contents));
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
        debug(`socket request: ${type} (timeout = ${timeout})`, JSON.stringify(frame))
        return this.sendFrame(type, frame).then(packet => {
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
    onSocketError(error) {
        debug("socket error", error);
        this.emit("error", error);
    }

    /**
     * Event Handler: when the client's websocket emits "message"
     * 
     * @param  {String} message Raw frame string returned from server.
     */
    onSocketMessage(message) {
        debug("incoming frame", message);
        const frame = JSON.parse(message);

        if(this.awaiting.length) {
            this.awaiting.slice().forEach(filter => {
                if(APIClient.matchFrame(filter.filter, frame)) {
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
    connect() {
        return this.getProfile().then(res => {
            // Save the logged in user's account to `user`;
            this.user = res.account;

            return new Promise((resolve, reject) => {
                const { hostname } = url.parse(this.installation);
                const env = hostname.match(/teamwork.com/) ? "production" : "development"
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
                this.socket = new APIClient.WebSocket(socketServer, {
                    headers: {
                        Cookie: `tw-auth=${this.auth}`
                    }
                });

                this.socket.on("message", this.onSocketMessage.bind(this));

                // Attach the reject handler for the error handler, see below for when we remove it
                // and add the `onSocketError` handler instead when the authentication flow completes.
                this.socket.on("error", reject);

                this.socket.on("open", () => {
                    // Wait for the authentication request frame and send back the auth frame.
                    this.awaitFrame("authentication.request").then(message => {
                        return this.sendFrame("authentication.response", {
                            authKey: this.user.authkey,
                            userId: parseInt(this.user.id),
                            installationDomain: this.user.url,
                            installationId: parseInt(this.user.installationId),
                            clientVersion: pkg.version
                        });
                    }).then(() => {
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
    nextPing(attempt = 0) {
        return new Promise((resolve, reject) => {
            debug("attempting ping");

            // We save this so `stopPing` can forcefully stop the pinging.
            this._nextPingReject = reject;

            // God, this hurts my promises but it's the only nice way to do standardized cancellation.
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
            }).catch(err => this.emit.bind(this, "error"));
        }).then(() => {
            debug("ping succeeded");
            this.nextPing();
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
     * Send the `room.user.active` frame for a room.This frame has no response, it's fire and forget.
     * 
     * @param  {Number} room        The room ID to send the room active frame for.
     * @return {Promise<Object>}    Resolves to the sent frame.
     */
    activateRoom(room) {
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
    typing(isTyping, room) {
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
    ping(timeout = PING_TIMEOUT) {
        return this.socketRequest("ping", {}, timeout);
    }

    /**
     * Make an *unauthenticated* request to the Teamwork API.
     * 
     * @param  {String} target              The fully qualified URL to fetch.
     * @param  {Object} options             See Fetch API `fetch` options. Additional `raw` boolean 
     *                                      property to return raw Response object rather than object.
     * @return {Promise<Object|Response>}   Raw Response object or parsed JSON response. 
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

        debug(">>", green(options.method || "GET"), blue(target), options);
        return Promise.try(fetch.bind(null, target, options)).then(res => {
            debug(res.status, res.statusText);
            if(options.raw) return res;
            else {
                if(!res.ok) {
                    throw new HTTPError(res.status, res.statusText, res);
                }

                return res.json();
            }
        }).tap(data => {
            if(!options.raw)
                debug("<<", blue(target), data);
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
        let query = [];

        if(typeof offset !== "undefined") 
            query.push(`page%5Boffset%5D=${offset}`);

        if(typeof limit !== "undefined") 
            query.push(`page%5Blimit%5D=${limit}`);

        if(query.length) {
            query = query.join("&");
            target += target.includes("?") ? ("&" + query) : ("?" + query);
        }

        return APIClient.request(target, options)
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
        return this.request("/chat/me.json?includeAuth=true");
    }

    /**
     * GET /chat/v2/people.json - Return a list of people.
     * 
     * @param  {Number} offset    The cursor offset on the list of people.
     * @param  {Number} limit     The amount of people to return after the cursor offset.
     * @return {Promise<Object>}  The list of people.
     */
    getPeople(offset, limit) {
        return this.requestList("/chat/v2/people.json", { offset, limit });
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
     * GET /chat/v2/rooms/<room>.json - Get a room from the server.
     * 
     * @param  {Number}          room     The room ID.
     * @param  {Boolean}         userData Include user data or not.
     * @return {Promise<Object>}          Return a room object from the API.
     */
    getRoom(room, userData = true) {
        return this.request(`/chat/v2/rooms/${room}.json${userData ? "?includeUserData=true" : ""}`);
    }

    /**
     * GET /chat/v2/conversations.json - Return list of conversations.
     * 
     * @param  {Number} offset      The conversation cursor offset.
     * @param  {Number} limit       The number of conversations after the cursor to get.
     * @return {Promise<Array>}     The list of conversations. See Teamwork API Docs.
     */
    getRooms(offset = 0, limit = 15) {
        return this.requestList(`/chat/v2/conversations.json?includeMessageData=true&includeUserData=true` +
            `&sort=lastActivityAt`, { offset, limit });
    }

    /**
     * GET /chat/v2/rooms/<room>/messages.json - Get messages for a room.
     *  
     * @param  {Number} room The room ID.
     * @return {Object}      The messages return from the API.
     */
    getMessages(room) {
        return this.request(`/chat/v2/rooms/${room}/messages.json`);
    }

    /**
     * DELETE /launchpad/v1/login.json - Logout from Teamwork.
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
     * @param  {String}  installation   The user's installation hostname.
     * @param  {String}  username       The user's username.
     * @param  {String}  password       The user's password.
     * @param  {Boolean} raw            Resolve the raw response object or not. Default: true
     * @return {Promise<Response>}      Resolves to the raw response object.
     */
    static login(installation, username, password, raw = true) {
        return APIClient.request(`${installation}/launchpad/v1/login.json`, {
            raw,
            method: "POST",
            body: {
                username, password,
                rememberMe: true
            }
        });
    }

    /**
     * Login and connect to the chat server.
     * 
     * @param  {String|Object}  installation The user's installation hostname.
     * @param  {String}         username     The user's username.
     * @param  {String}         password     The user's password.
     * @return {Promise<APIClient>}          Resolves to a new instance of APIClient that can make authenticated requests
     *                                       as the user. The user's details can be access at `APIClient.user`.
     */
    static loginWithCredentials(installation, username, password) {
        if(typeof installation === "object") {
            installation = url.format({
                protocol: "http:",
                ...installation
            });
        }

        // Remove any trailing slash
        installation = installation.replace(/\/$/, "");

        debug(`attempting to login with ${username} at ${installation}.`);
        return APIClient.login(installation, username, password).then(res => {
            if(res.ok) {
                // Extract the tw-auth cookie from the responses
                const cookies = res.headers.get("Set-Cookie");
                const [ twAuthCookie ] = cookies.split(";");
                const twAuth = twAuthCookie.split("=")[1];
                debug(`Successfully logged in: tw-auth=${twAuth}`);

                return new APIClient(installation, twAuth);
            } else {
                debug(`login failed: ${res.status}`);
                throw new Error(`Invalid login credentials for ${username}@${installation}.`);
            }
        }).then(api => {
            return api.connect();
        });
    }

    /**
     * Create a frame to send to the socket server.
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
    static matchFrame(filter, frame) {
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

        return matches.every(match => match);
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
        super(`HTTPError: ${statusCode} ${statusMessage}`);
        this.statusCode = this.code = statusCode;
        this.statusMessage = statusMessage;
        this.response = response;
    }
}