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
    omitBy,
    isEqual,
    isUndefined
} from "lodash";
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
     * Initialize (but not connect) the API account. This sets up all non-websocket related things.
     * 
     * @return {Object} User account returned from API.
     */
    initialize() {
         // Get the user's profile. If this fails, it means our token is invalid and the connection will fail.
        return this.getProfile().then(res => {
            // Save the logged in user's account to `user`;
            return this.user = res.account;
        });
    }

    /**
     * Connect to the Chat socket server.
     * 
     * @return {Promise<APIClient>} Resolves when the server has successfully completed authentication.
     */
    connect() {
        return this.initialize().then(user => {
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
                // and add replace it with `onSocketError` handler when the authentication flow completes.
                this.socket.on("error", reject);

                // The authentication flow.
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
    nextPing(attempt = 0) {
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
    getRooms(filter, offset = 0, limit = 10) {
        filter = {
            includeMessages: true,
            includeUsers: true,
            sort: "lastActivityAt",
            ...filter
        };

        const query = {
            includeUserData: filter.includeUsers,
            includeMessageData: filter.includeMessages,
            sort: "lastActivityAt"
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
     * @param  {Number} room The room ID.
     * @return {Object}      The messages return from the API.
     */
    getMessages(room) {
        return this.request(`/chat/v2/rooms/${room}/messages.json`);
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
                throw new Error(`Invalid login credentials for ${username}@${installation}.`);
            }
        })
    }

    /**
     * Login and connect to the chat server.
     * 
     * @param  {String|Object}  installation The user's installation.
     * @param  {String}         username     The user's username.
     * @param  {String}         password     The user's password.
     * @return {Promise<APIClient>}          Resolves to a new instance of APIClient that can make authenticated requests
     *                                       as the user. The user's details can be access at `APIClient.user`.
     */
    static loginWithCredentials(installation, username, password) {
        installation = APIClient.normalizeInstallation(installation);

        debug(`attempting to login with ${username} to ${installation}.`);
        return APIClient.login(installation, username, password).then(auth => {
            return (new APIClient(installation, auth)).connect();
        });
    }

    /**
     * Login with a pre-existing auth key.
     * 
     * @param  {String|Object}  installation  The user's installation.
     * @param  {String}         auth          The user's auth key (this will fail if the auth key is invalid or expired).
     * @return {Promise<APIClient>}           Resolves to a new instance of APIClient that can make authenticated requests
     *                                        as the user. The user's details can be access at `APIClient.user`.
     */
    static loginWithAuth(installation, auth) {
        installation = APIClient.normalizeInstallation(installation);

        debug(`attempting to login with auth key "${auth}" to ${installation}`);
        const api = new APIClient(installation, auth);

        return api.connect();
    }

    /**
     * Login with a Projects "API Key".
     * 
     * @param  {String} installation The user's installation.
     * @param  {String} key          The "API Key".
     * @return {Promise<APIClient>}  Resolves to an authenticated APIClient instance.
     */
    static loginWithKey(installation, key) {
        // This method of logging is caarrraaazzzzyyy.
        return APIClient.loginWithCredentials(installation, key, "club-lemon");
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

        if(!matches.length) {
            throw new Error("No filters specified in `matchFrame`. If you want to match all frames, listen for `frame` event.");
        }

        return matches.every(match => match);
    }

    /**
     * Conver an installation input (object or string) to a string.
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