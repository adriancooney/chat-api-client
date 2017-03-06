// @flow
import CommonAPIClient, { AbstractAPIClient } from "./CommonAPIClient";
import ProjectsAPIClient from "./ProjectsAPIClient";
import ChatAPIClient from "./ChatAPIClient";
import DeskAPIClient from "./DeskAPIClient";

export default class TeamworkAPIClient extends AbstractAPIClient {
    /** @type {ProjectsAPIClient} The Projects API client. */
    projects: ProjectsAPIClient;

    /** @type {ChatAPIClient} The Chat API client. */
    chat: ChatAPIClient;

    /** @type {DeskAPIClient} The Desk API client. */
    desk: DeskAPIClient;

    constructor(client: CommonAPIClient) {
        super(client);

        this.projects = new ProjectsAPIClient(client);
        this.chat = new ChatAPIClient(client);
        this.desk = new DeskAPIClient(client);
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
    static fromCredentials(installation: string, username: string, password: string): Promise<TeamworkAPIClient> {
        return CommonAPIClient.fromCredentials(installation, username, password).then(client => new TeamworkAPIClient(client));
    }

    /**
     * Login with a pre-existing auth key.
     * 
     * @param  {String|Object}  installation  The user's installation.
     * @param  {String}         auth          The user's auth key (this will fail if the auth key is invalid or expired).
     * @return {Promise<APIClient>}           Resolves to a new instance of APIClient that can make authenticated requests
     *                                        as the user. The user's details can be access at `APIClient.user`.
     */
    static fromAuth(installation: string, auth: string): Promise<TeamworkAPIClient> {
        return CommonAPIClient.fromAuth(installation, auth).then(client => new TeamworkAPIClient(client));
    }

    /**
     * Login with a Projects "API Key".
     * 
     * @param  {String} installation The user's installation.
     * @param  {String} key          The "API Key".
     * @return {Promise<APIClient>}  Resolves to an authenticated APIClient instance.
     */
    static fromKey(installation:string, key: string): Promise<TeamworkAPIClient> {
        return CommonAPIClient.fromKey(installation, key).then(client => new TeamworkAPIClient(client));
    }
}