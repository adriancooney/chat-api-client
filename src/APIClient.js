import url from "url";
import { inspect } from "util";
import { EventEmitter } from "events";
import Debug from "debug";
import WebSocket from "ws";
import Promise from "bluebird";
import fetch from "isomorphic-fetch";
import { pull } from "lodash";
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
        return new Promise(resolve => {
            this.awaiting.push(filter = {
                filter, resolve
            });
        }).timeout(timeout, `Awaiting frame ${JSON.stringify(filter)} has timed out.`).finally(() => {
            this.awaiting = pull(this.awaiting, filter);
        });
    }

    /**
     * Await multiple packets and pick (resolve) the first.
     * 
     * @param  {...Object} filters  Filters applied to APIClient#awaitFrame.
     * @return {Promise<Object>}    Resolves to the raw object packet returned from the server.
     */
    raceFrames(...filters) {
        return Promise.any(filters.map(filter => this.awaitFrame(filter)));
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
        return this.sendFrame(type, frame).then(packet => {
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
            const socketServer = url.format({
                ...this.installation,
                protocol: "ws:",
                slashes: true,
                port: "8181"
            });

            debug(`connecting socket server to ${socketServer}`);
            this.socket = new WebSocket(socketServer, {
                headers: {
                    Cookie: `tw-auth=${this.auth}`
                }
            });

            this.socket.on("message", this.onSocketMessage.bind(this));
            this.socket.on("error", this.onSocketError.bind(this));

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

                    resolve();
                }).catch(reject);
            });
        });
    }

    /**
     * Test if socket is connected to server.
     * 
     * @return {Boolean} connected or not.
     */
    isConnected() {
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
            roomId: room.id,
            body: message.content
        });
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
            if(raw) return res;
            else return res.json();
        });
    }

    /**
     * Make an *authenticated* request to the Teamwork API.
     *
     * @param  {String} path                The path part of the URL to be appended to the user installation for the request.
     * @param  {Object} options             See APIClient.request.
     * @return {Promise<Object|Response>}   See APIClient.request.
     */
    request(path, options = {}) {
        return APIClient.request(`${url.format(this.installation)}${path}`, {
            ...options,
            headers: {
                ...options.headers,
                Cookie: `tw-auth=${this.auth}`
            }
        });
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
     * GET /chat/v2/conversations.json - Return list of conversations.
     * 
     * @param  {Number} offset      The conversation cursor offset.
     * @param  {Number} limit       The number of conversations after the cursor to get.
     * @return {Promise<Array>}     The list of conversations. See Teamwork API Docs.
     */
    getRooms(offset = 0, limit = 15) {
        return this.request(`/chat/v2/conversations.json?includeMessageData=true&includeUserData=true` +
            `&sort=lastActivityAt&page%5Boffset%5D=${offset}&page%5Blimit%5D=${limit}`);
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
        debug(`attempting to login with ${username} at ${installation}.`);
        return APIClient.request(`${url.format(installation)}/launchpad/v1/login.json`, {
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
     *          "type"  {String}    Match the exact frame type.
     *          "nonce" {Number}    Match the exact nonce of the frame.
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

        if(filter.type && typeof filter.type === "string") {
            return filter.type === frame.name;
        } else if(filter.nonce) {
            return filter.nonce === frame.nonce;
        } else return false;
    }

    /**
     * Custom `console.log` output.
     */
    [inspect.custom]() {
        return `APIClient[authorized, auth=${this.auth}]`;
    }
}