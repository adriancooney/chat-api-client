import { inspect } from "util";
import url from "url";
import { EventEmitter } from "events";
import WebSocket from "ws";
import Promise from "bluebird";
import fetch from "isomorphic-fetch";
import Debug from "debug";
import { pull } from "lodash";
import pkg from "../package.json";

const debug = Debug("tw-chat:api");

export default class APIClient extends EventEmitter {
    constructor(installation, auth) {
        super();
        
        this.installation = installation;
        this.auth = auth;

        this.awaiting = [];
    }

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

    sendFrame(name, frame) {
        debug("sending frame", name, frame);
        return Promise.try(() => {
            this.socket.send(JSON.stringify(APIClient.createFrame(name, frame)));
        });
    }

    awaitFrame(filter, timeout = 30000) {
        return new Promise(resolve => {
            this.awaiting.push(filter = {
                filter, resolve
            });
        }).timeout(timeout).finally(() => {
            this.awaiting = pull(this.awaiting, filter);
        });
    }

    raceFrames(...filters) {
        return Promise.any(filters.map(filter => this.awaitFrame(filter)));
    }

    onSocketError(error) {
        debug("socket error", error);
        this.emit("error", error);
    }

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

    onSocketClose() {
        debug("socket closed");
        this.emit("close");
    }

    isConnected() {
        return this.socket && this.socket.readyState === WebSocket.OPEN;
    }

    request(path, options = {}) {
        return APIClient.request(`${url.format(this.installation)}${path}`, {
            ...options,
            headers: {
                ...options.headers,
                Cookie: `tw-auth=${this.auth}`
            }
        });
    }

    getProfile() {
        return this.request("/chat/me.json?includeAuth=true");
    }

    getRooms(offset = 0, limit = 15) {
        return this.request(`/chat/v2/conversations.json?includeMessageData=true&includeUserData=true` +
            `&sort=lastActivityAt&page%5Boffset%5D=${offset}&page%5Blimit%5D=${limit}`);
    }

    sendMessage(room, message) {
        this.sendFrame("room.message.created", {
            roomId: room.id,
            body: message.content
        });
    }

    static request(target, options = {}, raw = false) {
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

    static getAccounts(username, password) {
        return APIClient.request("http://authenticate.teamwork.com/launchpad/v1/accounts.json", {
            methods: "POST",
            body: {
                email: username,
                password
            }
        });
    }

    static loginWithCredentials(installation, username, password) {
        debug(`attempting to login with ${username} at ${installation}.`);
        return APIClient.request(`${url.format(installation)}/launchpad/v1/login.json`, {
            method: "POST",
            body: {
                username, password,
                rememberMe: true
            }
        }, true).then(res => {
            if(res.status === 200) {
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

            console.log(api.user);

            return [api, api.connect()];
        }).spread(api => {
            return api;
        });
    }

    static nonce = 0;
    static createFrame(name, contents, nonced = true) {
        return {
            contentType: "object",
            source: {
                name: "Teamwork Chat Node API",
                version: pkg.version
            },
            nonce: nonced ? ++APIClient.nonce : null,
            contents, name
        }
    }

    static matchFrame(filter, frame) {
        if(typeof filter === "string")
            filter = { name: filter };

        if(filter.name && typeof filter.name === "string") {
            return filter.name === frame.name;
        } else return false;
    }

    [inspect.custom]() {
        return "APIClient[authorized]";
    }
}