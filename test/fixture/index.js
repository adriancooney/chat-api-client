import { EventEmitter } from "events";
import Promise from "bluebird";
import createDebug from "debug";
import LocalWebSocket from "./LocalWebSocket";
import TeamworkChat from "../../src/TeamworkChat";
import APIClient from "../../src/APIClient";

const debug = createDebug("tw-chat:test");

export const INSTALLATION = {
    protocol: "http:",
    hostname: "sunbeam.teamwork.dev",
    port: 5000
};

export const USERNAME = "donalin+dev1@gmail.com";
export const PASSWORD = "test";

export const devAPIClient = APIClient.loginWithCredentials.bind(null, INSTALLATION, USERNAME, PASSWORD);
export const devTeamworkChat = TeamworkChat.fromCredentials.bind(null, INSTALLATION, USERNAME, PASSWORD);

export function expectRequest(matcher, responseValue = {}) {
    const _request = APIClient.request;

    APIClient.request = (path, options) => {
        const match = matcher.exec(path);

        if(match) {
            return Promise.resolve(typeof responseValue === "function" ? responseValue(...match) : responseValue);
        } else {
            throw new Error(`Requet API Test: Request does not match: ${matcher}.match(${path})`);
        }
    };

    return () => APIClient.request = _request;
};

export function localAPIClient() {
    const _webSocket = APIClient.WebSocket;
    APIClient.WebSocket = LocalWebSocket;

    const api = new APIClient("http://local", "local-auth");

    api.user = {
        ...createPerson(),
        user: createPerson()
    };

    const restore = expectRequest(/me.json/, { account: createUser() });

    return api.connect().then(() => {
        APIClient.WebSocket = _webSocket;
        
        restore();

        return api;
    });
};

export function localTeamworkChat() {
    return localAPIClient().then(api => {
        return new TeamworkChat(api, api.user);
    });
};

export function createFrame(name, contents) {
    return {
        name, contents,
        contentType: "object"
    };
}

export function createMessageFrame(overrides) {
    return createFrame("room.message.created", Object.assign({
        "id": 52,
        "body": "howya lad",
        "installationId": 1,
        "roomId": 1,
        "userId": 1,
        "type": "message",
        "editedAt": null,
        "createdAt": "2017-01-29T18:06:34.640Z",
        "containsSnippet": 0,
        "containsLink": 0,
        "file": {},
        "shard": 6
    }, overrides));
}

export function createPerson(overrides) {
    return Object.assign({
        "lastActivityAt": "2017-01-29T19:18:25.000Z",
        "id": 1,
        "firstName": "Developers",
        "lastName": "Guy",
        "title": "",
        "email": "donalin+dev1@gmail.com",
        "updatedAt": "2017-01-26T15:37:50.000Z",
        "handle": "developers",
        "status": "online",
        "deleted": false,
        "roomId": null,
        "isCurrentUserAllowedToChatDirectly": true,
        "company": {
            "id": 1,
            "name": "Teamwork"
        }
    }, overrides);
}

export function createUser(overrides) {
    return Object.assign({
        region: "US",
        company: createCompany(),
        ownerCompany: createCompany(),
        user: createPerson(),
        avatarUrl: "https://s3.amazonaws.com/TWFiles/1/users/u139099/01931E53F44CE20300D30997BCD129AA.jpg",
        settings: { emailNotifications: "always" },
        firstName: "Adrian",
        lastName: "Cooney",
        id: "139099",
        authkey: "YUcAR6im0R0G5K18if5CpYvbJ8fqaK-139099",
        companyId: "1",
        counts: { unread: "225", importantUnread: "1" },
        baseHref: "https://digitalcrew.teamwork.com/",
        url: "https://digitalcrew.teamwork.com/",
        isAdmin: false,
        isDeskEnabled: true,
        isProjectsEnabled: true,
        isChatEnabled: true,
        canManagePeople: false,
        apiKey: "dublin254sun",
        installationName: "Teamwork.com Projects",
        installationId: "1"
    }, overrides);
}

export function createCompany(overrides) {
    return Object.assign({
        name: "Teamwork.com",
        status: "active",
        usersCount: "82",
        accessLevel: "owner",
        id: "1",
        logoUrl: "https://tw-s3.teamworkpm.net/sites/digitalcrew/images/companies/1/logo/TWFiles/1/companies/c1/1486741738557_C39537F2A04435D74420E91C0258546E.png" 
    }, overrides);
} 

export function createRoom(overrides) {
    return Object.assign({
        "id": 5,
        "title": null,
        "status": "active",
        "lastActivityAt": "2017-01-29T19:18:25.000Z",
        "lastViewedAt": "2017-01-29T19:18:23.000Z",
        "updatedAt": "2017-01-29T19:18:23.000Z",
        "creatorId": 1,
        "createdAt": "2017-01-29T19:18:23.000Z",
        "type": "private",
        "people": [ createPerson() ]
    }, overrides);
}