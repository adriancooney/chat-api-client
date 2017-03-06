// @flow
import url from "url";
import qs from "qs";
import events from "events";
import createDebug from "debug";
import fetch from "node-fetch";
import Promise from "bluebird";
import { green, blue } from "colors";
import { 
    size,
    omitBy,
    isUndefined
} from "lodash";

const debug = createDebug("tw-chat:api");

type RequestOptions = {
    raw?: boolean,
    body?: Object|string,
    headers?: Object,
    query?: Object
};

type RequestListOptions = {
    limit?: number,
    offset?: number
} & RequestOptions;

type UserObject = {
    id: number,
    installationId: number,
    authkey: string,
    url: string
};

export default class CommonAPIClient {
    /**
     * The current logged in user's account details returned from #getProfile.
     * 
     * @type {Object}
     */
    user: UserObject;

    /** @type {String} The projects installation to communicate with. */
    installation: string;

    /** @type {String} The `tw-auth` cookie to communicate with. */
    auth: string;

    /**
     * Create an authorized APIClient object.
     * 
     * @param  {String} installation The user's installation.
     * @param  {String} auth         The `tw-auth` token.
     * @return {APIClient}           The authorized APIClient instance.
     */
    constructor(installation: string, auth: string) {
        this.installation = installation;
        this.auth = auth;
    }

    /**
     * Initialize (but not connect) the API account. This sets up all non-websocket related things.
     * 
     * @return {Object} User account returned from API.
     */
    initialize(): Promise<CommonAPIClient> {
         // Get the user's profile. If this fails, it means our token is invalid and the connection will fail.
        return this.getProfile().then(res => {
            // Save the logged in user's account to `user`;
            this.user = res.account;

            return this;
        });
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
    static request(target: string, options?: RequestOptions = { raw: false }): Promise<Response|Object> {
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
    static requestList(target: string, opts?: RequestListOptions = {}): Promise<Response|Object> {
        const { offset, limit, query, ...options } = opts;
        return CommonAPIClient.request(target, {
            ...options,
            query: { 
                ...query,
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
    request(path: string, options?: RequestOptions = {}, requester: Function = CommonAPIClient.request): Promise<Response|Object> {
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
    requestList(path: string, options?: RequestOptions): Promise<Response|Object> {
        return this.request(path, options, CommonAPIClient.requestList);
    }

    /**
     * GET /chat/me.json - Return the currently logged in user's account.
     * 
     * @return {Promise<Object>} User's account details. See Teamwork API Docs.
     */
    getProfile(): Promise<Object> {
        return this.request("/chat/me.json", { 
            query: { includeAuth: true } 
        });
    }

    /**
     * DELETE /launchpad/v1/logout.json - Logout from Teamwork.
     * 
     * @return {Promise<Object>} Value returned from server.
     */
    logout(): Promise {
        return this.request(`/launchpad/v1/logout.json`, { method: "DELETE" });
    }

    /**
     * GET authenticate.teamwork.com/launchpad/v1/accounts.json - Return a user's accounts.
     * 
     * @param  {String} username    The user's username.
     * @param  {String} password    The user's password.
     * @return {Promise<Object>}    Returns list of user's accounts. See Teamwork API Docs.
     */
    static getAccounts(username: string, password: string): Promise<CommonAPIClient> {
        return CommonAPIClient.request("http://authenticate.teamwork.com/launchpad/v1/accounts.json", {
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
    static login(installation: string, username: string, password: string): Promise<CommonAPIClient> {
        return CommonAPIClient.request(`${installation}/launchpad/v1/login.json`, {
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
    static fromCredentials(installation: string, username: string, password: string): Promise<CommonAPIClient> {
        installation = CommonAPIClient.normalizeInstallation(installation);

        debug(`attempting to login with ${username} to ${installation}.`);
        return CommonAPIClient.login(installation, username, password).then(auth => {
            return (new CommonAPIClient(installation, auth)).initialize();
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
    static fromAuth(installation: string, auth: string): Promise<CommonAPIClient> {
        installation = CommonAPIClient.normalizeInstallation(installation);

        debug(`attempting to login with auth key "${auth}" to ${installation}`);
        const api = new CommonAPIClient(installation, auth);

        return api.initialize();
    }

    /**
     * Login with a Projects "API Key".
     * 
     * @param  {String} installation The user's installation.
     * @param  {String} key          The "API Key".
     * @return {Promise<APIClient>}  Resolves to an authenticated APIClient instance.
     */
    static fromKey(installation:string, key: string): Promise<CommonAPIClient> {
        // This method of logging is caarrraaazzzzyyy.
        return CommonAPIClient.fromCredentials(installation, key, "club-lemon");
    }

    /**
     * Convert an installation input (object or string) to a string.
     * 
     * @param  {Object|String} installation The installation descriptor.
     * @return {String}                     The installation URL.
     */
    static normalizeInstallation(installation: string|Object): string {
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
    inspect(): string {
        return `CommonAPIClient[authorized, auth=${this.auth}]`;
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
    toJSON(): Object {
        return {
            auth: this.auth,
            installation: this.installation
        };
    }
}

export class AbstractAPIClient extends events.EventEmitter {
    /** @type {CommonAPIClient} The common API Client. */
    client: CommonAPIClient;

    constructor(client: CommonAPIClient) {
        super();

        this.client = client;
    }

    request(target: string, options?: RequestOptions): Promise<Response|Object> {
        return this.client.request(target, options);
    }

    requestList(target: string, options?: RequestListOptions) {
        return this.client.requestList(target, options);
    }

    initialize(): Promise<Object> {
        return this.client.initialize();
    }

    /**
     * Convert this instance to JSON (returns the data required to exactly recreate this instance).
     *      
     * @return {Object} Serialized Client.
     */
    toJSON(): Object {
        return {
            client: this.client
        };
    }
}

export class HTTPError extends Error {
    /** @type {Number} Status code, shortcut for `statusMessage`. */
    code: number;

    /** @type {Number} The HTTP Repsonse code. */
    statusCode: number;

    /** @type {String} The HTTP response message. */
    statusMessage: string;

    /** @type {Response} The offending response. */
    response: Response;

    constructor(statusCode: number, statusMessage: string, response: Response) {
        super();
        this.name = this.constructor.name;
        this.message = `HTTPError: ${statusCode} ${statusMessage}`;
        this.statusCode = this.code = statusCode;
        this.statusMessage = statusMessage;
        this.response = response;
    }

    body(): Promise<string> {
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
export function extractTWAuthCookie(cookies: string): string {
    const [ twAuthCookie ] = cookies.split(";");
    return twAuthCookie.split("=")[1];
}