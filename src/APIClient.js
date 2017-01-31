import url from "url";
import { inspect } from "util";
import { EventEmitter } from "events";
import Debug from "debug";
import WebSocket from "ws";
import Promise, { CancellationError } from "bluebird";
import fetch from "isomorphic-fetch";
import { without, omit, isEqual } from "lodash";
import config from "../config.json";
import pkg from "../package.json";

const debug = Debug("tw-chat:api");

/**
 * The global nonce counter. Scoped to this APIClient module only so
 * nothing outside can change it.
 * 
 * @type {Number}
 */
let NONCE = 0;

export default class APIClient extends EventEmitter {
    /**
     * The filters waiting to be matches to frames.
     * 
     * @type {Array<Object>}
     */
    awaiting = [];

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
     * Send a frame down the socket to the server.
     * 
     * @param  {String} name        The type of the frame. See APICLient.createFrame.
     * @param  {Any}    frame       The contents of the frame.
     * @return {Promise<Object>}    Resolves the raw packet object sent down the line.
     */
    sendFrame(type, frame) {
        debug("sending frame", type, frame);
        return Promise.try(() => {
            if(!this.connected) {
                throw new Error("Socket is not connected to the server. Please reconnect.");
            }

            frame = APIClient.createFrame(type, frame);
            this.socket.send(JSON.stringify(frame));
            return frame;
        });
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
        debug(`socket request: ${type}`, JSON.stringify(frame))
        return this.sendFrame(type, frame).then(packet => {
            debug(`socket response: `, JSON.stringify(packet));
            return this.awaitFrame({ nonce: packet.nonce }, timeout);
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
        debug("frame", message);
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
        this.emit("close");
    }

    /**
     * Connect to the Chat socket server.
     * @return {Promise} Resolves when the server has successfully completed authentication.
     */
    connect() {
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
            this.socket = new WebSocket(socketServer, {
                headers: {
                    Cookie: `tw-auth=${this.auth}`
                }
            });

            this.socket.on("message", this.onSocketMessage.bind(this));
            this.socket.on("error", this.onSocketError.bind(this));
            this.socket.on("close", this.onSocketClose.bind(this));

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

                    resolve(this.socket);
                }).catch(reject);
            });
        });
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

        debug(target, options);
        return Promise.try(fetch.bind(null, target, options)).then(res => {
            debug(res.status, res.statusText);
            if(options.raw) return res;
            else {
                if(!res.ok) {
                    throw new HTTPError(res.status, res.statusText, res);
                }

                return res.json();
            }
        });
    }

    static requestList(target, options = {}) {
        const offset = options.offset || 0;
        const limit = options.limit || 15;
        const query = `page%5Boffset%5D=${offset}&page%5Blimit%5D=${limit}`

        return APIClient.request(target + (target.includes("?") ? "&" + query : "?" + query), omit(options, "limit", "offset"))
    }

    /**
     * Make an *authenticated* request to the Teamwork API.
     *
     * @param  {String} path                The path part of the URL to be appended to the user installation for the request.
     * @param  {Object} options             See APIClient.request.
     * @return {Promise<Object|Response>}   See APIClient.request.
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

    getPeople(offset, limit) {
        return this.requestList("/chat/v2/people.json", { offset, limit });
    }

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

    getRoom(room) {
        return this.request(`/chat/v2/rooms/${room}.json?includeUserData=true`);
    }

    getMessages(room) {
        return this.request(`/chat/v2/rooms/${room}/messages.json`);
    }

    /**
     * GET /chat/v2/conversations.json - Return list of conversations.
     * 
     * @param  {Number} offset      The conversation cursor offset.
     * @param  {Number} limit       The number of conversations after the cursor to get.
     * @return {Promise<Array>}     The list of conversations. See Teamwork API Docs.
     */
    getRooms(offset, limit) {
        return this.requestList(`/chat/v2/conversations.json?includeMessageData=true&includeUserData=true` +
            `&sort=lastActivityAt`, { offset, limit });
    }

    /**
     * GET /launchpad/v1/accounts.json (authenticate.teamwork.com) - Return a user's accounts.
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
     * POST /launchpad/v1/login.json - Login and connect to the chat server.
     * 
     * @param  {String} installation The user's installation hostname.
     * @param  {String} username     The user's username.
     * @param  {String} password     The user's password.
     * @return {Promise<APIClient>}  Resolves to a new instance of APIClient that can make authenticated requests
     *                               as the user. The user's details can be access at `APIClient.user`.
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
        return APIClient.request(`${installation}/launchpad/v1/login.json`, {
            raw: true,
            method: "POST",
            body: {
                username, password,
                rememberMe: true
            }
        }).then(res => {
            if(res.status === 200) {
                // Extract the tw-auth cookie from the responses
                const cookies = res.headers.get("Set-Cookie");
                const [ twAuthCookie ] = cookies.split(";");
                const twAuth = twAuthCookie.split("=")[1];
                debug(`Successfully logged in: tw-auth=${twAuth}`);

                return new APIClient(installation, twAuth);
            } else {
                debug(`login failed: ${res.status}`);
                throw new Error(`Invalid login credentials for ${username}@${this.format(installation)}.`);
            }
        }).then(api => {
            return [api, api.getProfile()];
        }).spread((api, res) => {
            api.user = res.account;

            return [api, api.connect()];
        }).spread(api => {
            return api;
        });
    }

    /**
     * Create a frame to send to the socket server.
     * @param  {String}     type     The frame type or identifier.
     * @param  {Any}        contents The contents of the frame.
     * @param  {Boolean}    nonced   Whether or not to nonce the frame.
     * @return {Object}              The raw object packet to be stringified and sent to the server.
     */
    static createFrame(type, contents, nonced = true) {
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